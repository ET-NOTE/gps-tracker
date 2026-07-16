// 03_6_aa — LC86G GPS 진단 (aa 전용 fork).
//
// 원본 03_6 (sss) 와 차이:
//   - GPS_BAUD 9600 (aa 신 하드웨어 LC86G default. 115200 로 영구 변경 시도해도 재부팅 시 9600
//     로 복귀 = persistence 불안정 → 그냥 9600 유지가 정답).
//   - baud 변경 시퀀스 (PAIR864/PMTK251/PAIR002) 없음 — aa 는 9600 그대로 사용.
// sss 로 sketch 재사용은 원본 03_6 (baud 115200) 을 그대로 사용.
//
// 03_3 (L80-R) 의 후속. LC86G 는 Quectel L86 후속 멀티-GNSS 모듈 (GPS/GLONASS/BeiDou/Galileo).
// 차이점:
//   - $GP 외에 $GN/$GL/$BD/$GA 문장도 함께 나옴 (멀티 constellation).
//   - Quectel PAIR 명령 (예: $PAIR513) 으로 안테나 상태 query 가능.
//   - L80 식 PMTK 명령 (예: $PMTK010) 도 호환되는 경우 있음.
//   - $GPTXT/$GNTXT 안테나 상태 메시지 ("ANTSTATUS=OK/SHORT/OPEN") 자동 emit.
//
// 외부 안테나 감지 방식 (3중 검증):
//   1) $xxTXT 안테나 메시지 파싱 — 모듈이 자동 emit 하는 텍스트
//   2) Quectel PAIR513 query 전송 후 $PAIR513 응답 파싱
//   3) GSV 시야 위성 카운트로 간접 추정 (4+ = 안테나 정상 가능성 높음)
//
// 핀: PWR_EN=GPIO6 (LOW=ON, LTE 와 공유), RX=GPIO20, TX=GPIO21, baud 9600.
//
// 출력 (시리얼 115200):
//   - 1초마다 헬스라인: bytes/lines/talker별 카운트/안테나 상태/위성 수
//   - $xxTXT 안테나 메시지 그대로 echo
//   - $PAIR513 응답 그대로 echo
//   - 10초마다 PAIR513 재query (실시간 갱신)

#include <HardwareSerial.h>

#define PIN_PWR_EN  6
#define PIN_GPS_RX 20   // ESP가 받는 쪽 (GPS TX -> ESP RX)
#define PIN_GPS_TX 21   // ESP가 보내는 쪽 (ESP TX -> GPS RX)
#define GPS_BAUD   9600UL   // (aa 전용 fork) LC86G default 9600 그대로 유지
#define SET_BAUD_ON_BOOT   0   // baud 변경 시퀀스 배제 (aa 는 9600 유지)

HardwareSerial gpsSerial(1);

// 통계
uint32_t totalBytes = 0;
uint32_t totalLines = 0;
uint32_t cntGGA = 0, cntRMC = 0, cntGSA = 0, cntGSV = 0, cntVTG = 0, cntGLL = 0;
uint32_t cntTXT = 0, cntPAIR = 0, cntOther = 0;
// talker 별 (멀티-constellation 확인)
uint32_t cntGP = 0, cntGN = 0, cntGL = 0, cntBD = 0, cntGA = 0;
uint32_t lastByteMs = 0;

// 한 줄 누적용
char line[256];
uint16_t lineLen = 0;

// 안테나 상태 (3중 source 통합 — 우선순위: PAIR > TXT > satCount 추정)
//   "?"           — 모르겠음
//   "OK"          — 정상 (외부 / 내부 active 둘 다 포함)
//   "OK_EXT"      — 외부 안테나 active (PAIR=2)
//   "OK_INT"      — 내부 안테나 active (PAIR=1)
//   "OPEN"        — 안테나 단선 / 미연결
//   "SHORT"       — 안테나 short
//   "INFERRED_OK" — TXT/PAIR 응답 없지만 GSV 위성 4+ 보임 → 안테나 정상 추정
char antStatus[24] = "?";
char antSource[16] = "?";   // 마지막 갱신 source (PAIR / TXT / GSV)
uint32_t antLastUpdateMs = 0;

// fix / 위성 상태
int  lastFix      = -1;   // GGA fix quality
int  lastSatsUsed = -1;
int  lastSatsView = 0;    // 마지막 GSV 시야 위성 수 (모든 constellation 합산 — 최근 1초)
int  satsViewAccum = 0;   // 1초 윈도우 누적 (다음 sec 시작 시 lastSatsView 로 commit)
uint32_t lastSatViewWindowMs = 0;
int  lastGsaMode  = -1;
char lastRmcStat  = 0;
char lastRmcTime[12] = {0};
bool haveFix = false;

