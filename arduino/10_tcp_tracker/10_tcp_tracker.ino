// ESP32-C3 mini GPS 트래커 (안정화 버전)
//
// 09 대비 변경:
//   - HTTP POST를 SH* 스택 (07 스타일)로 회귀. CA* TCP는 1NCE/SIM7080G 조합에서
//     2회차 CAOPEN부터 자주 fail하는 것 확인 → 안정성 우선
//   - LTE 내장 GNSS는 fix 어려움 (트레이드오프 수용). L80-R 위주로 좌표 사용
//   - Serial 디버그 출력 (USB CDC ON Boot 가정)
//   - 스위치 wake/sleep, 자동 hard-reset 복구 로직 유지
//
// Arduino IDE Tools 설정 (필수):
//   USB CDC On Boot: ENABLED
//
// 배선: 09와 동일
//   OLED I2C: GPIO8(SDA), GPIO9(SCL)
//   GPS L80-R UART: ESP RX=GPIO20, TX=GPIO21, 9600
//   LTE SIM7080G UART: ESP RX=GPIO4, TX=GPIO2, 115200
//   PWRKEY=GPIO7, DTR=GPIO10, PWR_EN=GPIO6 (LOW=ON, HIGH=OFF)
//   배터리=GPIO3, 스위치=GPIO1 ↔ GND (active LOW)

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TinyGPSPlus.h>
#include <HardwareSerial.h>
#include <esp_sleep.h>
#include <driver/gpio.h>

// --- pins ---
#define PIN_SDA        8
#define PIN_SCL        9
#define OLED_ADDR      0x3C

#define PIN_PWR_EN     6 
#define PIN_PWRKEY     7
#define PIN_DTR        10
#define PIN_BAT        3
#define PIN_SWITCH     1

#define PIN_GPS_RX     20
#define PIN_GPS_TX     21
#define GPS_BAUD       9600

#define PIN_LTE_RX     4
#define PIN_LTE_TX     2
#define LTE_BAUD       115200

// --- 동작 파라미터 ---
#define APN_NAME            "iot.1nce.net"
#define POST_URL_HOST       "http://seriallog.com"
#define POST_PATH           "/gps-tracker/ingest"
#define POST_INTERVAL_MS    30000UL
#define BAT_DIV_RATIO       2.0f

#define SWITCH_PRESSED              LOW
#define BTN_DEBOUNCE_MS             30
#define BTN_HOLD_RELEASE_TIMEOUT_MS 5000
#define BTN_RELEASE_GRACE_MS        500

#define BRINGUP_RETRY_MS         30000UL
#define POST_FAIL_STREAK_REINIT  2     // 빠른 재초기화 (모듈 dead 의심 시)

// 디버그 출력 토글 (필요 없으면 0)
#define DBG  1
#define DBGLN(...)  do { if (DBG) Serial.println(__VA_ARGS__); } while (0)
#define DBGP(...)   do { if (DBG) Serial.print(__VA_ARGS__); } while (0)

Adafruit_SSD1306 display(128, 64, &Wire, -1);
TinyGPSPlus      gps;
HardwareSerial   gpsSerial(0);
HardwareSerial   lteSerial(1);

String lastResp;

RTC_DATA_ATTR uint32_t bootCount  = 0;
RTC_DATA_ATTR uint32_t awakeCount = 0;
RTC_DATA_ATTR uint32_t sleepCount = 0;

uint32_t ttAtOkMs    = 0;
uint32_t ttLteGnssMs = 0;
uint32_t ttL80GnssMs = 0;

struct NetStats {
  bool     lteReady       = false;
  int      csq            = -1;
  int      reg            = -1;
  char     ip[24]         = "-";
  uint32_t postTries      = 0;
  uint32_t postOks        = 0;
  int      lastStatus     = -1;
  uint32_t nextPostAt     = 0;
  uint8_t  failStreak     = 0;
  uint32_t nextBringUpAt  = 0;
  uint8_t  bringUpFails   = 0;   // 연속 bring-up 실패 (hard reset escalation)
} S;

