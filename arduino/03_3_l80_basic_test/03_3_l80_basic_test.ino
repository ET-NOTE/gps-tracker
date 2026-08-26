// 03_3 — L80 / L80-R GPS 모듈 단독 living-check (실내 OK)  [rev 2026-07-30]
//
// 목적: 모듈이 UART 로 NMEA 스트림 뱉고 있는지 확인 + 외부 안테나 상태 감지.
//   - 실내에서 fix 는 안 나도, NMEA 라인 1개라도 들어오면 UART OK.
//   - 외부 안테나 감지: L80 (MT3339) 은 $PGCMD,33 / $PGTOP,11 advisor 사용.
//     L80-R (MT3333) 은 이 advisor 를 안 먹는 경우가 있어 폴백 명령까지 시도.
//     둘 다 실패하면 "advisor 미지원 모듈" 로 확정 표시.
//
// 핀: PWR_EN=GPIO6 (LOW=ON, LTE 와 공유), RX=GPIO20, TX=GPIO21, baud 9600.

#include <HardwareSerial.h>

#define PIN_PWR_EN  6
#define PIN_GPS_RX 20
#define PIN_GPS_TX 21
#define GPS_BAUD   9600UL

HardwareSerial gpsSerial(1);

// ── 통계 ──────────────────────────────────────────────────────────────
uint32_t totalBytes = 0;
uint32_t totalLines = 0;
uint32_t cntGGA = 0, cntRMC = 0, cntGSA = 0, cntGSV = 0, cntVTG = 0, cntGLL = 0, cntOther = 0;
uint32_t lastByteMs = 0;

// ── 라인 버퍼 ─────────────────────────────────────────────────────────
char line[200];
uint16_t lineLen = 0;

// ── NMEA 파생 상태 ────────────────────────────────────────────────────
int  lastFix       = -1;
int  lastSatsUsed  = -1;
int  lastSatsView  = -1;
int  lastGsaMode   = -1;
char lastRmcStat   = 0;
char lastRmcTime[12] = {0};
bool haveFix       = false;

// ── 안테나 advisor 상태 ────────────────────────────────────────────────
// lastAntennaMode: 0=미보고, 1=SHORT, 2=내부 patch, 3=외부 active
int      lastAntennaMode = 0;
uint32_t antennaLastMs   = 0;

// advisor 지원 여부 확정 (L80 vs L80-R 폴백용)
enum AntSupport { ANT_UNKNOWN = 0, ANT_SUPPORTED = 1, ANT_UNSUPPORTED = 2 };
AntSupport antennaSupport = ANT_UNKNOWN;

// 폴백 시도 상태머신
enum AdvisorProbeStage {
  PROBE_WAIT_NMEA = 0,   // GGA 2개 이상 받을 때까지 대기
  PROBE_SEND_PGCMD,      // L80 계열 $PGCMD,33,1 시도
  PROBE_WAIT_PGCMD,      // $PGTOP 응답 대기
  PROBE_SEND_PMTK,       // 폴백: $PMTK514 (NMEA output query, MT3333 계열 응답 확인용)
  PROBE_WAIT_PMTK,
  PROBE_RETRY_PGCMD,     // 마지막으로 한 번 더 $PGCMD 재시도
  PROBE_DONE_UNSUPPORTED, // 다 실패 → advisor 미지원 확정
  PROBE_DONE_SUPPORTED    // $PGTOP 최소 1회 수신 → 지원 확정
};
AdvisorProbeStage probeStage = PROBE_WAIT_NMEA;
uint32_t probeStageEnteredMs = 0;
uint8_t  probeAttempts = 0;

// PMTK 응답 (예: $PMTK001,514,3*36) 수신 여부 — 이건 모듈이 살아있고 PMTK 를 이해한다는 증거
bool     sawPmtkAck = false;