// CSV n번째 필드 추출.
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

// NMEA checksum 계산 (XOR of chars between $ and *).
static uint8_t nmeaChecksum(const char* sentence) {
  uint8_t cs = 0;
  const char* p = sentence;
  if (*p == '$') p++;
  while (*p && *p != '*') { cs ^= (uint8_t)*p++; }
  return cs;
}

// "$PAIR513" 같은 명령 보내기 (* 와 checksum + CRLF 자동 첨부).
static void sendNmea(const char* body) {
  uint8_t cs = nmeaChecksum(body);
  char buf[80];
  snprintf(buf, sizeof(buf), "%s*%02X\r\n", body, cs);
  gpsSerial.print(buf);
  Serial.printf("[TX] %s", buf);   // CRLF 포함이라 println 안 함
}

// 안테나 상태 update — source 우선순위 적용 (PAIR > TXT > GSV).
static void updateAntenna(const char* status, const char* source) {
  // PAIR 결과는 항상 덮어씀.
  // TXT 결과는 PAIR 가 최근 5초 안에 갱신됐으면 skip.
  // GSV 추정은 PAIR/TXT 가 갱신됐으면 skip.
  uint32_t now = millis();
  // 신뢰도 우선순위: PQTM > PAIR > TXT > GSV (추정)
  if (strcmp(source, "PQTM") == 0 || strcmp(source, "PAIR") == 0) {
    strncpy(antStatus, status, sizeof(antStatus) - 1);
    antStatus[sizeof(antStatus) - 1] = 0;
    strncpy(antSource, source, sizeof(antSource) - 1);
    antSource[sizeof(antSource) - 1] = 0;
    antLastUpdateMs = now;
    return;
  }
  bool highPrioRecent = (strcmp(antSource, "PQTM") == 0 || strcmp(antSource, "PAIR") == 0)
                     && (now - antLastUpdateMs) < 10000;
  if (strcmp(source, "TXT") == 0 && highPrioRecent) return;
  if (strcmp(source, "GSV") == 0
      && (highPrioRecent || (strcmp(antSource, "TXT") == 0 && (now - antLastUpdateMs) < 10000))) {
    return;
  }
  strncpy(antStatus, status, sizeof(antStatus) - 1);
  antStatus[sizeof(antStatus) - 1] = 0;
  strncpy(antSource, source, sizeof(antSource) - 1);
  antSource[sizeof(antSource) - 1] = 0;
  antLastUpdateMs = now;
}

