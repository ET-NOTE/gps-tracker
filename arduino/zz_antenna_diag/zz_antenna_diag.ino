// =================================================================
// zz_antenna_diag — GPS 외부 안테나 진단 전용 (HW 개발자용, 2026-07-03)
//   목적: 시리얼 모니터로 L86-M33 의 ANTSTATUS 를 "실시간" 관찰하며
//         안테나/급전 하드웨어를 바꿔가며 해결하기 위한 최소 펌웨어.
//   특징: LTE/모션/슬립 전부 미동작 → 안테나 출력만 깔끔. 계속 깨어있어 모니터 안 끊김.
//
//   [빌드/모니터]
//     FQBN : esp32:esp32:esp32c3:CDCOnBoot=cdc
//     모니터: arduino-cli monitor -p COMxx --config baudrate=115200
//             (또는 Arduino IDE 시리얼 모니터 115200)
//
//   [ANTSTATUS 판독 — 중요]
//     OPEN     = 모듈이 안테나 '전류'를 못 봄 (개방 / 패시브안테나 / 전류 임계 미만)
//     OK/USING = 정상 전류 검출 (액티브 안테나가 bias 전류를 정상적으로 끌어감)
//     SHORT    = 단락 (과전류)
//   ※ 전압 ≠ 전류: 커넥터에 bias '전압'이 있어도 안테나가 '전류'를 안 끌면 OPEN 이 정상.
//   ※ 상태는 '변할 때' 모듈이 방출함 → 안테나 연결/급전 바꾸면 즉시 새 줄이 뜸.
//     변화 없이 강제 재확인하려면 보드 리셋(EN 버튼) → 부팅 시 현재 상태 재방출.
// =================================================================
#include <HardwareSerial.h>
#include <string.h>

// ── 핀 (config.h 와 동일 값, 자립형이라 여기 직접 정의) ──
#define PIN_PWR_EN   6      // GPS+LTE 공유 전원 레일, LOW=ON / HIGH=OFF
#define PIN_GPS_RX   20     // ESP RX ← GPS TX
#define PIN_GPS_TX   21     // ESP TX → GPS RX
#define PIN_BUZZER   1      // 능동 부저 — 진단 중 무음 위해 LOW 고정
#define GPS_BAUD     9600   // L86 기본 (절대 변경 금지)

HardwareSerial gps(0);      // UART0 (CDCOnBoot=cdc 라 UART0 free)

static uint32_t bootMs      = 0;
static char     lastStatus[16] = "?";
static char     lastRaw[100]   = "(아직 수신 없음)";
static uint32_t lastRawMs      = 0;
static uint32_t emissions      = 0;
static uint32_t nmeaCount      = 0;                 // GPS 생존 확인: 총 NMEA 라인 수
static char     lastNmea[100]  = "(NMEA 없음)";      // 마지막 수신 NMEA (아무 문장)
static uint32_t gpsBaud        = 9600;              // 자동탐지 결과

// NMEA 체크섬 붙여 전송
static void sendNmea(const char *body) {
  uint8_t cs = 0;
  const char *p = body;
  if (*p == '$') p++;
  while (*p && *p != '*') cs ^= (uint8_t)*p++;
  gps.printf("%s*%02X\r\n", body, cs);
}

static const char* interpret(const char *st) {
  if (strstr(st, "OPEN") || strstr(st, "NOT_CONN"))        return "전류 미검출 (개방/패시브/임계 미만) → 안테나가 bias 전류를 안 끎";
  if (strstr(st, "SHORT"))                                 return "단락 (과전류)";
  if (strstr(st, "OK_EXT"))                                return "정상 — 외부 액티브 안테나 전류 검출!";
  if (strstr(st, "OK_INT"))                                return "정상 — 내부 패치 안테나 사용중";
  if (strstr(st, "OK") || strstr(st, "USING") || strstr(st, "NORMAL")) return "정상 (전류 검출)";
  return "미상";
}

// 안테나 상태 라인 처리 — LC86G($PQTMANTENNASTATUS) + L86($GPTXT ANTSTATUS) 둘 다.
static void handleAntLine(char *line) {
  emissions++;
  lastRawMs = millis();
  strncpy(lastRaw, line, sizeof(lastRaw) - 1); lastRaw[sizeof(lastRaw) - 1] = 0;

  char st[16] = "?";
  if (strstr(line, "PQTMANTENNASTATUS")) {
    // LC86G(Airoha): $PQTMANTENNASTATUS,<ver>,<mode>,<status>,<source>*XX
    //   status: 0=OPEN 1=SHORT 2=NORMAL 3=NOT_CONNECTED / source: 1=internal 2=external
    int commas = 0, stc = -99, soc = -1;
    for (char *p = line; *p && *p != '*'; p++) {
      if (*p == ',') { commas++; if (commas == 3) stc = atoi(p + 1); else if (commas == 4) soc = atoi(p + 1); }
    }
    if      (stc == 0) strcpy(st, "OPEN");
    else if (stc == 3) strcpy(st, "NOT_CONN");
    else if (stc == 1) strcpy(st, "SHORT");
    else if (stc == 2) strcpy(st, soc == 2 ? "OK_EXT" : (soc == 1 ? "OK_INT" : "OK"));
  } else {
    // L86(MTK): ...ANTSTATUS=XXX
    const char *a = strstr(line, "ANTSTATUS=");
    if (a) {
      a += 10;   // strlen("ANTSTATUS=")
      int i = 0;
      while (a[i] && a[i] != '*' && a[i] != ',' && i < (int)sizeof(st) - 1) { st[i] = a[i]; i++; }
      st[i] = 0;
    }
  }
  bool changed = strcmp(st, lastStatus) != 0;
  strncpy(lastStatus, st, sizeof(lastStatus) - 1); lastStatus[sizeof(lastStatus) - 1] = 0;

  // 변화 시에만 상세 블록 출력 (재방출은 하트비트로만 → 시끄럽지 않게).
  if (changed) {
    Serial.println();
    Serial.println(F("  ============================================"));
    Serial.printf ("  >>> ANTSTATUS 변화!  status = %s\n", st);
    Serial.printf ("      해석: %s\n", interpret(st));
    Serial.printf ("      원문: %s\n", line);
    Serial.println(F("  ============================================\n"));
  }
}