// ── 유틸 ──────────────────────────────────────────────────────────────
static void getField(const char* l, int idx, char* out, size_t outsz) {
  size_t i = 0, fi = 0, oi = 0;
  while (l[i] && fi < (size_t)idx) {
    if (l[i] == ',') fi++;
    i++;
  }
  while (l[i] && l[i] != ',' && l[i] != '*' && oi + 1 < outsz) {
    out[oi++] = l[i++];
  }
  out[oi] = 0;
}

// NMEA 체크섬 계산 (지원되지 않는 명령을 커스텀으로 짤 때 참고용)
static uint8_t nmeaChecksum(const char* body) {
  uint8_t c = 0;
  for (const char* p = body; *p; ++p) c ^= (uint8_t)*p;
  return c;
}

// 명령 전송 헬퍼 — MTK 계열은 <CR><LF> 요구. println (\r\n) 대신 명시적으로 print.
static void sendNmeaCmd(const char* fullSentenceWithChecksum) {
  gpsSerial.print(fullSentenceWithChecksum);
  gpsSerial.print("\r\n");
  Serial.printf("[ANT>] TX: %s\n", fullSentenceWithChecksum);
}

// ── NMEA 파서 ─────────────────────────────────────────────────────────
static const char* parseAndDiagnose(const char* l) {
  char f[16];

  if (strncmp(l, "$GPGGA", 6) == 0) {
    cntGGA++;
    getField(l, 6, f, sizeof(f)); lastFix      = (f[0] ? atoi(f) : 0);
    getField(l, 7, f, sizeof(f)); lastSatsUsed = (f[0] ? atoi(f) : 0);
    haveFix = (lastFix >= 1);
    static char tag[128];
    if (lastFix == 0)      snprintf(tag, sizeof(tag), "  ❌ GGA: fix 없음 (사용 위성 %d)", lastSatsUsed);
    else if (lastFix == 1) snprintf(tag, sizeof(tag), "  ✅ GGA: GPS fix (사용 위성 %d)", lastSatsUsed);
    else                   snprintf(tag, sizeof(tag), "  ✅ GGA: fix=%d (사용 위성 %d)", lastFix, lastSatsUsed);
    return tag;
  }
  if (strncmp(l, "$GPRMC", 6) == 0) {
    cntRMC++;
    getField(l, 1, f, sizeof(f)); strncpy(lastRmcTime, f, sizeof(lastRmcTime)-1);
    getField(l, 2, f, sizeof(f)); lastRmcStat = f[0] ? f[0] : '?';
    static char tag[128];
    if (lastRmcStat == 'A')      snprintf(tag, sizeof(tag), "  ✅ RMC: 시각 유효 (A)");
    else if (lastRmcStat == 'V') snprintf(tag, sizeof(tag), "  ⚠️  RMC: 시각 무효 (V, fix 안 됨)");
    else                         snprintf(tag, sizeof(tag), "  ?  RMC: status=%c", lastRmcStat);
    return tag;
  }
  if (strncmp(l, "$GPGSA", 6) == 0) {
    cntGSA++;
    getField(l, 2, f, sizeof(f)); lastGsaMode = (f[0] ? atoi(f) : 0);
    static char tag[128];
    if (lastGsaMode == 1)      snprintf(tag, sizeof(tag), "  ❌ GSA: fix 없음 (mode 1)");
    else if (lastGsaMode == 2) snprintf(tag, sizeof(tag), "  ✅ GSA: 2D fix (mode 2)");
    else if (lastGsaMode == 3) snprintf(tag, sizeof(tag), "  ✅ GSA: 3D fix (mode 3)");
    else                       snprintf(tag, sizeof(tag), "  ?  GSA: mode=%d", lastGsaMode);
    return tag;
  }
  if (strncmp(l, "$GPGSV", 6) == 0) {
    cntGSV++;
    getField(l, 3, f, sizeof(f)); lastSatsView = (f[0] ? atoi(f) : 0);
    static char tag[128];
    if (lastSatsView == 0)      snprintf(tag, sizeof(tag), "  ⚠️  GSV: 시야 위성 0개 (실내 정상 / 야외라면 안테나 점검)");
    else if (lastSatsView < 4)  snprintf(tag, sizeof(tag), "  🛰 GSV: 시야 위성 %d개 (fix 부족, 4+ 필요)", lastSatsView);
    else                        snprintf(tag, sizeof(tag), "  ✅ GSV: 시야 위성 %d개 (안테나 OK)", lastSatsView);
    return tag;
  }
  if (strncmp(l, "$GPVTG", 6) == 0) { cntVTG++; return "  · VTG: 속도/방향 (fix 시 의미)"; }
  if (strncmp(l, "$GPGLL", 6) == 0) { cntGLL++; return "  · GLL: 위경도 (fix 시 의미)"; }

  // 안테나 advisor 응답 — L80 (MT3339)
  //   $PGTOP,11,<mode>*hh    mode: 1=SHORT / 2=내부 patch / 3=외부 active
  if (strncmp(l, "$PGTOP,11,", 10) == 0) {
    lastAntennaMode = atoi(l + 10);
    antennaLastMs = millis();
    antennaSupport = ANT_SUPPORTED;
    probeStage = PROBE_DONE_SUPPORTED;
    static char tag[128];
    if      (lastAntennaMode == 1) snprintf(tag, sizeof(tag), "  ❌ 안테나: SHORT (배선/커넥터 단락)");
    else if (lastAntennaMode == 2) snprintf(tag, sizeof(tag), "  ⚠️  안테나: 내부 patch 사용 중 (외장 미연결/미인식)");
    else if (lastAntennaMode == 3) snprintf(tag, sizeof(tag), "  ✅ 안테나: 외부 active 사용 중 (LNA 전류 감지)");
    else                           snprintf(tag, sizeof(tag), "  ?  안테나: 알 수 없는 mode=%d", lastAntennaMode);
    return tag;
  }

  // PMTK 계열 ACK (예: $PMTK001,514,3*36) — MTK3333/3339 공통. advisor 지원 여부와 무관하게
  // 모듈이 살아있고 PMTK 프로토콜을 이해한다는 증거로 사용.
  if (strncmp(l, "$PMTK001,", 9) == 0) {
    sawPmtkAck = true;
    return "  · PMTK ACK 수신 (모듈 명령 파서 살아있음)";
  }
  // 일부 펌웨어는 $PMTK705 (버전) 또는 $PMTK514 응답을 $PMTK-접두 그대로 흘림
  if (strncmp(l, "$PMTK", 5) == 0) {
    sawPmtkAck = true;
    return "  · PMTK 응답 수신";
  }

  if (l[0] == '$') { cntOther++; return "  ?  unknown $ sentence"; }
  return nullptr;
}