struct LteGnss {
  bool     fix       = false;
  double   lat       = 0;
  double   lng       = 0;
  int      satView   = 0;
  int      satUsed   = 0;
} G;

// ================ util ================
static uint16_t readVbatMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(PIN_BAT);
  return (uint16_t)((sum / 16) * BAT_DIV_RATIO);
}

static const char* wakeReasonStr(esp_sleep_wakeup_cause_t c) {
  switch (c) {
    case ESP_SLEEP_WAKEUP_GPIO:      return "SW";
    case ESP_SLEEP_WAKEUP_EXT1:      return "EXT1";
    case ESP_SLEEP_WAKEUP_TIMER:     return "TIMER";
    case ESP_SLEEP_WAKEUP_UNDEFINED: return "RESET";
    default:                         return "OTHER";
  }
}

static void fmtTime(char *out, size_t n, uint32_t ms) {
  if (ms == 0) snprintf(out, n, "--");
  else if (ms < 60000) snprintf(out, n, "%.1fs", ms / 1000.0f);
  else snprintf(out, n, "%lum%02lus", (unsigned long)(ms / 60000), (unsigned long)((ms / 1000) % 60));
}

// ================ OLED ================
static void drawOled(esp_sleep_wakeup_cause_t cause) {
  char tAt[16], tLte[16], tL80[16];
  fmtTime(tAt,  sizeof(tAt),  ttAtOkMs);
  fmtTime(tLte, sizeof(tLte), ttLteGnssMs);
  fmtTime(tL80, sizeof(tL80), ttL80GnssMs);

  display.clearDisplay();
  display.setCursor(0, 0);
  display.print(F("boot#")); display.print(bootCount);
  display.print(F(" awk#")); display.print(awakeCount);
  display.print(F(" "));     display.println(wakeReasonStr(cause));

  display.print(F("AT  : ")); display.println(tAt);
  display.print(F("LTE : ")); display.println(tLte);
  display.print(F("L80 : ")); display.println(tL80);

  display.print(F("CSQ:")); display.print(S.csq);
  display.print(F(" REG:")); display.println(S.reg);

  display.print(F("POST ")); display.print(S.postOks);
  display.print('/'); display.print(S.postTries);
  display.print(F(" s=")); display.println(S.lastStatus);

  display.print(F("vbat ")); display.print(readVbatMv()); display.println(F(" mV"));
  display.print(F("up ")); display.print(millis() / 1000); display.print('s');
  display.display();
}

static void drawSleepBanner() {
  display.clearDisplay();
  display.setCursor(0, 16);
  display.setTextSize(2);
  display.println(F(" SLEEP"));
  display.println(F("  ..."));
  display.setTextSize(1);
  display.display();
}

// ================ LTE UART ================
static void drainLte() {
  while (lteSerial.available()) {
    char c = (char)lteSerial.read();
    lastResp += c;
    if (lastResp.length() > 2048) lastResp.remove(0, 1024);
  }
}

static bool sendAT(const char *cmd, const char *expect, uint32_t timeoutMs) {
  lastResp = "";
  if (cmd && *cmd) {
    if (DBG) { Serial.print(F(">> ")); Serial.println(cmd); }
    lteSerial.print(cmd);
    lteSerial.print("\r\n");
  }
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    drainLte();
    if (expect && lastResp.indexOf(expect) >= 0) {
      if (DBG) { Serial.print(F("<< ")); Serial.println(lastResp); }
      return true;
    }
    delay(5);
  }
  if (DBG && cmd && *cmd) {
    Serial.print(F("<< (timeout) ")); Serial.println(lastResp);
  }
  return expect == nullptr;
}

static void pulsePwrKey() {
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, HIGH);
  delay(100);
  digitalWrite(PIN_PWRKEY, LOW);
  delay(1500);
  digitalWrite(PIN_PWRKEY, HIGH);
}

