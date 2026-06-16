// 12_continuous_tracker — 누적 데이터 수집 모드 (Always-Awake)
//
// 11_final_tracker 와의 차이:
//   - Deep sleep 제거. 전원 인가 시 항상 awake.
//   - POST 간격 단축: 15s (기본). 통신 안정 가정 (USB 5V 상시).
//   - 스위치는 동작에 영향 없음 (보드 디버그용으로만 핀 정의 유지).
//   - OLED 초점: 세션 누적 (POST count, 성공/실패, last status, fail streak).
//   - 영구 운용을 가정하므로 POST 연속 실패 시 PDP 재활성 → bring-up 재시도 → PWRKEY hard reset 의 3단 회복.
//
// 그 외 (모듈 분담, 핀, SH* HTTP, GNSS=OFF) 는 11_ 와 동일.
//
// Arduino IDE Tools:
//   USB CDC On Boot: ENABLED   (Serial=USB, UART0 해방되어 GPS에 사용)
//
// 배선 (11_와 동일):
//   OLED I2C  : GPIO8(SDA), GPIO9(SCL), 0x3C
//   GPS L80-R : ESP RX=GPIO20, TX=GPIO21, 9600 (UART0)
//   SIM7080G  : ESP RX=GPIO4,  TX=GPIO2,  115200 (UART1)
//   PWRKEY=GPIO7, DTR=GPIO10, PWR_EN=GPIO6 (LOW=모듈ON)
//   배터리 ADC=GPIO3, 분압비 2.0
//   스위치=GPIO1 (이번 빌드에서는 미사용)

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TinyGPSPlus.h>
#include <HardwareSerial.h>
#include <WiFi.h>   // WiFi.macAddress() — device_uid 안정화용

// =================================================================
// 핀 정의
// =================================================================
#define PIN_SDA        8
#define PIN_SCL        9
#define OLED_ADDR      0x3C

#define PIN_PWR_EN     6
#define PIN_PWRKEY     7
#define PIN_DTR        10
#define PIN_BAT        3
#define PIN_SWITCH     1   // 이번 빌드 미사용

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
#define POST_INTERVAL_MS    15000UL          // 11_의 30s에서 단축
#define BAT_DIV_RATIO       2.0f

// 자동 복구 단계
#define BRINGUP_RETRY_MS              30000UL
#define POST_FAIL_STREAK_REINIT       2     // 연속 N회 실패 → bring-up 재시도
#define BRINGUP_FAIL_HARD_RESET       3     // bring-up 연속 N회 실패 → PWRKEY 토글
#define HARD_RESET_LIMIT              2     // PWRKEY 토글 N회로도 복구 안되면 PWR_EN 사이클

#define DBG  1
#define DBGLN(...)  do { if (DBG) Serial.println(__VA_ARGS__); } while (0)
#define DBGP(...)   do { if (DBG) Serial.print(__VA_ARGS__); } while (0)

// =================================================================
// 객체 / 상태
// =================================================================
Adafruit_SSD1306 display(128, 64, &Wire, -1);
TinyGPSPlus      gps;
HardwareSerial   gpsSerial(0);
HardwareSerial   lteSerial(1);

String   lastResp;
uint32_t bootMs   = 0;     // 세션 시작 시각 (millis 기준)
uint32_t ttAtOkMs = 0;
uint32_t ttL80GnssMs = 0;
uint32_t lastFixMs   = 0;  // 마지막 fix 들어온 시각

// 안정적 device_uid (MAC 기반). 1NCE IP 바뀌어도 서버에서 동일 디바이스로 누적.
char deviceUid[24] = "esp-unknown";

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
  uint8_t  hardResets     = 0;     // PWRKEY 토글 횟수
  uint16_t bringUpCount   = 0;     // 누적 bring-up 성공 횟수 (세션)
} S;

// =================================================================
// util
// =================================================================
static uint16_t readVbatMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(PIN_BAT);
  return (uint16_t)((sum / 16) * BAT_DIV_RATIO);
}