// ── advisor probe 상태머신 ────────────────────────────────────────────
// setup 에선 시작만 걸어두고, loop 안에서 시간 기반으로 폴백 진행.
static void advisorProbeTick(uint32_t now) {
  if (probeStage == PROBE_DONE_SUPPORTED || probeStage == PROBE_DONE_UNSUPPORTED) return;

  const uint32_t inStage = now - probeStageEnteredMs;

  switch (probeStage) {
    case PROBE_WAIT_NMEA:
      // NMEA 흐름이 안정된 뒤 (GGA 2개 이상) advisor 명령을 보낸다.
      if (cntGGA >= 2) {
        probeStage = PROBE_SEND_PGCMD;
        probeStageEnteredMs = now;
      }
      break;

    case PROBE_SEND_PGCMD: {
      // L80 (MT3339): $PGCMD,33,1*6C 로 advisor ON.
      probeAttempts++;
      Serial.printf("[ANT] Probe #%u — $PGCMD,33,1 (L80/MT3339 advisor ON) 시도\n", probeAttempts);
      sendNmeaCmd("$PGCMD,33,1*6C");
      probeStage = PROBE_WAIT_PGCMD;
      probeStageEnteredMs = now;
      break;
    }

    case PROBE_WAIT_PGCMD:
      // $PGTOP 를 최소 1개 받으면 파서가 PROBE_DONE_SUPPORTED 로 넘겨준다.
      // 8초 지나도 응답 없으면 폴백으로 $PMTK514 시도.
      if (inStage >= 8000) {
        probeStage = PROBE_SEND_PMTK;
        probeStageEnteredMs = now;
      }
      break;

    case PROBE_SEND_PMTK: {
      // L80-R (MT3333): advisor 명령 자체가 다르거나 미지원.
      // 여기선 "모듈이 PMTK 프로토콜은 이해하는가" 를 먼저 확인해 본다.
      //   $PMTK514*3E — 현재 NMEA 출력 세팅 질의 (모든 MTK 계열이 응답)
      // 응답 오면 PMTK 는 되는데 $PGCMD advisor 만 안 먹는 것 → L80-R 확정.
      Serial.println(F("[ANT] Fallback — $PMTK514 (MT3333 계열 확인용) 시도"));
      sendNmeaCmd("$PMTK514*3E");
      probeStage = PROBE_WAIT_PMTK;
      probeStageEnteredMs = now;
      break;
    }

    case PROBE_WAIT_PMTK:
      if (inStage >= 3000) {
        // 마지막으로 $PGCMD 한 번 더 시도 (배선상 첫 명령이 씹혔을 가능성).
        if (probeAttempts < 3) {
          probeStage = PROBE_RETRY_PGCMD;
          probeStageEnteredMs = now;
        } else {
          probeStage = PROBE_DONE_UNSUPPORTED;
          probeStageEnteredMs = now;
          antennaSupport = ANT_UNSUPPORTED;
          if (sawPmtkAck) {
            Serial.println(F("[ANT] 확정: PMTK 응답은 오지만 $PGTOP 은 안 옴 → L80-R (MT3333) 로 추정. advisor 미지원."));
          } else {
            Serial.println(F("[ANT] 확정: PMTK/advisor 둘 다 무응답 → advisor 미지원 모듈. 안테나 상태는 GSV 위성 수로만 간접 판단."));
          }
        }
      }
      break;

    case PROBE_RETRY_PGCMD:
      // 재시도 후 다시 대기.
      sendNmeaCmd("$PGCMD,33,1*6C");
      probeStage = PROBE_WAIT_PGCMD;
      probeStageEnteredMs = now;
      break;

    default: break;
  }
}