static void ltePowerOn() {
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, LOW);
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, HIGH);
  delay(200);

  if (sendAT("AT", "OK", 1500)) return;

  DBGLN(F("[LTE] pulse PWRKEY"));
  pulsePwrKey();
  uint32_t t0 = millis();
  while (millis() - t0 < 5000) { drainLte(); delay(5); }
  sendAT("AT", "OK", 2000);
}

// ================ LTE bring-up ================
static bool lteBringUp() {
  if (!sendAT("AT", "OK", 2000)) return false;
  if (ttAtOkMs == 0) ttAtOkMs = millis();
  sendAT("ATE0", "OK", 1000);
  sendAT("AT+CMEE=2", "OK", 1000);
  sendAT("AT+CPIN?", "READY", 5000);

  if (sendAT("AT+CSQ", "+CSQ:", 1500)) {
    int p = lastResp.indexOf("+CSQ:");
    S.csq = lastResp.substring(p + 5).toInt();
  }

  uint32_t t0 = millis();
  while (millis() - t0 < 90000) {
    if (sendAT("AT+CEREG?", "OK", 2000)) {
      int p = lastResp.indexOf("+CEREG:");
      if (p >= 0) {
        int comma = lastResp.indexOf(',', p);
        if (comma >= 0) {
          S.reg = lastResp.substring(comma + 1).toInt();
          if (S.reg == 1 || S.reg == 5) break;
        }
      }
    }
    drawOled(esp_sleep_get_wakeup_cause());
    delay(2000);
  }
  if (S.reg != 1 && S.reg != 5) return false;

  sendAT("AT+CNACT=0,0", "OK", 3000);
  delay(300);
  String c = String("AT+CNCFG=0,1,\"") + APN_NAME + "\"";
  sendAT(c.c_str(), "OK", 2000);
  bool pdp = sendAT("AT+CNACT=0,1", "ACTIVE", 20000);

  if (sendAT("AT+CNACT?", "+CNACT:", 2000)) {
    int p = lastResp.indexOf("+CNACT: 0,");
    if (p >= 0) {
      int sp = p + 10;
      int stat = lastResp.substring(sp, sp + 1).toInt();
      if (stat == 1) pdp = true;
    }
    int q1 = lastResp.indexOf('"');
    int q2 = lastResp.indexOf('"', q1 + 1);
    if (q1 > 0 && q2 > q1) {
      String ip = lastResp.substring(q1 + 1, q2);
      ip.toCharArray(S.ip, sizeof(S.ip));
      if (ip.length() > 0 && ip != "0.0.0.0") pdp = true;
    }
  }

  S.lteReady = pdp;

  // 내장 GNSS 항상 ON 유지 (CA* TCP는 GNSS와 공존 가능)
  // 첫 부팅에선 cold start로 캐시 클리어 → 깨끗한 fix 획득 시도
  sendAT("AT+CGNSPWR=0", "OK", 2000);
  delay(200);
  sendAT("AT+CGNSCOLD", "OK", 2000);   // ephemeris/almanac 클리어
  sendAT("AT+CGNSPWR=1", "OK", 2000);
  return pdp;
}

// ================ LTE GNSS polling ================
static void pollLteGnss() {
  if (!sendAT("AT+CGNSINF", "+CGNSINF:", 2000)) return;
  int p = lastResp.indexOf("+CGNSINF:");
  if (p < 0) return;
  int cur = lastResp.indexOf(':', p) + 1;
  String tok[20];
  int idx = 0;
  while (cur < (int)lastResp.length() && idx < 20) {
    int nx = lastResp.indexOf(',', cur);
    if (nx < 0) { tok[idx++] = lastResp.substring(cur); break; }
    tok[idx++] = lastResp.substring(cur, nx);
    cur = nx + 1;
  }
  if (idx < 2) return;
  G.fix = (tok[1].toInt() == 1);
  if (G.fix) {
    if (idx > 4) {
      G.lat = tok[3].toFloat();
      G.lng = tok[4].toFloat();
    }
    if (ttLteGnssMs == 0) ttLteGnssMs = millis();
  }
  if (idx > 14) G.satView = tok[14].toInt();
  if (idx > 15) G.satUsed = tok[15].toInt();
}

