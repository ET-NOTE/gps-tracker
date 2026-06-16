// ESP32-C3 mini GPS 트래커 — 07(LTE/GPS POST) + 08(Switch Deep Sleep) 통합
//
// 사이클:
//   부팅 → GPS+LTE 전원 ON → LTE bring-up → 이중 GPS fix 대기 → 주기 POST
//   스위치(GPIO1 active LOW) 누름 → Deep Sleep (모듈 전원 차단)
//   스위치 다시 누름 → 재부팅 → 반복
//
// OLED 표시 (좌표 X, 서버 대시보드에서 확인):
//   boot/awake 카운트, wake 사유
//   AT OK까지 걸린 시간 (ms→s)
//   LTE 내장 GNSS 첫 fix까지 걸린 시간
//   L80-R 첫 fix까지 걸린 시간
//   CSQ/REG/POST 통계, VBAT, uptime
//
// 배선:
//   OLED I2C: GPIO8(SDA), GPIO9(SCL), 0x3C
//   GPS L80-R UART: ESP RX=GPIO20, TX=GPIO21, 9600
//   LTE SIM7080G UART: ESP RX=GPIO4, TX=GPIO2, 115200
//   PWRKEY=GPIO7, DTR=GPIO10, PWR_EN=GPIO6 (LOW=ON, HIGH=OFF)
//   배터리 ADC=GPIO3, 분압비 2.0
//   스위치=GPIO1 ↔ GND (active LOW), 내부 PULLUP
//
// Arduino IDE Tools:
//   USB CDC On Boot: ENABLED (UART0 해방해서 GPS에 배정)

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

// 스위치 디바운스
#define SWITCH_PRESSED       LOW
#define BTN_DEBOUNCE_MS      30
#define BTN_HOLD_RELEASE_TIMEOUT_MS 5000
#define BTN_RELEASE_GRACE_MS 500

// 자동 복구
#define BRINGUP_RETRY_MS         30000UL  // lteReady=false일 때 재시도 간격
#define POST_FAIL_STREAK_REINIT  3        // 이 횟수 이상 POST 연속 실패 시 재-bring-up

Adafruit_SSD1306 display(128, 64, &Wire, -1);
TinyGPSPlus      gps;
HardwareSerial   gpsSerial(0);
HardwareSerial   lteSerial(1);

String lastResp;

// RTC 메모리 — 딥슬립 건너 유지
RTC_DATA_ATTR uint32_t bootCount  = 0;
RTC_DATA_ATTR uint32_t awakeCount = 0;
RTC_DATA_ATTR uint32_t sleepCount = 0;

// 이번 wake 동안의 타이밍 (매 wake마다 리셋)
uint32_t wakeStartMs  = 0;     // setup 시작 시점 millis (항상 0, 참고용)
uint32_t ttAtOkMs     = 0;     // AT에 OK 돌아온 시점 (from wake)
uint32_t ttLteGnssMs  = 0;     // LTE 내장 GNSS 첫 fix 시점
uint32_t ttL80GnssMs  = 0;     // L80-R TinyGPS isValid() 첫 true 시점

struct NetStats {
  bool     lteReady     = false;
  int      csq          = -1;
  int      reg          = -1;
  char     ip[24]       = "-";
  uint32_t postTries    = 0;
  uint32_t postOks      = 0;
  int      lastStatus   = -1;
  uint32_t nextPostAt   = 0;
  uint8_t  failStreak   = 0;
  uint32_t nextBringUpAt = 0;
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
  if (ms == 0) {
    snprintf(out, n, "--");
  } else if (ms < 60000) {
    snprintf(out, n, "%.1fs", ms / 1000.0f);
  } else {
    snprintf(out, n, "%lum%02lus", (unsigned long)(ms / 60000), (unsigned long)((ms / 1000) % 60));
  }
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
  display.print(F(" ")); display.println(wakeReasonStr(cause));