static void fmtUptime(char *out, size_t n, uint32_t ms) {
  uint32_t s  = ms / 1000;
  uint32_t h  = s / 3600;
  uint32_t m  = (s % 3600) / 60;
  uint32_t ss = s % 60;
  if (h > 0)        snprintf(out, n, "%luh%02lum", (unsigned long)h, (unsigned long)m);
  else if (m > 0)   snprintf(out, n, "%lum%02lus", (unsigned long)m, (unsigned long)ss);
  else              snprintf(out, n, "%lus", (unsigned long)s);
}

static void fmtAge(char *out, size_t n, uint32_t sinceMs) {
  if (sinceMs == 0) { snprintf(out, n, "--"); return; }
  uint32_t age = (millis() - sinceMs) / 1000;
  if (age < 60)        snprintf(out, n, "%lus",  (unsigned long)age);
  else if (age < 3600) snprintf(out, n, "%lum",  (unsigned long)(age / 60));
  else                 snprintf(out, n, "%luh",  (unsigned long)(age / 3600));
}

// =================================================================
// OLED — 누적 모드 전용 레이아웃
// =================================================================
static void drawOled() {
  char up[16], fixAge[16];
  fmtUptime(up,     sizeof(up),     millis() - bootMs);
  fmtAge   (fixAge, sizeof(fixAge), lastFixMs);

  display.clearDisplay();
  display.setCursor(0, 0);

  // 1행: 세션 헤더
  display.print(F("12_cont up "));
  display.println(up);

  // 2행: POST 누적
  display.print(F("POST "));
  display.print(S.postOks);
  display.print('/');
  display.print(S.postTries);
  display.print(F(" fs="));
  display.println(S.failStreak);

  // 3행: last status + bring-up count
  display.print(F("s="));
  display.print(S.lastStatus);
  display.print(F(" bu="));
  display.print(S.bringUpCount);
  display.print(F(" hr="));
  display.println(S.hardResets);

  // 4행: 망 상태
  display.print(F("CSQ:"));
  display.print(S.csq);
  display.print(F(" REG:"));
  display.print(S.reg);
  display.print(F(" "));
  display.println(S.lteReady ? F("OK") : F("--"));

  // 5행: GPS fix
  bool fix = gps.location.isValid();
  display.print(F("L80 "));
  display.print(fix ? F("FIX") : F("---"));
  display.print(F(" sat:"));
  display.print((int)gps.satellites.value());
  display.print(F(" "));
  display.println(fixAge);

  // 6-7행: 좌표 (가능할 때)
  if (fix) {
    display.print(F("lat:"));
    display.println(gps.location.lat(), 6);
    display.print(F("lng:"));
    display.println(gps.location.lng(), 6);
  } else {
    display.println();
    display.println();
  }

  // 8행: vbat
  display.print(F("vbat "));
  display.print(readVbatMv());
  display.print(F(" mV"));
  display.display();
}

// =================================================================
// LTE UART helpers (11_과 동일)
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

// 마지막 단계 회복: 모듈 전원 자체를 사이클
static void hardPowerCycle() {
  DBGLN(F("[LTE] PWR_EN cycle (full power off/on)"));
  digitalWrite(PIN_PWR_EN, HIGH);
  delay(2000);
  digitalWrite(PIN_PWR_EN, LOW);
  delay(2000);
  ltePowerOn();
}

// =================================================================
// LTE bring-up (11_과 동일, 약간의 로깅)
// =================================================================
static bool lteBringUp() {
  if (!sendAT("AT", "OK", 2000)) return false;
  if (ttAtOkMs == 0) ttAtOkMs = millis();
  sendAT("ATE0", "OK", 1000);
  sendAT("AT+CMEE=2", "OK", 1000);
  sendAT("AT+CPIN?", "READY", 5000);
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
    drawOled();
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
  if (pdp) S.bringUpCount++;
  return pdp;
}

