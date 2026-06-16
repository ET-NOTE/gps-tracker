// 11_final_tracker — ESP32-C3 mini GPS 트래커 (스위치 wake/sleep, 자이로 X)
//
// 동작 흐름:
//   부팅/wake → D6=LOW(모듈 ON) → SIM7080G bring-up → L80-R NMEA 수신 시작
//   30초 주기 SH* HTTP POST (좌표 + 진단 정보)
//   GPIO1 스위치 누름 → Deep Sleep (D6=HIGH로 모듈 차단)
//   GPIO1 다시 누름 → wake → 위 흐름 반복
//
// 모듈 분담 (확정):
//   L80-R    : GPS 좌표 (외장, MT3339, 감도 우위)
//   SIM7080G : LTE 데이터 업링크 (SH* HTTP POST)
//   SIM7080G 내장 GNSS : 사용 안 함 (SH* HTTP와 자원 충돌, 의도적 배제)
//
// 트레이드오프 메모:
//   - SH*는 CGNSPWR=1 상태에서 "operation not allowed"로 막힘 → 매 POST 직전 OFF
//   - 그래서 LTE GNSS는 사실상 못 잡음 (cycling으로 cold start 강제)
//   - L80-R 단일 GPS 채택, LTE는 데이터 전송 전담
//
// 알려진 망 이슈 (1NCE):
//   - 백엔드에서 PDP 자주 churning → 장시간 idle TCP 끊김
//   - "wake → 짧은 awake에서 1~2회 POST → sleep" 패턴이 가장 안정
//
// Arduino IDE Tools:
//   USB CDC On Boot: ENABLED   (Serial=USB, UART0 해방되어 GPS에 사용)
//
// 배선:
//   OLED I2C  : GPIO8(SDA), GPIO9(SCL), 0x3C
//   GPS L80-R : ESP RX=GPIO20, TX=GPIO21, 9600 (UART0)
//   SIM7080G  : ESP RX=GPIO4,  TX=GPIO2,  115200 (UART1)
//   PWRKEY=GPIO7, DTR=GPIO10, PWR_EN=GPIO6 (LOW=모듈ON, HIGH=차단)
//   배터리 ADC=GPIO3, 분압비 2.0
//   스위치=GPIO1 ↔ GND (active LOW), 내부 PULLUP

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TinyGPSPlus.h>
#include <HardwareSerial.h>
#include <esp_sleep.h>
#include <driver/gpio.h>

// =================================================================
// 핀 정의
// =================================================================
#define PIN_SDA        8
#define PIN_SCL        9
#define OLED_ADDR      0x3C

#define PIN_PWR_EN     6      // 모듈 전원 (LOW=ON, HIGH=OFF)
#define PIN_PWRKEY     7      // SIM7080G PWRKEY
#define PIN_DTR        10
#define PIN_BAT        3      // 배터리 ADC
#define PIN_SWITCH     1      // 스위치 (active LOW)

#define PIN_GPS_RX     20
#define PIN_GPS_TX     21
#define GPS_BAUD       9600

#define PIN_LTE_RX     4
#define PIN_LTE_TX     2
#define LTE_BAUD       115200

// =================================================================
// 동작 파라미터
// =================================================================
#define APN_NAME            "iot.1nce.net"
#define POST_URL_HOST       "http://seriallog.com"
#define POST_PATH           "/gps-tracker/ingest"
#define POST_INTERVAL_MS    30000UL
#define BAT_DIV_RATIO       2.0f

// 스위치 디바운스
#define SWITCH_PRESSED              LOW
#define BTN_DEBOUNCE_MS             30
#define BTN_HOLD_RELEASE_TIMEOUT_MS 5000
#define BTN_RELEASE_GRACE_MS        500

// 자동 복구
#define BRINGUP_RETRY_MS            30000UL
#define POST_FAIL_STREAK_REINIT     2     // 연속 N회 실패 시 풀 reinit
#define BRINGUP_FAIL_HARD_RESET     3     // bring-up 연속 N회 실패 시 PWRKEY hard reset

// Serial 디버그
#define DBG  1
#define DBGLN(...)  do { if (DBG) Serial.println(__VA_ARGS__); } while (0)
#define DBGP(...)   do { if (DBG) Serial.print(__VA_ARGS__); } while (0)