  display.print(F("AT  : ")); display.println(tAt);
  display.print(F("LTE : ")); display.println(tLte);
  display.print(F("L80 : ")); display.println(tL80);

  display.print(F("CSQ:")); display.print(S.csq);
  display.print(F(" REG:")); display.println(S.reg);

  display.print(F("POST ")); display.print(S.postOks);
  display.print('/'); display.print(S.postTries);
  display.print(F(" s=")); display.println(S.lastStatus);

  display.print(F("vbat ")); display.print(readVbatMv()); display.println(F(" mV"));

  display.print(F("up "));
  display.print(millis() / 1000); display.print('s');
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

// ================ LTE UART helpers ================
static void drainLte() {
  while (lteSerial.available()) {
    char c = (char)lteSerial.read();
    lastResp += c;
    if (lastResp.length() > 1024) lastResp.remove(0, 512);
  }
}

static bool sendAT(const char *cmd, const char *expect, uint32_t timeoutMs) {
  lastResp = "";
  if (cmd && *cmd) {
    lteSerial.print(cmd);
    lteSerial.print("\r\n");
  }
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    drainLte();
    if (expect && lastResp.indexOf(expect) >= 0) return true;
    delay(5);
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

  if (sendAT("AT", "OK", 1500)) return;     // 이미 깨어있음

  pulsePwrKey();
  uint32_t t0 = millis();
  while (millis() - t0 < 5000) { drainLte(); delay(5); }
  sendAT("AT", "OK", 2000);
}

// ================ LTE bring-up ================
static bool lteBringUp() {
  if (!sendAT("AT", "OK", 2000)) return false;
  if (ttAtOkMs == 0) ttAtOkMs = millis();          // AT OK 도달 시각 기록
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

  // 내장 GNSS 켜기
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

// ================ HTTP POST (SIM7080G SH* 스택) ================
// 주의: CGNSPWR=1 상태에서 SH* 실행 시 "operation not allowed" 에러 발생 (펌웨어 버그).
// 회피책: POST 직전 CGNSPWR=0, POST 후 CGNSPWR=1.
// 단점: 매 POST마다 GNSS 재시작 → LTE 내장 GNSS가 fix 획득 어려움.
// (07 스케치와 동일 방식. LTE GNSS 좌표는 가끔만 들어옴)
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

  // GNSS off — SH* 충돌 회피
  sendAT("AT+CGNSPWR=0", "OK", 2000);
  delay(200);

  sendAT("AT+SHDISC", nullptr, 800);

  snprintf(cmd, sizeof(cmd), "AT+SHCONF=\"URL\",\"%s\"", host);
  if (!sendAT(cmd, "OK", 2000)) { sendAT("AT+CGNSPWR=1", "OK", 2000); return false; }
  sendAT("AT+SHCONF=\"BODYLEN\",1024", "OK", 2000);
  sendAT("AT+SHCONF=\"HEADERLEN\",350", "OK", 2000);
  sendAT("AT+SHSSL=0,\"\"", "OK", 2000);

  if (!sendAT("AT+SHCONN", "OK", 20000)) {
    sendAT("AT+SHDISC", nullptr, 2000);
    sendAT("AT+CGNSPWR=1", "OK", 2000);
    return false;
  }

  sendAT("AT+SHCHEAD", "OK", 2000);
  sendAT("AT+SHAHEAD=\"Content-Type\",\"application/json\"", "OK", 2000);

  size_t len = strlen(body);
  snprintf(cmd, sizeof(cmd), "AT+SHBOD=%u,10000", (unsigned)len);
  lteSerial.print(cmd); lteSerial.print("\r\n");
  if (!sendBodyAfterPrompt(body, len)) {
    sendAT("AT+SHDISC", "OK", 3000);
    sendAT("AT+CGNSPWR=1", "OK", 2000);
    return false;
  }

  snprintf(cmd, sizeof(cmd), "AT+SHREQ=\"%s\",3", path);
  if (!sendAT(cmd, "+SHREQ:", 30000)) {
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

  // 모듈 전원 차단
  digitalWrite(PIN_PWR_EN, HIGH);

  // GPIO1 pullup, LOW 레벨 wake
  gpio_pulldown_dis((gpio_num_t)PIN_SWITCH);
  gpio_pullup_en((gpio_num_t)PIN_SWITCH);
  esp_deep_sleep_enable_gpio_wakeup(1ULL << PIN_SWITCH, ESP_GPIO_WAKEUP_GPIO_LOW);
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_TIMER);

  esp_deep_sleep_start();
}

// ================ setup/loop ================
void setup() {
  wakeStartMs = millis();
  bootCount++;

  // 1) 모듈 전원 즉시 ON
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);