// 들어온 NMEA 1줄 파싱.
static void parseNmea(const char* l) {
  // talker 카운트 ($XX...)
  if (l[0] == '$' && l[1] && l[2]) {
    if (l[1] == 'G' && l[2] == 'P') cntGP++;
    else if (l[1] == 'G' && l[2] == 'N') cntGN++;
    else if (l[1] == 'G' && l[2] == 'L') cntGL++;
    else if (l[1] == 'B' && l[2] == 'D') cntBD++;
    else if (l[1] == 'G' && l[2] == 'A') cntGA++;
  }

  char f[24];

  // ── 안테나 메시지: $xxTXT,..,..,..,ANTSTATUS=OK / OPEN / SHORT
  // L80/LC86G 가 자동 emit. 형식 예: $GPTXT,01,01,02,ANTSTATUS=OK*3B
  if (strncmp(l + 3, "TXT", 3) == 0) {
    cntTXT++;
    // 메시지 본문 (필드 4) 에 ANTSTATUS= 또는 ANTENNA 키워드 검사
    const char* ants = strstr(l, "ANTSTATUS=");
    if (ants) {
      ants += strlen("ANTSTATUS=");
      if (strncmp(ants, "OK", 2) == 0)      updateAntenna("OK", "TXT");
      else if (strncmp(ants, "OPEN", 4) == 0)  updateAntenna("OPEN", "TXT");
      else if (strncmp(ants, "SHORT", 5) == 0) updateAntenna("SHORT", "TXT");
      Serial.printf("[ANT/TXT] %s\n", l);
      return;
    }
    // 일부 모듈은 "ANTENNA OPEN" / "ANTENNA OK" 표현
    if (strstr(l, "ANTENNA")) {
      if (strstr(l, "OK"))         updateAntenna("OK", "TXT");
      else if (strstr(l, "OPEN"))  updateAntenna("OPEN", "TXT");
      else if (strstr(l, "SHORT")) updateAntenna("SHORT", "TXT");
      Serial.printf("[ANT/TXT] %s\n", l);
      return;
    }
    return;
  }

  // ── 🎯 LC86G Quectel proprietary auto-emit: $PQTMANTENNASTATUS,<ver>,<mode>,<status>,<source>*XX
  //   status: 0=open, 1=short, 2=normal/OK, 3=not connected
  //   source: 1=internal, 2=external
  if (strncmp(l, "$PQTMANTENNASTATUS", 18) == 0) {
    cntPAIR++;
    char f1[8], f2[8], f3[8];
    getField(l, 2, f1, sizeof(f1));   // mode
    getField(l, 3, f2, sizeof(f2));   // status
    getField(l, 4, f3, sizeof(f3));   // source
    int st = f2[0] ? atoi(f2) : -1;
    int src = f3[0] ? atoi(f3) : -1;
    const char* statusTag = "?";
    switch (st) {
      case 0: statusTag = "OPEN"; break;
      case 1: statusTag = "SHORT"; break;
      case 2: statusTag = (src == 2 ? "OK_EXT" : (src == 1 ? "OK_INT" : "OK")); break;
      case 3: statusTag = "OPEN"; break;
      default: statusTag = "?"; break;
    }
    updateAntenna(statusTag, "PQTM");
    static uint32_t lastEcho = 0;
    if (millis() - lastEcho >= 5000) {   // echo 1회/5초 (스팸 방지)
      lastEcho = millis();
      Serial.printf("[ANT/PQTM] mode=%s status=%d (%s) source=%d (%s) | %s\n",
                    f1, st, statusTag, src, (src == 2 ? "external" : (src == 1 ? "internal" : "?")), l);
    }
    return;
  }

  // ── Quectel PAIR 응답 (legacy/L80): $PAIR513,<state>*XX
  if (strncmp(l, "$PAIR513", 8) == 0 || strncmp(l, "$PAIR,513", 9) == 0) {
    cntPAIR++;
    getField(l, 1, f, sizeof(f));
    int st = f[0] ? atoi(f) : -1;
    const char* tag = "?";
    switch (st) {
      case 0: tag = "OPEN"; break;       // no antenna (open / disconnected)
      case 1: tag = "OK_INT"; break;     // internal active
      case 2: tag = "OK_EXT"; break;     // external active
      case 3: tag = "SHORT"; break;
      default: tag = "?"; break;
    }
    updateAntenna(tag, "PAIR");
    Serial.printf("[ANT/PAIR] state=%d → %s | %s\n", st, tag, l);
    return;
  }

  // ── 일반 NMEA 카운트
  if (strncmp(l + 3, "GGA", 3) == 0) {
    cntGGA++;
    getField(l, 6, f, sizeof(f)); lastFix      = (f[0] ? atoi(f) : 0);
    getField(l, 7, f, sizeof(f)); lastSatsUsed = (f[0] ? atoi(f) : 0);
    haveFix = (lastFix >= 1);
    return;
  }
  if (strncmp(l + 3, "RMC", 3) == 0) {
    cntRMC++;
    getField(l, 1, f, sizeof(f)); strncpy(lastRmcTime, f, sizeof(lastRmcTime) - 1);
    getField(l, 2, f, sizeof(f)); lastRmcStat = f[0] ? f[0] : '?';
    return;
  }
  if (strncmp(l + 3, "GSA", 3) == 0) {
    cntGSA++;
    getField(l, 2, f, sizeof(f)); lastGsaMode = (f[0] ? atoi(f) : 0);
    return;
  }
  if (strncmp(l + 3, "GSV", 3) == 0) {
    cntGSV++;
    // 필드 3 = 시야 위성 수. talker (GP/GL/BD/GA) 마다 별도 GSV 셋트.
    // 1초 윈도우 안의 모든 GSV 시야 값을 합산 → 멀티-constellation 총 위성 수.
    getField(l, 3, f, sizeof(f));
    int v = f[0] ? atoi(f) : 0;
    satsViewAccum += v;
    return;
  }
  if (strncmp(l + 3, "VTG", 3) == 0) { cntVTG++; return; }
  if (strncmp(l + 3, "GLL", 3) == 0) { cntGLL++; return; }
  if (l[0] == '$') {
    cntOther++;
    Serial.printf("[OTHER] %s\n", l);   // 알 수 없는 $ sentence 모두 echo — LC86G proprietary 발견용
    return;
  }
}