// =================================================================
// 객체 / 상태
// =================================================================
Adafruit_SSD1306 display(128, 64, &Wire, -1);
TinyGPSPlus      gps;
HardwareSerial   gpsSerial(0);    // UART0 (USB CDC ENABLED라 free)
HardwareSerial   lteSerial(1);

String lastResp;

// RTC 메모리 (deep sleep 건너 유지)
RTC_DATA_ATTR uint32_t bootCount  = 0;
RTC_DATA_ATTR uint32_t awakeCount = 0;
RTC_DATA_ATTR uint32_t sleepCount = 0;

// 이번 wake의 타이밍 (매 wake마다 0에서 시작)
uint32_t ttAtOkMs    = 0;
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
  uint8_t  failStreak     = 0;     // POST 연속 실패
  uint32_t nextBringUpAt  = 0;
  uint8_t  bringUpFails   = 0;     // bring-up 연속 실패
} S;

// =================================================================
// util
// =================================================================
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
  if (ms == 0)        snprintf(out, n, "--");
  else if (ms < 60000) snprintf(out, n, "%.1fs", ms / 1000.0f);
  else                 snprintf(out, n, "%lum%02lus",
                                (unsigned long)(ms / 60000),
                                (unsigned long)((ms / 1000) % 60));
}

// =================================================================
// OLED
// =================================================================
static void drawOled(esp_sleep_wakeup_cause_t cause) {
  char tAt[16], tL80[16];
  fmtTime(tAt,  sizeof(tAt),  ttAtOkMs);
  fmtTime(tL80, sizeof(tL80), ttL80GnssMs);

  display.clearDisplay();
  display.setCursor(0, 0);
  display.print(F("boot#")); display.print(bootCount);
  display.print(F(" awk#")); display.print(awakeCount);
  display.print(F(" "));     display.println(wakeReasonStr(cause));

  display.print(F("AT  : ")); display.println(tAt);
  display.print(F("L80 : ")); display.println(tL80);

  display.print(F("CSQ:"));   display.print(S.csq);
  display.print(F(" REG:"));  display.println(S.reg);

  display.print(F("POST "));  display.print(S.postOks);
  display.print('/');         display.print(S.postTries);
  display.print(F(" s="));    display.println(S.lastStatus);

  display.print(F("vbat "));  display.print(readVbatMv());
  display.println(F(" mV"));

  display.print(F("up "));    display.print(millis() / 1000);
  display.print('s');
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

// =================================================================
// LTE UART helpers
// =================================================================
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

static void waitUartIdle(uint32_t idleMs, uint32_t maxWaitMs) {
  uint32_t lastByte = millis();
  uint32_t t0       = millis();
  while (millis() - t0 < maxWaitMs) {
    while (lteSerial.available()) {
      lteSerial.read();
      lastByte = millis();
    }
    if (millis() - lastByte >= idleMs) return;
    delay(10);
  }
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

  if (sendAT("AT", "OK", 1500)) {
    DBGLN(F("[LTE] already on"));
    return;
  }
  DBGLN(F("[LTE] pulse PWRKEY"));
  pulsePwrKey();
  uint32_t t0 = millis();
  while (millis() - t0 < 5000) { drainLte(); delay(5); }
  sendAT("AT", "OK", 2000);
}

// =================================================================
// LTE bring-up: AT → SIM → 망등록 → PDP 활성화
// =================================================================
static bool lteBringUp() {
  if (!sendAT("AT", "OK", 2000)) return false;
  if (ttAtOkMs == 0) ttAtOkMs = millis();
  sendAT("ATE0", "OK", 1000);
  sendAT("AT+CMEE=2", "OK", 1000);
  sendAT("AT+CPIN?", "READY", 5000);

  // 이전 세션에서 GNSS 켜진 채 남아있을 수 있음 (Jinyushi 외부 전원이라 모듈이 실제 power-cycle 안됨)
  // SH*는 CGNSPWR=1과 충돌하므로 명시적으로 OFF 보장
  sendAT("AT+CGNSPWR=0", "OK", 2000);

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
  return pdp;
}

// =================================================================
// HTTP POST (SIM7080G SH* 스택)
// =================================================================
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

  // 모듈 alive 빠른 검증 — dead면 즉시 abort, 외부 retry로 위임
  if (!sendAT("AT", "OK", 1500)) {
    DBGLN(F("[POST] module unresponsive, abort"));
    return false;
  }

  // 방어: 어떤 경로로든 GNSS 켜져있으면 SH*가 막히므로 강제 OFF
  sendAT("AT+CGNSPWR=0", "OK", 1000);
  waitUartIdle(200, 1000);

  sendAT("AT+SHDISC", nullptr, 800);
  waitUartIdle(200, 1000);

  snprintf(cmd, sizeof(cmd), "AT+SHCONF=\"URL\",\"%s\"", host);
  if (!sendAT(cmd, "OK", 2000)) return false;
  sendAT("AT+SHCONF=\"BODYLEN\",1024",  "OK", 2000);
  sendAT("AT+SHCONF=\"HEADERLEN\",350", "OK", 2000);
  sendAT("AT+SHSSL=0,\"\"", "OK", 2000);

  if (!sendAT("AT+SHCONN", "OK", 20000)) {
    DBGLN(F("[POST] SHCONN fail"));
    sendAT("AT+SHDISC", nullptr, 2000);
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
    return false;
  }

  snprintf(cmd, sizeof(cmd), "AT+SHREQ=\"%s\",3", path);
  if (!sendAT(cmd, "+SHREQ:", 30000)) {
    DBGLN(F("[POST] SHREQ fail"));
    sendAT("AT+SHDISC", "OK", 3000);
    return false;
  }

  int p  = lastResp.indexOf("+SHREQ:");
  int c1 = lastResp.indexOf(',', p);
  int c2 = lastResp.indexOf(',', c1 + 1);
  if (statusOut && c1 > 0 && c2 > c1) {
    *statusOut = lastResp.substring(c1 + 1, c2).toInt();
  }
  DBGP(F("[POST] HTTP ")); DBGLN(*statusOut);

  sendAT("AT+SHDISC", "OK", 3000);
  return true;
}

