// 03_3 — L80-R GPS 모듈 단독 living-check (실내 OK).
//
// 목적: 모듈이 UART 로 NMEA 스트림 뱉고 있는지 확인. fix 까지 안 가도 OK.
//   - 실내: 위성 못 잡아서 RMC/GGA 의 fix 비트는 V/0 일 수 있지만,
//     모듈 자체가 살아있으면 1초 주기로 NMEA 문장 ($GPxxx) 가 항상 나옴.
//   - "device found" 수준 = $GP 문장 1개라도 들어오면 통과.
//
// 핀: PWR_EN=GPIO6 (LOW=ON, LTE 와 공유), RX=GPIO20, TX=GPIO21, baud 9600.
//
// 출력 (시리얼 115200):
//   - 1초마다 헬스라인: bytes / NMEA 문장 카운트 / 헤더별 카운트
//   - NMEA 한 줄 들어올 때마다 그대로 echo (디버그)
//   - 60초 동안 0 바이트면 "DEAD" 경고

#include <HardwareSerial.h>

#define PIN_PWR_EN  6
#define PIN_GPS_RX 20   // ESP가 받는 쪽 (GPS TX -> ESP RX)
#define PIN_GPS_TX 21   // ESP가 보내는 쪽 (ESP TX -> GPS RX)
#define GPS_BAUD   9600UL

HardwareSerial gpsSerial(1);

// 통계
uint32_t totalBytes = 0;
uint32_t totalLines = 0;
uint32_t cntGGA = 0, cntRMC = 0, cntGSA = 0, cntGSV = 0, cntVTG = 0, cntGLL = 0, cntOther = 0;
uint32_t lastByteMs = 0;

// 한 줄 누적용
char line[200];
uint16_t lineLen = 0;

// 상태 (한글 진단용)
int     lastFix     = -1;   // GGA fix quality: 0=없음 1=GPS 2=DGPS
int     lastSatsUsed= -1;   // GGA 사용 위성 수
int     lastSatsView= -1;   // GSV 시야 위성 수
int     lastGsaMode = -1;   // GSA mode: 1=없음 2=2D 3=3D
char    lastRmcStat = 0;    // RMC 상태: 'A'=유효 'V'=무효(void)
char    lastRmcTime[12] = {0};   // RMC UTC 시각 hhmmss.ss
bool    haveFix     = false;
// (2026-07-30) 안테나 advisor — $PGCMD,33,1*6C 로 활성화 후 $PGTOP,11,<x> 로 리포트.
//   0 = 미보고 (advisor 명령 전송 실패거나 모듈이 답 안 함 — L80 non-active 모델 등)
//   1 = SHORT (안테나 회로 단락 — 배선/커넥터 이상)
//   2 = 내부 patch 안테나 사용 중 (외장 안테나 미연결 or 인식 실패)
//   3 = 외부 active 안테나 사용 중 (LNA 로 전류 감지됨)
int     lastAntennaMode = 0;
uint32_t antennaLastMs = 0;   // $PGTOP 마지막 수신 시각

// CSV n번째 필드 추출 (0-indexed). 없으면 빈 문자열.
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

// 들어온 NMEA 1줄 → 카운트 + 한글 진단 라벨 (반환: 동봉할 짧은 태그)
static const char* parseAndDiagnose(const char* l) {
  char f[16];
  if (strncmp(l, "$GPGGA", 6) == 0) {
    cntGGA++;
    // 필드: 0=$GPGGA 1=time 2=lat 3=N/S 4=lng 5=E/W 6=fix 7=sats 8=hdop ...
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
    // 필드: 0=$GPRMC 1=time 2=status 3=lat ...
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
    // 필드: 0=$GPGSV 1=총메시지수 2=현재메시지 3=시야위성수
    getField(l, 3, f, sizeof(f)); lastSatsView = (f[0] ? atoi(f) : 0);
    static char tag[128];
    if (lastSatsView == 0)      snprintf(tag, sizeof(tag), "  ⚠️  GSV: 시야 위성 0개 (실내 정상 / 야외라면 안테나 점검)");
    else if (lastSatsView < 4)  snprintf(tag, sizeof(tag), "  🛰 GSV: 시야 위성 %d개 (fix 부족, 4+ 필요)", lastSatsView);
    else                        snprintf(tag, sizeof(tag), "  ✅ GSV: 시야 위성 %d개 (안테나 OK)", lastSatsView);
    return tag;
  }
  if (strncmp(l, "$GPVTG", 6) == 0) { cntVTG++; return "  · VTG: 속도/방향 (fix 시 의미)"; }
  if (strncmp(l, "$GPGLL", 6) == 0) { cntGLL++; return "  · GLL: 위경도 (fix 시 의미)"; }
  // (2026-07-30) 안테나 advisor 응답 — $PGTOP,11,<mode>*hh
  if (strncmp(l, "$PGTOP,11,", 10) == 0) {
    lastAntennaMode = atoi(l + 10);
    antennaLastMs = millis();
    static char tag[128];
    if      (lastAntennaMode == 1) snprintf(tag, sizeof(tag), "  ❌ 안테나: SHORT (배선/커넥터 단락)");
    else if (lastAntennaMode == 2) snprintf(tag, sizeof(tag), "  ⚠️  안테나: 내부 patch 사용 중 (외장 미연결/미인식)");
    else if (lastAntennaMode == 3) snprintf(tag, sizeof(tag), "  ✅ 안테나: 외부 active 사용 중 (LNA 전류 감지)");
    else                           snprintf(tag, sizeof(tag), "  ?  안테나: 알 수 없는 mode=%d", lastAntennaMode);
    return tag;
  }
  if (l[0] == '$')                  { cntOther++; return "  ?  unknown $ sentence"; }
  return nullptr;
}