void setup() {
  Serial.begin(115200);
  delay(5000);
  Serial.println();
  Serial.println(F("=== 03_6 LC86G GPS + external antenna detection ==="));
  Serial.printf("PWR_EN=GPIO%d (LOW=ON)  RX=GPIO%d  TX=GPIO%d  baud=%lu\n",
                PIN_PWR_EN, PIN_GPS_RX, PIN_GPS_TX, GPS_BAUD);
  Serial.println(F("LC86G 멀티-GNSS — 실내에서 fix 못해도 NMEA 1줄 들어오면 모듈 OK."));
  Serial.println(F("안테나 감지 3중: PAIR513 query + TXT 안테나 메시지 + GSV 위성 카운트."));
  Serial.println();

  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);   // GPS+LTE 공유 전원 ON
  Serial.println(F("[PWR] PWR_EN -> LOW (모듈 켜짐, 부팅 ~1s)"));
  delay(1500);

#if SET_BAUD_ON_BOOT
  // (2026-07-01) aa 는 default 9600 → 115200 로 바꾸는 시퀀스. 이후 flash 저장 (PAIR002).
  Serial.println(F("[BAUD] 9600 open → PAIR864 로 115200 전환 시도"));
  gpsSerial.begin(GPS_INITIAL_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  delay(500);
  // 두 계열 다 시도 — LC86G 는 Quectel(PAIR) or MediaTek(PMTK) 어느 것 지원할 지 모름.
  Serial.println(F("[BAUD] TX: $PAIR864,0,0,115200*1B (Quectel)"));
  gpsSerial.print("$PAIR864,0,0,115200*1B\r\n");
  gpsSerial.flush();
  delay(200);
  Serial.println(F("[BAUD] TX: $PMTK251,115200*1F (MediaTek 계열)"));
  gpsSerial.print("$PMTK251,115200*1F\r\n");
  gpsSerial.flush();
  delay(300);
  gpsSerial.end();
  delay(100);
  Serial.println(F("[BAUD] gpsSerial 재-open at 115200"));
#endif

  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  Serial.println(F("[UART] LC86G UART 시작. 데이터 대기..."));
  Serial.println();

  // 3초 후 여러 안테나 query 명령 시도 — LC86G 가 어느 형식 인식하는지 모름.
  // 모듈이 인식하면 응답 ($PAIR... / $PQTM... / $PMTK... ack), 무시하면 silent.
  // [OTHER] echo 로 어떤 응답이 들어오는지 확인 가능.
  delay(3000);
  Serial.println(F("[INIT] 안테나 query 명령 5종 전송 (LC86G 정확 명령 탐색용)"));
  sendNmea("$PAIR513,1");                   // Quectel PAIR — read antenna state
  delay(200);
  sendNmea("$PAIR104");                     // Quectel — query antenna mode
  delay(200);
  sendNmea("$PAIR080,1");                   // Quectel — enable antenna detection
  delay(200);
  sendNmea("$PQTMCFGOTHERSEN,W,1");         // Quectel — enable antenna sensor output
  delay(200);
  sendNmea("$PMTK869,0");                   // MediaTek (legacy) — query antenna voltage
  delay(200);
  sendNmea("$PMTK514");                     // MediaTek — query output config (어떤 sentence enabled)
#if SET_BAUD_ON_BOOT
  // (2026-07-01) baud 변경 후 flash 저장 시도 — PAIR002 (예상). LC86G 문서 없이 시도.
  // checksum for "PAIR002" = 0x50^0x41^0x49^0x52^0x30^0x30^0x32 = 0x38
  delay(500);
  Serial.println(F("[BAUD] TX: $PAIR002*38 (flash save 시도)"));
  gpsSerial.print("$PAIR002*38\r\n");
#endif
  Serial.println(F("[INIT] 명령 전송 완료. 응답 또는 자동 emit 메시지 대기..."));

  lastByteMs = millis();
  lastSatViewWindowMs = millis();
}