// =================================================================
// payload (L80-R 단독)
// =================================================================
static void buildPayload(char *out, size_t cap) {
  uint32_t vbatMv = readVbatMv();
  bool l80fix = gps.location.isValid();

  if (l80fix) {
    snprintf(out, cap,
      "{\"ts\":%lu,\"boot\":%lu,\"awake\":%lu,\"csq\":%d,\"reg\":%d,"
      "\"vbat_mv\":%lu,\"at_ms\":%lu,"
      "\"l80\":{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat\":%d,\"ttff_s\":%lu}}",
      (unsigned long)(millis() / 1000),
      (unsigned long)bootCount, (unsigned long)awakeCount,
      S.csq, S.reg, (unsigned long)vbatMv, (unsigned long)ttAtOkMs,
      gps.location.lat(), gps.location.lng(),
      (int)gps.satellites.value(),
      (unsigned long)(ttL80GnssMs / 1000));
  } else {
    snprintf(out, cap,
      "{\"ts\":%lu,\"boot\":%lu,\"awake\":%lu,\"csq\":%d,\"reg\":%d,"
      "\"vbat_mv\":%lu,\"at_ms\":%lu,"
      "\"l80\":{\"fix\":false,\"sat\":%d}}",
      (unsigned long)(millis() / 1000),
      (unsigned long)bootCount, (unsigned long)awakeCount,
      S.csq, S.reg, (unsigned long)vbatMv, (unsigned long)ttAtOkMs,
      (int)gps.satellites.value());
  }
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

// =================================================================
// 스위치 디바운스
// =================================================================
static bool buttonWasPressed() {
  if (digitalRead(PIN_SWITCH) != SWITCH_PRESSED) return false;
  delay(BTN_DEBOUNCE_MS);
  if (digitalRead(PIN_SWITCH) != SWITCH_PRESSED) return false;

  uint32_t t0 = millis();
  while (digitalRead(PIN_SWITCH) == SWITCH_PRESSED &&
         millis() - t0 < BTN_HOLD_RELEASE_TIMEOUT_MS) {
    delay(10);
  }
  uint32_t g0 = millis();
  while (millis() - g0 < BTN_RELEASE_GRACE_MS) {
    if (digitalRead(PIN_SWITCH) == SWITCH_PRESSED) return false;
    delay(10);
  }
  return true;
}

// =================================================================
// Deep Sleep
// =================================================================
static void enterDeepSleep() {
  sleepCount++;
  DBGLN(F("[SLEEP] entering deep sleep"));

  drawSleepBanner();
  delay(500);
  display.ssd1306_command(SSD1306_DISPLAYOFF);

  // 모듈 전원 차단 (D6 HIGH)
  digitalWrite(PIN_PWR_EN, HIGH);

  // GPIO1 LOW 레벨로 wake (스위치 누름 = pullup → GND로 떨어짐)
  gpio_pulldown_dis((gpio_num_t)PIN_SWITCH);
  gpio_pullup_en((gpio_num_t)PIN_SWITCH);
  esp_deep_sleep_enable_gpio_wakeup(1ULL << PIN_SWITCH, ESP_GPIO_WAKEUP_GPIO_LOW);
  // (TIMER wake는 enable 안 했으므로 disable 호출 불필요 - ESP-IDF 경고 회피)

  esp_deep_sleep_start();
  // 깨어나면 setup부터 재실행. 여기 이후는 도달 안함.
}

// =================================================================
// setup / loop
// =================================================================
void setup() {
  bootCount++;

  Serial.begin(115200);
  delay(200);
  DBGLN();
  DBGLN(F("=== 11_final_tracker boot ==="));

  // 모듈 전원 즉시 ON
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);

  // 스위치 입력
  pinMode(PIN_SWITCH, INPUT_PULLUP);

  // ADC / OLED
  analogReadResolution(12);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  // wake 원인 파악 (스위치로 깨어났으면 awakeCount++)
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  if (cause == ESP_SLEEP_WAKEUP_GPIO || cause == ESP_SLEEP_WAKEUP_EXT1) {
    awakeCount++;
  }
  drawOled(cause);

  // 스위치 release + grace (즉시 재-sleep 방지)
  uint32_t t0 = millis();
  while (digitalRead(PIN_SWITCH) == SWITCH_PRESSED &&
         millis() - t0 < BTN_HOLD_RELEASE_TIMEOUT_MS) {
    delay(10);
  }
  uint32_t g0 = millis();
  while (millis() - g0 < BTN_RELEASE_GRACE_MS) {
    if (digitalRead(PIN_SWITCH) == SWITCH_PRESSED) { g0 = millis(); }
    delay(10);
  }

  // GPS UART 시작 (ttL80 측정 시작 시점)
  gpsSerial.setRxBufferSize(1024);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);

  // LTE UART + 전원
  lteSerial.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);
  ltePowerOn();

  // bring-up (실패해도 OK, loop에서 재시도)
  lteBringUp();

  S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;
  S.nextPostAt    = millis() + 2000;
}