// =================================================================
// HTTP POST (SH* — 11_과 동일)
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

  if (!sendAT("AT", "OK", 1500)) {
    DBGLN(F("[POST] module unresponsive, abort"));
    return false;
  }

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
// payload (11_과 동일 포맷 — 누적용 스키마는 그대로 유지)
// =================================================================
static void buildPayload(char *out, size_t cap) {
  uint32_t vbatMv = readVbatMv();
  bool l80fix = gps.location.isValid();

  if (l80fix) {
    snprintf(out, cap,
      "{\"device_uid\":\"%s\",\"ts\":%lu,\"awake\":%lu,\"csq\":%d,\"reg\":%d,"
      "\"vbat_mv\":%lu,\"at_ms\":%lu,"
      "\"l80\":{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat\":%d,\"ttff_s\":%lu}}",
      deviceUid,
      (unsigned long)((millis() - bootMs) / 1000),
      (unsigned long)S.bringUpCount,
      S.csq, S.reg, (unsigned long)vbatMv, (unsigned long)ttAtOkMs,
      gps.location.lat(), gps.location.lng(),
      (int)gps.satellites.value(),
      (unsigned long)(ttL80GnssMs / 1000));
  } else {
    snprintf(out, cap,
      "{\"device_uid\":\"%s\",\"ts\":%lu,\"awake\":%lu,\"csq\":%d,\"reg\":%d,"
      "\"vbat_mv\":%lu,\"at_ms\":%lu,"
      "\"l80\":{\"fix\":false,\"sat\":%d}}",
      deviceUid,
      (unsigned long)((millis() - bootMs) / 1000),
      (unsigned long)S.bringUpCount,
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
// setup / loop
// =================================================================
void setup() {
  bootMs = millis();

  Serial.begin(115200);
  delay(200);
  DBGLN();
  DBGLN(F("=== 12_continuous_tracker boot (always awake) ==="));

  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);

  pinMode(PIN_SWITCH, INPUT_PULLUP); // 미사용이지만 floating 방지

  // device_uid = "esp-<MAC 마지막 6 hex>" — 누적 일관성 보장
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(deviceUid, sizeof(deviceUid), "esp-%02x%02x%02x%02x%02x%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  DBGP(F("device_uid=")); DBGLN(deviceUid);

  analogReadResolution(12);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  drawOled();

  gpsSerial.setRxBufferSize(1024);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);

  lteSerial.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);
  ltePowerOn();
  lteBringUp();

  S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;
  S.nextPostAt    = millis() + 2000;
}

void loop() {
  // GPS 피드 (non-blocking)
  while (gpsSerial.available()) {
    char c = (char)gpsSerial.read();
    if (gps.encode(c)) {
      if (gps.location.isValid()) {
        if (ttL80GnssMs == 0) {
          ttL80GnssMs = millis() - bootMs;
          DBGLN(F("[L80] first fix"));
        }
        lastFixMs = millis();
      }
    }
  }

  if (!S.lteReady) {
    if ((int32_t)(millis() - S.nextBringUpAt) >= 0) {
      DBGP(F("[LTE] retry bring-up (fails="));
      DBGP(S.bringUpFails); DBGLN(F(")"));

      if (S.bringUpFails >= BRINGUP_FAIL_HARD_RESET) {
        S.bringUpFails = 0;
        S.hardResets++;
        if (S.hardResets > HARD_RESET_LIMIT) {
          // 마지막 수단: 모듈 전원 사이클
          hardPowerCycle();
          S.hardResets = 0;
        } else {
          DBGLN(F("[LTE] HARD RESET via PWRKEY toggle"));
          pulsePwrKey();
          delay(3000);
          pulsePwrKey();
          delay(5000);
        }
      }

      ltePowerOn();
      lteBringUp();
      S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;

      if (S.lteReady) {
        S.bringUpFails = 0;
        S.hardResets   = 0;
        S.nextPostAt   = millis() + 2000;
      } else {
        S.bringUpFails++;
      }
    }
  } else {
    if ((int32_t)(millis() - S.nextPostAt) >= 0) {
      doPost();
      S.nextPostAt = millis() + POST_INTERVAL_MS;

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

  // OLED 0.5s 갱신
  static uint32_t lastDraw = 0;
  if (millis() - lastDraw > 500) {
    lastDraw = millis();
    drawOled();
  }

  drainLte();
  delay(10);
}