  // 2) 스위치 입력 + 풀업
  pinMode(PIN_SWITCH, INPUT_PULLUP);

  // 3) ADC / OLED
  analogReadResolution(12);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  // 4) wake 원인 (SW로 깨어나면 awakeCount++)
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  if (cause == ESP_SLEEP_WAKEUP_GPIO || cause == ESP_SLEEP_WAKEUP_EXT1) {
    awakeCount++;
  }

  drawOled(cause);

  // 5) 스위치 release + grace (즉시 재-sleep 방지)
  uint32_t t0 = millis();
  while (digitalRead(PIN_SWITCH) == SWITCH_PRESSED && millis() - t0 < BTN_HOLD_RELEASE_TIMEOUT_MS) {
    delay(10);
  }
  uint32_t g0 = millis();
  while (millis() - g0 < BTN_RELEASE_GRACE_MS) {
    if (digitalRead(PIN_SWITCH) == SWITCH_PRESSED) { g0 = millis(); }
    delay(10);
  }

  // 6) GPS UART 시작 (ttL80 타이밍 이 시점부터 측정)
  gpsSerial.setRxBufferSize(1024);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);

  // 7) LTE UART + 전원
  lteSerial.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);
  ltePowerOn();

  // 8) LTE bring-up (ttAt, ttLte 타이밍 내부 기록)
  //    실패해도 OK. loop에서 주기적으로 재시도.
  lteBringUp();

  S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;
  S.nextPostAt    = millis() + 2000;   // 첫 POST는 2초 뒤 시도
}

void loop() {
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();

  // GPS 피드 (non-blocking)
  while (gpsSerial.available()) {
    char c = (char)gpsSerial.read();
    if (gps.encode(c)) {
      if (ttL80GnssMs == 0 && gps.location.isValid()) {
        ttL80GnssMs = millis();
      }
    }
  }

  if (!S.lteReady) {
    // bring-up 재시도 (초기 실패 or 후천적 드랍 모두 커버)
    if ((int32_t)(millis() - S.nextBringUpAt) >= 0) {
      lteBringUp();
      S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;
      if (S.lteReady) {
        S.nextPostAt = millis() + 2000;   // 살아나면 바로 POST 시도
      }
    }
  } else {
    // POST 타이밍
    if ((int32_t)(millis() - S.nextPostAt) >= 0) {
      pollLteGnss();
      doPost();
      S.nextPostAt = millis() + POST_INTERVAL_MS;

      // 연속 실패시 재-bring-up 강제
      if (S.lastStatus != 200) {
        S.failStreak++;
        if (S.failStreak >= POST_FAIL_STREAK_REINIT) {
          S.lteReady      = false;
          S.failStreak    = 0;
          S.nextBringUpAt = millis();   // 즉시 재시도
        }
      } else {
        S.failStreak = 0;
      }
    }
  }

  // 스위치 → deep sleep
  if (buttonWasPressed()) {
    enterDeepSleep();
    return;  // 도달 안함
  }

  // OLED 주기 갱신
  static uint32_t lastDraw = 0;
  if (millis() - lastDraw > 500) {
    lastDraw = millis();
    drawOled(cause);
  }

  drainLte();
  delay(10);
}