// ── setup ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(5000);
  Serial.println();
  Serial.println(F("=== 03_3 L80/L80-R GPS NMEA + antenna advisor check ==="));
  Serial.printf("PWR_EN=GPIO%d (LOW=ON)  RX=GPIO%d  TX=GPIO%d  baud=%lu\n",
                PIN_PWR_EN, PIN_GPS_RX, PIN_GPS_TX, GPS_BAUD);
  Serial.println(F("실내에서 fix 없어도 NMEA 라인 1개라도 들어오면 모듈 OK."));
  Serial.println(F("안테나 advisor: L80 은 $PGCMD,33 지원. L80-R 은 미지원 가능 → 폴백 후 확정."));

  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);
  Serial.println(F("[PWR] PWR_EN -> LOW (모듈 켜짐, 부팅 ~1s)"));
  delay(1500);

  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  Serial.println(F("[UART] L80/L80-R UART 시작. 데이터 대기..."));
  Serial.println(F("[ANT] advisor probe 는 첫 GGA 2개 수신 후 자동 진행됩니다."));
  Serial.println();

  lastByteMs = millis();
  probeStageEnteredMs = millis();
}

// ── loop ──────────────────────────────────────────────────────────────
void loop() {
  uint32_t now = millis();

  // 바이트 수신 + 라인 단위 분리
  while (gpsSerial.available()) {
    int c = gpsSerial.read();
    if (c < 0) break;
    totalBytes++;
    lastByteMs = now;

    if (c == '\n' || c == '\r') {
      if (lineLen > 0) {
        line[lineLen] = 0;
        totalLines++;
        // 필요 시 디버그용으로 아래 2줄 주석 해제.
        // Serial.printf("[NMEA] %s\n", line);
        const char* tag = parseAndDiagnose(line);
        (void)tag;
        // if (tag) Serial.println(tag);
        lineLen = 0;
      }
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = (char)c;
    } else {
      lineLen = 0;
    }
  }

  // advisor probe 진행
  advisorProbeTick(now);

  // 1초마다 헬스라인
  static uint32_t lastLog = 0;
  if (now - lastLog >= 1000) {
    lastLog = now;
    uint32_t silentSecs = (now - lastByteMs) / 1000;

    Serial.printf("[%lus] bytes=%lu lines=%lu  GGA=%lu RMC=%lu GSA=%lu GSV=%lu VTG=%lu GLL=%lu other=%lu  silent=%lus\n",
                  now / 1000UL,
                  (unsigned long)totalBytes, (unsigned long)totalLines,
                  (unsigned long)cntGGA, (unsigned long)cntRMC,
                  (unsigned long)cntGSA, (unsigned long)cntGSV,
                  (unsigned long)cntVTG, (unsigned long)cntGLL,
                  (unsigned long)cntOther,
                  (unsigned long)silentSecs);

    Serial.print(F("[종합] "));
    if (totalBytes == 0) {
      Serial.print(F("❌ 모듈 응답 없음"));
    } else if (silentSecs >= 5) {
      Serial.printf("⚠️  최근 %lus 무응답 (이전엔 %lu바이트)", (unsigned long)silentSecs, (unsigned long)totalBytes);
    } else if (cntGGA < 2) {
      Serial.print(F("⏳ 부팅 직후 — NMEA 안정화 중"));
    } else {
      Serial.print(F("✅ UART OK"));

      // fix 상태
      if (haveFix && lastGsaMode >= 2) Serial.printf(" | ✅ %dD fix (위성 %d)", lastGsaMode, lastSatsUsed);
      else                             Serial.print(F(" | ❌ fix 없음"));

      // 시야 위성
      if (lastSatsView <= 0)           Serial.print(F(" | ⚠️  시야 위성 0"));
      else if (lastSatsView < 4)       Serial.printf(" | 🛰 시야 위성 %d (부족)", lastSatsView);
      else                             Serial.printf(" | ✅ 시야 위성 %d", lastSatsView);

      // 안테나 — advisor 지원 여부에 따라 표시 분기
      if (antennaSupport == ANT_SUPPORTED) {
        if      (lastAntennaMode == 3) Serial.print(F(" | ✅ 안테나 외부"));
        else if (lastAntennaMode == 2) Serial.print(F(" | ⚠️  안테나 내부 patch"));
        else if (lastAntennaMode == 1) Serial.print(F(" | ❌ 안테나 SHORT"));
        else                           Serial.printf(" | ? 안테나 mode=%d", lastAntennaMode);
      } else if (antennaSupport == ANT_UNSUPPORTED) {
        // advisor 미지원 모듈 (L80-R 등) → 위성 수로만 간접 추정
        if (lastSatsView >= 4)         Serial.print(F(" | 🛰 안테나(간접) OK"));
        else if (lastSatsView > 0)     Serial.print(F(" | 🛰 안테나(간접) 약함"));
        else                           Serial.print(F(" | 🛰 안테나(간접) 판정불가"));
        Serial.print(F(" [advisor 미지원]"));
      } else {
        // 아직 probe 진행 중
        Serial.printf(" | ⏳ 안테나 probe (stage=%d, try=%u)", (int)probeStage, probeAttempts);
      }

      // 시각
      if (lastRmcStat == 'A') Serial.printf(" | ⏰ UTC %s", lastRmcTime);
      else                    Serial.print(F(" | ⏰ 시각 미동기"));
    }
    Serial.println();

    if (silentSecs >= 60 && totalBytes == 0) {
      Serial.println(F(">>> 60s 동안 0 바이트 — 모듈 응답 없음. 전원/RX·TX 배선/baud 확인."));
    }
  }
}