void setup() {
  Serial.begin(115200);
  delay(5000);
  Serial.println();
  Serial.println(F("=== 03_3 L80 GPS basic NMEA stream check ==="));
  Serial.printf("PWR_EN=GPIO%d (LOW=ON)  RX=GPIO%d  TX=GPIO%d  baud=%lu\n",
                PIN_PWR_EN, PIN_GPS_RX, PIN_GPS_TX, GPS_BAUD);
  Serial.println(F("실내에서 fix 없어도 NMEA 라인 1개라도 들어오면 모듈 OK."));

  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);   // GPS+LTE 전원 ON (공유라 LTE 도 같이 켜짐)
  Serial.println(F("[PWR] PWR_EN -> LOW (모듈 켜짐, 부팅 ~1s)"));
  delay(1500);

  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  Serial.println(F("[UART] L80 UART 시작. 데이터 대기..."));

  // (2026-07-30) 안테나 advisor 활성화 — MTK PMTK 계열 명령.
  //   $PGCMD,33,1*6C — advisor ON (매 위치 fix 시 $PGTOP,11,<mode> 리포트)
  //   $PGCMD,33,0*6D — advisor OFF
  //   mode: 1=SHORT / 2=내부 patch / 3=외부 active
  // 모듈이 부팅 안정화 (NMEA 흐름 시작) 이후 전송해야 안전. 2초 추가 대기.
  delay(2000);
  gpsSerial.println("$PGCMD,33,1*6C");
  Serial.println(F("[ANT] 안테나 advisor ON — $PGTOP,11,<mode> 리포트 대기"));

  Serial.println();
  lastByteMs = millis();
}

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
        // 라인별 raw + 한글 태그는 노이즈가 커서 주석 처리.
        // 종합 라인 ([종합] ...) 만으로 충분. 필요 시 아래 2줄 주석 해제.
        // Serial.printf("[NMEA] %s\n", line);
        const char* tag = parseAndDiagnose(line);   // 상태 업데이트 위해 호출은 유지
        (void)tag;
        // if (tag) Serial.println(tag);
        lineLen = 0;
      }
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = (char)c;
    } else {
      lineLen = 0;   // overflow → drop
    }
  }

  // 1초마다 헬스라인
  static uint32_t lastLog = 0;
  if (now - lastLog >= 1000) {
    lastLog = now;
    uint32_t silentSecs = (now - lastByteMs) / 1000;

    // 원본 카운터 (engineer 용)
    Serial.printf("[%lus] bytes=%lu lines=%lu  GGA=%lu RMC=%lu GSA=%lu GSV=%lu VTG=%lu GLL=%lu other=%lu  silent=%lus\n",
                  now / 1000UL,
                  (unsigned long)totalBytes, (unsigned long)totalLines,
                  (unsigned long)cntGGA, (unsigned long)cntRMC,
                  (unsigned long)cntGSA, (unsigned long)cntGSV,
                  (unsigned long)cntVTG, (unsigned long)cntGLL,
                  (unsigned long)cntOther,
                  (unsigned long)silentSecs);

    // 한글 종합 진단
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
      if (haveFix && lastGsaMode >= 2)      Serial.printf(" | ✅ %dD fix (위성 %d)", lastGsaMode, lastSatsUsed);
      else                                  Serial.print(F(" | ❌ fix 없음"));
      // 시야 위성
      if (lastSatsView <= 0)                Serial.print(F(" | ⚠️  시야 위성 0"));
      else if (lastSatsView < 4)            Serial.printf(" | 🛰 시야 위성 %d (부족)", lastSatsView);
      else                                  Serial.printf(" | ✅ 시야 위성 %d", lastSatsView);
      // (2026-07-30) 안테나 mode — L80 advisor 응답. 미보고면 커넥터/케이블/PGCMD 미도달 의심.
      if      (lastAntennaMode == 3)        Serial.print(F(" | ✅ 안테나 외부"));
      else if (lastAntennaMode == 2)        Serial.print(F(" | ⚠️  안테나 내부 patch"));
      else if (lastAntennaMode == 1)        Serial.print(F(" | ❌ 안테나 SHORT"));
      else if (antennaLastMs == 0)          Serial.print(F(" | ? 안테나 미보고"));
      else                                  Serial.printf(" | ? 안테나 mode=%d", lastAntennaMode);
      // 시각
      if (lastRmcStat == 'A')               Serial.printf(" | ⏰ UTC %s", lastRmcTime);
      else                                  Serial.print(F(" | ⏰ 시각 미동기"));
    }
    Serial.println();

    if (silentSecs >= 60 && totalBytes == 0) {
      Serial.println(F(">>> 60s 동안 0 바이트 — 모듈 응답 없음. 전원/RX·TX 배선/baud 확인."));
    }
  }
}