// ================ HTTP POST (SIM7080G SH* 스택, 07 스타일) ================
// CGNSPWR=1 상태에선 SH* 가 "operation not allowed" 발생 → POST 직전 CGNSPWR=0,
// POST 끝나면 CGNSPWR=1 복귀. LTE 내장 GNSS는 fix 어려움 (트레이드오프 인정).
// 대신 POST 자체는 안정적.
//
// 05_1에서 검증한 안정화 적용:
//   - POST 시작 시 AT alive 체크 (dead면 즉시 abort, 외부 retry/hard-reset 위임)
//   - SH* 명령 사이 UART idle 대기 (이전 응답 잔재 깨끗이 비움)

// UART가 idleMs 동안 조용해질 때까지 대기 (들어오는 바이트는 폐기)
static void waitUartIdle(uint32_t idleMs, uint32_t maxWaitMs) {
  uint32_t lastByte = millis();
  uint32_t t0       = millis();
  while (millis() - t0 < maxWaitMs) {
    if (lteSerial.available()) {
      while (lteSerial.available()) {
        lteSerial.read();
        lastByte = millis();
      }
    }
    if (millis() - lastByte >= idleMs) return;
    delay(10);
  }
}

static bool sendBodyAfterPrompt(const char *body, uint32_t len) {
  uint32_t t0 = millis();
  lastResp = "";
  while (millis() - t0 < 3000) {
    drainLte();
    if (lastResp.indexOf('>') >= 0) break;
    delay(5);
  }
  if (lastResp.indexOf('>') < 0) return false;
  lteSerial.write((const uint8_t *)body, len);
  return sendAT("", "OK", 8000);
}

static bool httpPostJson(const char *host, const char *path,
                         const char *body, int *statusOut) {
  char cmd[96];
  *statusOut = -1;

  DBGLN(F("[POST] start (SH* HTTP)"));

  // 0. 모듈 alive 확인 — dead면 즉시 abort, 외부 retry/hard reset에 위임
  if (!sendAT("AT", "OK", 1500)) {
    DBGLN(F("[POST] module unresponsive, abort"));
    return false;
  }

  // 1. CGNSPWR off (SH* 충돌 회피)
  sendAT("AT+CGNSPWR=0", "OK", 2000);
  // UART이 잔여 URC 다 흘려보낼 때까지 대기
  waitUartIdle(300, 1500);

  sendAT("AT+SHDISC", nullptr, 800);
  waitUartIdle(200, 1000);

  snprintf(cmd, sizeof(cmd), "AT+SHCONF=\"URL\",\"%s\"", host);
  if (!sendAT(cmd, "OK", 2000)) { sendAT("AT+CGNSPWR=1", "OK", 2000); return false; }
  sendAT("AT+SHCONF=\"BODYLEN\",1024", "OK", 2000);
  sendAT("AT+SHCONF=\"HEADERLEN\",350", "OK", 2000);
  sendAT("AT+SHSSL=0,\"\"", "OK", 2000);

  if (!sendAT("AT+SHCONN", "OK", 20000)) {
    DBGLN(F("[POST] SHCONN fail"));
    sendAT("AT+SHDISC", nullptr, 2000);
    sendAT("AT+CGNSPWR=1", "OK", 2000);
    return false;
  }

  sendAT("AT+SHCHEAD", "OK", 2000);
  sendAT("AT+SHAHEAD=\"Content-Type\",\"application/json\"", "OK", 2000);

  size_t len = strlen(body);
  snprintf(cmd, sizeof(cmd), "AT+SHBOD=%u,10000", (unsigned)len);
  if (DBG) { Serial.print(F(">> ")); Serial.println(cmd); }
  lteSerial.print(cmd); lteSerial.print("\r\n");
  if (!sendBodyAfterPrompt(body, len)) {
    DBGLN(F("[POST] SHBOD fail"));
    sendAT("AT+SHDISC", "OK", 3000);
    sendAT("AT+CGNSPWR=1", "OK", 2000);
    return false;
  }

  snprintf(cmd, sizeof(cmd), "AT+SHREQ=\"%s\",3", path);
  if (!sendAT(cmd, "+SHREQ:", 30000)) {
    DBGLN(F("[POST] SHREQ fail"));
    sendAT("AT+SHDISC", "OK", 3000);
    sendAT("AT+CGNSPWR=1", "OK", 2000);
    return false;
  }

  int p = lastResp.indexOf("+SHREQ:");
  int c1 = lastResp.indexOf(',', p);
  int c2 = lastResp.indexOf(',', c1 + 1);
  if (statusOut && c1 > 0 && c2 > c1) {
    *statusOut = lastResp.substring(c1 + 1, c2).toInt();
  }
  DBGP(F("[POST] HTTP ")); DBGLN(*statusOut);

  sendAT("AT+SHDISC", "OK", 3000);
  sendAT("AT+CGNSPWR=1", "OK", 2000);
  return true;
}