void loop() {
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();

  // GPS 피드 (non-blocking)
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
    // bring-up 재시도. 누적 실패 많으면 PWRKEY hard reset
    if ((int32_t)(millis() - S.nextBringUpAt) >= 0) {
      DBGP(F("[LTE] retry bring-up (fails="));
      DBGP(S.bringUpFails); DBGLN(F(")"));

      if (S.bringUpFails >= BRINGUP_FAIL_HARD_RESET) {
        DBGLN(F("[LTE] HARD RESET via PWRKEY toggle"));
        pulsePwrKey();
        delay(3000);
        pulsePwrKey();
        delay(5000);
        S.bringUpFails = 0;
      }

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
    // POST 타이밍
    if ((int32_t)(millis() - S.nextPostAt) >= 0) {
      doPost();
      S.nextPostAt = millis() + POST_INTERVAL_MS;

      // POST 연속 실패 → 풀 reinit 트리거
      if (S.lastStatus != 200) {
        S.failStreak++;
        if (S.failStreak >= POST_FAIL_STREAK_REINIT) {
          DBGLN(F("[LTE] POST fail streak → reinit"));
          S.lteReady      = false;
          S.failStreak    = 0;
          S.nextBringUpAt = millis();
        }
      } else {
        S.failStreak = 0;
      }
    }
  }

  // 스위치 → deep sleep
  if (buttonWasPressed()) {
    enterDeepSleep();
    return;
  }

  // OLED 0.5s 갱신
  static uint32_t lastDraw = 0;
  if (millis() - lastDraw > 500) {
    lastDraw = millis();
    drawOled(cause);
  }

  drainLte();
  delay(10);
}