void loop() {
  uint32_t now = millis();

  // 바이트 수신 + 라인 분리
  while (gpsSerial.available()) {
    int c = gpsSerial.read();
    if (c < 0) break;
    totalBytes++;
    lastByteMs = now;

    if (c == '\n' || c == '\r') {
      if (lineLen > 0) {
        line[lineLen] = 0;
        totalLines++;
        parseNmea(line);
        lineLen = 0;
      }
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = (char)c;
    } else {
      lineLen = 0;   // overflow → drop
    }
  }

  // 1초마다 헬스라인 + GSV 윈도우 커밋
  static uint32_t lastLog = 0;
  if (now - lastLog >= 1000) {
    lastLog = now;
    // GSV 시야 위성 1초 윈도우 commit
    lastSatsView = satsViewAccum;
    satsViewAccum = 0;
    lastSatViewWindowMs = now;

    // GSV 추정 안테나 — 4+ 보이면 OK 로 inferr (실내에서도 fix 안 잡혀도 위성 visibility 가능).
    if (lastSatsView >= 4) {
      updateAntenna("INFERRED_OK", "GSV");
    } else if (lastSatsView == 0 && totalLines > 10) {
      // 라인 충분히 들어왔는데 위성 0 → 안테나 의심 (단, PAIR/TXT 가 더 높은 신뢰도라 거기서 덮어씀)
      updateAntenna("INFERRED_NONE", "GSV");
    }

    uint32_t silentSecs = (now - lastByteMs) / 1000;

    // 원본 카운터
    Serial.printf("[%lus] bytes=%lu lines=%lu  GGA=%lu RMC=%lu GSA=%lu GSV=%lu TXT=%lu PAIR=%lu other=%lu  talker GP=%lu GN=%lu GL=%lu BD=%lu GA=%lu  silent=%lus\n",
                  now / 1000UL,
                  (unsigned long)totalBytes, (unsigned long)totalLines,
                  (unsigned long)cntGGA, (unsigned long)cntRMC,
                  (unsigned long)cntGSA, (unsigned long)cntGSV,
                  (unsigned long)cntTXT, (unsigned long)cntPAIR, (unsigned long)cntOther,
                  (unsigned long)cntGP, (unsigned long)cntGN,
                  (unsigned long)cntGL, (unsigned long)cntBD, (unsigned long)cntGA,
                  (unsigned long)silentSecs);

    // 한글 종합 진단
    Serial.print(F("[종합] "));
    if (totalBytes == 0) {
      Serial.print(F("❌ 모듈 응답 없음"));
    } else if (silentSecs >= 5) {
      Serial.printf("⚠️  최근 %lus 무응답 (이전엔 %lu바이트)",
                    (unsigned long)silentSecs, (unsigned long)totalBytes);
    } else if (cntGGA < 2 && cntGSV < 2) {
      Serial.print(F("⏳ 부팅 직후 — NMEA 안정화 중"));
    } else {
      Serial.print(F("✅ UART OK"));
      if (haveFix && lastGsaMode >= 2)      Serial.printf(" | ✅ %dD fix (위성 %d)", lastGsaMode, lastSatsUsed);
      else                                  Serial.print(F(" | ❌ fix 없음"));
      // 안테나 — 3중 검증 종합
      if (strcmp(antStatus, "OK_EXT") == 0)
        Serial.printf(" | 📡 안테나: 외부 active (source=%s)", antSource);
      else if (strcmp(antStatus, "OK_INT") == 0)
        Serial.printf(" | 📡 안테나: 내부 active (source=%s)", antSource);
      else if (strcmp(antStatus, "OK") == 0)
        Serial.printf(" | 📡 안테나: OK (source=%s)", antSource);
      else if (strcmp(antStatus, "OPEN") == 0)
        Serial.printf(" | ⚠️  안테나: OPEN/미연결 (source=%s)", antSource);
      else if (strcmp(antStatus, "SHORT") == 0)
        Serial.printf(" | ⚠️  안테나: SHORT (source=%s)", antSource);
      else if (strcmp(antStatus, "INFERRED_OK") == 0)
        Serial.printf(" | 📡 안테나: 추정 OK (GSV %d개)", lastSatsView);
      else if (strcmp(antStatus, "INFERRED_NONE") == 0)
        Serial.print(F(" | ⚠️  안테나: 추정 미연결 (GSV 0)"));
      else
        Serial.print(F(" | ? 안테나: 정보 부족 (대기)"));
      // 위성
      if (lastSatsView > 0)                 Serial.printf(" | 🛰 시야 %d", lastSatsView);
      // 시각
      if (lastRmcStat == 'A')               Serial.printf(" | ⏰ UTC %s", lastRmcTime);
    }
    Serial.println();

    if (silentSecs >= 60 && totalBytes == 0) {
      Serial.println(F(">>> 60s 동안 0 바이트 — 모듈 응답 없음. 전원/RX·TX 배선/baud 확인."));
    }
  }

  // 10초마다 PAIR513 재query (실시간 안테나 상태 갱신).
  static uint32_t lastPairQuery = 0;
  if (now - lastPairQuery >= 10000 && totalBytes > 0) {
    lastPairQuery = now;
    sendNmea("$PAIR513,1");
  }
}