// ================ payload ================
static void buildPayload(char *out, size_t cap) {
  uint32_t vbatMv = readVbatMv();
  bool l80fix = gps.location.isValid();

  char l80buf[128];
  if (l80fix) {
    snprintf(l80buf, sizeof(l80buf),
      "{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat\":%d,\"ttff_s\":%lu}",
      gps.location.lat(), gps.location.lng(),
      (int)gps.satellites.value(),
      (unsigned long)(ttL80GnssMs / 1000));
  } else {
    snprintf(l80buf, sizeof(l80buf),
      "{\"fix\":false,\"sat\":%d}", (int)gps.satellites.value());
  }

  char lteBuf[128];
  if (G.fix) {
    snprintf(lteBuf, sizeof(lteBuf),
      "{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat_used\":%d,\"sat_view\":%d,\"ttff_s\":%lu}",
      G.lat, G.lng, G.satUsed, G.satView,
      (unsigned long)(ttLteGnssMs / 1000));
  } else {
    snprintf(lteBuf, sizeof(lteBuf),
      "{\"fix\":false,\"sat_used\":%d,\"sat_view\":%d}", G.satUsed, G.satView);
  }

  snprintf(out, cap,
    "{\"ts\":%lu,\"boot\":%lu,\"awake\":%lu,\"csq\":%d,\"reg\":%d,"
    "\"vbat_mv\":%lu,\"at_ms\":%lu,\"l80\":%s,\"lte\":%s}",
    (unsigned long)(millis() / 1000),
    (unsigned long)bootCount,
    (unsigned long)awakeCount,
    S.csq, S.reg, (unsigned long)vbatMv,
    (unsigned long)ttAtOkMs,
    l80buf, lteBuf);
}

static void doPost() {
  char body[512];
  buildPayload(body, sizeof(body));
  if (DBG) { Serial.print(F("[POST body] ")); Serial.println(body); }

  S.postTries++;
  int status = -1;
  if (httpPostJson(POST_URL_HOST, POST_PATH, body, &status)) {
    S.lastStatus = status;
    if (status == 200) S.postOks++;
  } else {
    S.lastStatus = -1;
  }
}

// ================ 스위치 ================
static bool buttonWasPressed() {
  if (digitalRead(PIN_SWITCH) != SWITCH_PRESSED) return false;
  delay(BTN_DEBOUNCE_MS);
  if (digitalRead(PIN_SWITCH) != SWITCH_PRESSED) return false;

  uint32_t t0 = millis();
  while (digitalRead(PIN_SWITCH) == SWITCH_PRESSED && millis() - t0 < BTN_HOLD_RELEASE_TIMEOUT_MS) {
    delay(10);
  }
  uint32_t g0 = millis();
  while (millis() - g0 < BTN_RELEASE_GRACE_MS) {
    if (digitalRead(PIN_SWITCH) == SWITCH_PRESSED) return false;
    delay(10);
  }
  return true;
}