void setup() {
  bootMs = millis();
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);   // 부저 무음

  Serial.begin(115200);
  delay(2000);   // USB CDC 안정화
  Serial.println();
  Serial.println(F("================ GPS 안테나 진단 (zz_antenna_diag) ================"));
  Serial.println(F(" ANTSTATUS 판독:  OPEN=전류미검출 / OK=정상 / SHORT=단락"));
  Serial.println(F(" ※ 전압≠전류: bias 전압 있어도 전류 안 흐르면 OPEN 이 정상."));
  Serial.println(F(" ※ 상태는 변할 때 방출 → 안테나/급전 바꾸면 즉시 새 줄. 강제 재확인=리셋."));
  Serial.println(F("==================================================================="));

  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);   // GPS 전원 레일 ON
  delay(500);

  // ── 보드레이트 자동탐지 (LC86G 는 9600/115200 등 다를 수 있음) ──
  gps.setRxBufferSize(2048);
  const uint32_t cands[] = { 9600, 115200, 38400, 57600, 4800 };
  int best = -1;
  for (uint32_t b : cands) {
    gps.begin(b, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
    delay(150);
    while (gps.available()) gps.read();   // flush
    uint32_t t0 = millis(); int valid = 0;
    static char ln[128]; uint16_t k = 0;
    while (millis() - t0 < 1400) {
      while (gps.available()) {
        char c = (char)gps.read();
        if (c == '\n' || c == '\r') { if (k > 5 && ln[0] == '$') valid++; k = 0; }
        else if (k < sizeof(ln) - 1) ln[k++] = c; else k = 0;
      }
    }
    Serial.printf("[baud] %6u → 유효 NMEA %d 줄\n", (unsigned)b, valid);
    if (valid > best) { best = valid; gpsBaud = b; }
    gps.end(); delay(50);
  }
  gps.begin(gpsBaud, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  Serial.printf("[init] 선택 baud=%u (유효 %d줄). ", (unsigned)gpsBaud, best);
  delay(500);
  sendNmea("$PGCMD,33,1");        // (MTK/L86) 안테나 advisor
  sendNmea("$PQTMCFGANTENNA,W,1"); // (Airoha/LC86G 후보) 안테나 상태 출력 — 미지원 시 무시(무해)
  Serial.println(F("안테나 상태 수신 대기중...\n"));
}

void loop() {
  static char     line[128];
  static uint16_t n = 0;

  while (gps.available()) {
    char c = (char)gps.read();
    if (c == '\n' || c == '\r') {
      if (n > 0) {
        line[n] = 0;
        if (line[0] == '$') {   // NMEA 문장
          nmeaCount++;
          strncpy(lastNmea, line, sizeof(lastNmea) - 1); lastNmea[sizeof(lastNmea) - 1] = 0;
        }
        if (strstr(line, "ANTSTATUS") || strstr(line, "PQTMANTENNASTATUS")) handleAntLine(line);
        n = 0;
      }
    } else if (n < sizeof(line) - 1) {
      line[n++] = c;
    } else {
      n = 0;   // overflow → drop
    }
  }

  // 15초마다 안테나 advisor 재요청 (모듈이 advisor off 상태여도 켜지도록)
  static uint32_t reMs = 0;
  if (millis() - reMs >= 15000) { reMs = millis(); sendNmea("$PGCMD,33,1"); }

  // 2초 하트비트 — 현재 상태 + GPS 생존(nmea) 상시 표시
  static uint32_t hb = 0;
  if (millis() - hb >= 2000) {
    hb = millis();
    if (nmeaCount == 0) {
      Serial.printf("[ANT] status=%s | ⚠ GPS NMEA 0건 (전원/배선 확인!) | boot+%lus\n",
        lastStatus, (unsigned long)((millis() - bootMs) / 1000));
    } else if (emissions == 0) {
      Serial.printf("[ANT] status=%s | GPS 살아있음(nmea=%lu) 그러나 ANTSTATUS 미방출 | last: %s | boot+%lus\n",
        lastStatus, (unsigned long)nmeaCount, lastNmea, (unsigned long)((millis() - bootMs) / 1000));
    } else {
      uint32_t ago = lastRawMs ? (millis() - lastRawMs) / 1000 : 0;
      Serial.printf("[ANT] 현재=%s | ant방출=%lu(%lus전) | nmea=%lu | boot+%lus | raw: %s\n",
        lastStatus, (unsigned long)emissions, (unsigned long)ago,
        (unsigned long)nmeaCount, (unsigned long)((millis() - bootMs) / 1000), lastRaw);
    }
  }

  delay(5);
}