static void enterDeepSleep() {
  sleepCount++;

  drawSleepBanner();
  delay(500);
  display.ssd1306_command(SSD1306_DISPLAYOFF);

  digitalWrite(PIN_PWR_EN, HIGH);

  gpio_pulldown_dis((gpio_num_t)PIN_SWITCH);
  gpio_pullup_en((gpio_num_t)PIN_SWITCH);
  esp_deep_sleep_enable_gpio_wakeup(1ULL << PIN_SWITCH, ESP_GPIO_WAKEUP_GPIO_LOW);
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_TIMER);

  esp_deep_sleep_start();
}

// ================ setup/loop ================
void setup() {
  bootCount++;

  Serial.begin(115200);
  delay(200);
  DBGLN();
  DBGLN(F("=== 10_tcp_tracker boot ==="));

  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);

  pinMode(PIN_SWITCH, INPUT_PULLUP);

  analogReadResolution(12);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  if (cause == ESP_SLEEP_WAKEUP_GPIO || cause == ESP_SLEEP_WAKEUP_EXT1) {
    awakeCount++;
  }

  drawOled(cause);

  // 스위치 release 대기 + grace
  uint32_t t0 = millis();
  while (digitalRead(PIN_SWITCH) == SWITCH_PRESSED && millis() - t0 < BTN_HOLD_RELEASE_TIMEOUT_MS) {
    delay(10);
  }
  uint32_t g0 = millis();
  while (millis() - g0 < BTN_RELEASE_GRACE_MS) {
    if (digitalRead(PIN_SWITCH) == SWITCH_PRESSED) { g0 = millis(); }
    delay(10);
  }

  gpsSerial.setRxBufferSize(1024);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);

  lteSerial.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);
  ltePowerOn();

  lteBringUp();

  S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;
  S.nextPostAt    = millis() + 2000;
}

void loop() {
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();

  while (gpsSerial.available()) {
    char c = (char)gpsSerial.read();
    if (gps.encode(c)) {
      if (ttL80GnssMs == 0 && gps.location.isValid()) {
        ttL80GnssMs = millis();
        DBGLN(F("[L80] first fix"));
      }
    }
  }

  if (!S.lteReady) {
    if ((int32_t)(millis() - S.nextBringUpAt) >= 0) {
      DBGP(F("[LTE] retry bring-up (fails=")); DBGP(S.bringUpFails); DBGLN(F(")"));

      // 3회 이상 연속 실패 → hard reset 시도 (PWRKEY 토글)
      if (S.bringUpFails >= 3) {
        DBGLN(F("[LTE] HARD RESET via PWRKEY toggle"));
        pulsePwrKey();             // off
        delay(3000);
        pulsePwrKey();             // on
        delay(5000);
        S.bringUpFails = 0;
      }

      // ltePowerOn은 AT 무응답이면 PWRKEY 펄스 시도하므로 단순 lteBringUp만 부르는 것보다 강함
      ltePowerOn();
      lteBringUp();

      S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;
      if (S.lteReady) {
        S.bringUpFails = 0;
        S.nextPostAt   = millis() + 2000;
      } else {
        S.bringUpFails++;
      }
    }
  } else {
    if ((int32_t)(millis() - S.nextPostAt) >= 0) {
      pollLteGnss();
      doPost();
      S.nextPostAt = millis() + POST_INTERVAL_MS;

      if (S.lastStatus != 200) {
        S.failStreak++;
        if (S.failStreak >= POST_FAIL_STREAK_REINIT) {
          DBGLN(F("[LTE] fail streak -> reinit"));
          S.lteReady      = false;
          S.failStreak    = 0;
          S.nextBringUpAt = millis();
        }
      } else {
        S.failStreak = 0;
      }
    }
  }

  if (buttonWasPressed()) {
    enterDeepSleep();
    return;
  }

  static uint32_t lastDraw = 0;
  if (millis() - lastDraw > 500) {
    lastDraw = millis();
    drawOled(cause);
  }

  drainLte();
  delay(10);
}
