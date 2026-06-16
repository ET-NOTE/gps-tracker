// ESP32-C3 mini: GPS L80-R 좌표 -> SIM7080G LTE -> seriallog.com/gps-tracker/ingest
//
// Tools 설정 (필수):
//   Board           : ESP32C3 Dev Module (또는 사용하는 보드)
//   USB CDC On Boot : ENABLED   (Serial=USB, UART0 해방되어 GPS에 사용)
//
// UART 할당:
//   Serial   = USB CDC (디버그)
//   Serial0  = UART0 -> GPS L80-R (ESP RX=20, TX=21, 9600)
//   Serial1  = UART1 -> SIM7080G  (ESP RX=4,  TX=2,  115200)
//
// 배선:
//   D6 = GPS+LTE 전원 (LOW=ON, HIGH=OFF)
//   PWRKEY=7, DTR=10 (SIM7080G), PWR_EN=6
//   I2C OLED SDA=8, SCL=9 (0x3C)
//
// 동작:
//   부팅 -> 모듈 전원 ON -> LTE 네트워크/PDP 활성화 -> GPS 수신 시작
//   -> POST_INTERVAL마다 HTTP POST (fix 없어도 상태 전송)
//   -> OLED에 GPS/LTE/POST 상태 실시간 표시
//
// 테스트: 서버에서 curl http://seriallog.com/gps-tracker/latest 로 수신 확인

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TinyGPSPlus.h>
#include <HardwareSerial.h>

// --- pins ---
#define PIN_SDA        8
#define PIN_SCL        9
#define OLED_ADDR      0x3C
#define PIN_PWR_EN     6
#define PIN_PWRKEY     7
#define PIN_DTR        10
#define PIN_BAT        3

#define PIN_GPS_RX     20
#define PIN_GPS_TX     21
#define GPS_BAUD       9600

#define PIN_LTE_RX     4
#define PIN_LTE_TX     2
#define LTE_BAUD       115200

// --- config ---
#define APN_NAME            "iot.1nce.net"
#define POST_URL_HOST       "http://seriallog.com"
#define POST_PATH           "/gps-tracker/ingest"
#define POST_INTERVAL_MS    30000UL
#define BAT_DIV_RATIO       2.0f

Adafruit_SSD1306 display(128, 64, &Wire, -1);
TinyGPSPlus      gps;
HardwareSerial   gpsSerial(0);
HardwareSerial   lteSerial(1);

String lastResp;

struct Stats {
  bool     lteReady   = false;
  int      csq        = -1;
  int      reg        = -1;
  char     ip[24]     = "-";
  uint32_t gpsChars   = 0;
  uint32_t postTries  = 0;
  uint32_t postOks    = 0;
  int      lastStatus = -1;
  uint32_t nextPostAt = 0;
  uint32_t l80FirstFixMs = 0;
  uint8_t  failStreak = 0;       // 연속 POST 실패 카운트
  uint32_t nextBringUpAt = 0;    // 재-bring-up 다음 시도 시각
} S;

#define FAIL_STREAK_REINIT    3        // 이 횟수 이상 연속 실패시 재초기화
#define BRINGUP_RETRY_MS      30000UL  // bring-up 실패시 재시도 간격

// SIM7080G 내장 GNSS 최신 상태 (CGNSINF 폴링 결과)
struct LteGnss {
  bool     fix          = false;
  double   lat          = 0;
  double   lng          = 0;
  int      satView      = 0;
  int      satUsed      = 0;
  uint32_t firstFixMs   = 0;
} G;

// ========== OLED ==========
static void drawOled() {
  display.clearDisplay();
  display.setCursor(0, 0);
  // L80-R
  display.print(F("L80 s:")); display.print(gps.satellites.value());
  display.print(F(" fix:")); display.println(gps.location.isValid() ? F("Y") : F("N"));
  if (gps.location.isValid()) {
    display.print(F(" "));
    display.print(gps.location.lat(), 5);
    display.print(F(","));
    display.println(gps.location.lng(), 5);
  } else {
    display.println(F(" -"));
  }
  // LTE 내장 GNSS
  display.print(F("LTE s:")); display.print(G.satUsed);
  display.print(F("/")); display.print(G.satView);
  display.print(F(" fix:")); display.println(G.fix ? F("Y") : F("N"));
  if (G.fix) {
    display.print(F(" "));
    display.print(G.lat, 5);
    display.print(F(","));
    display.println(G.lng, 5);
  } else {
    display.println(F(" -"));
  }
  // Net / POST
  display.print(F("CSQ:")); display.print(S.csq);
  display.print(F(" REG:")); display.print(S.reg);
  display.print(F(" P:"));
  display.print(S.postOks); display.print('/'); display.println(S.postTries);

  int32_t left = (int32_t)(S.nextPostAt - millis()) / 1000;
  if (left < 0) left = 0;
  display.print(F("s=")); display.print(S.lastStatus);
  display.print(F(" next:")); display.print(left); display.print('s');
  display.display();
}

// ========== LTE UART helpers ==========
static void drainLte() {
  while (lteSerial.available()) {
    char c = (char)lteSerial.read();
    Serial.write(c);
    lastResp += c;
    if (lastResp.length() > 1024) lastResp.remove(0, 512);
  }
}

static bool sendAT(const char *cmd, const char *expect, uint32_t timeoutMs) {
  lastResp = "";
  if (cmd && *cmd) {
    Serial.print(F(">> "));
    Serial.println(cmd);
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
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, LOW);
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, HIGH);
  delay(200);

  // 이미 깨어있으면 펄스 생략 (pulse는 toggle이라 켠 걸 꺼버림)
  if (sendAT("AT", "OK", 1500)) {
    Serial.println(F("[LTE] already on"));
    return;
  }
  Serial.println(F("[LTE] pulse PWRKEY + wait 5s"));
  pulsePwrKey();
  uint32_t t0 = millis();
  while (millis() - t0 < 5000) { drainLte(); delay(5); }
  sendAT("AT", "OK", 2000);
}

// ========== LTE network bring-up ==========
static bool lteBringUp() {
  if (!sendAT("AT", "OK", 2000)) return false;
  sendAT("ATE0", "OK", 1000);
  sendAT("AT+CMEE=2", "OK", 1000);
  sendAT("AT+CPIN?", "READY", 5000);

  // CSQ
  if (sendAT("AT+CSQ", "+CSQ:", 1500)) {
    int p = lastResp.indexOf("+CSQ:");
    S.csq = lastResp.substring(p + 5).toInt();
  }

  // 망 등록 대기 (최대 90초)
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

  // PDP
  sendAT("AT+CNACT=0,0", "OK", 3000);
  delay(300);
  String c = String("AT+CNCFG=0,1,\"") + APN_NAME + "\"";
  sendAT(c.c_str(), "OK", 2000);
  bool pdp = sendAT("AT+CNACT=0,1", "ACTIVE", 20000);

  // IP & 상태 재확인 — 이전 세션이 이미 active면 'ACTIVE' URC 안 오는 경우 있음.
  // CNACT? 응답의 <status>=1 이거나 non-zero IP면 active 로 간주 (fallback).
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

  // SIM7080G 내장 GNSS ON (GPS 측위 시작)
  sendAT("AT+CGNSPWR=1", "OK", 2000);

  return pdp;
}

// CGNSINF 응답 파싱하여 G.* 갱신
// 응답: +CGNSINF: <run>,<fix>,<utc>,<lat>,<lon>,<alt>,<spd>,<course>,<fixmode>,,<hdop>,<pdop>,<vdop>,,<sat_view>,<sat_used>,<glon_used>,...
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
    if (!G.firstFixMs) G.firstFixMs = millis();
  }
  if (idx > 14) G.satView = tok[14].toInt();
  if (idx > 15) G.satUsed = tok[15].toInt();
}

// ========== HTTP POST (SIM7080G SH* 스택) ==========
// SHBOD 프롬프트('>') 받고 바디 전송하는 전용 로직
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
  Serial.write((const uint8_t *)body, len);
  Serial.println();
  // OK 대기
  return sendAT("", "OK", 8000);
}

static bool httpPostJson(const char *host, const char *path,
                         const char *body, int *statusOut) {
  char cmd[96];

  // SIM7080G 계열 quirk: CGNSPWR=1 상태에서 SH* HTTP 스택이 "operation not allowed"로 차단됨.
  // POST 동안만 GNSS OFF → POST 끝나면 ON. 30s 간격이라 GNSS 측위 손해는 무시 가능.
  sendAT("AT+CGNSPWR=0", "OK", 2000);
  delay(200);

  // 혹시 남은 세션 정리 (에러 무시)
  sendAT("AT+SHDISC", nullptr, 800);

  snprintf(cmd, sizeof(cmd), "AT+SHCONF=\"URL\",\"%s\"", host);
  if (!sendAT(cmd, "OK", 2000)) { sendAT("AT+CGNSPWR=1", "OK", 2000); return false; }
  sendAT("AT+SHCONF=\"BODYLEN\",1024", "OK", 2000);
  sendAT("AT+SHCONF=\"HEADERLEN\",350", "OK", 2000);
  // SSL 비활성화 명시 (http://)
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
  Serial.print(F(">> ")); Serial.println(cmd);
  lteSerial.print(cmd); lteSerial.print("\r\n");
  if (!sendBodyAfterPrompt(body, len)) {
    sendAT("AT+SHDISC", "OK", 3000);
    sendAT("AT+CGNSPWR=1", "OK", 2000);
    return false;
  }

  snprintf(cmd, sizeof(cmd), "AT+SHREQ=\"%s\",3", path);   // 3 = POST
  if (!sendAT(cmd, "+SHREQ:", 30000)) {
    sendAT("AT+SHDISC", "OK", 3000);
    sendAT("AT+CGNSPWR=1", "OK", 2000);
    return false;
  }

  // +SHREQ: "POST",<status>,<datalen>
  int p = lastResp.indexOf("+SHREQ:");
  int c1 = lastResp.indexOf(',', p);
  int c2 = lastResp.indexOf(',', c1 + 1);
  if (statusOut && c1 > 0 && c2 > c1) {
    *statusOut = lastResp.substring(c1 + 1, c2).toInt();
  }

  sendAT("AT+SHDISC", "OK", 3000);

  // GNSS 다시 켜기
  sendAT("AT+CGNSPWR=1", "OK", 2000);

  return true;
}

// ========== payload builder ==========
static uint16_t readBatteryMilliVolts() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(PIN_BAT);
  return (uint16_t)(sum / 16);
}

// payload: L80-R와 LTE 내장 GNSS 둘 다 포함. 둘을 서버에서 비교/플롯하기 위함.
static void buildPayload(char *out, size_t cap) {
  uint16_t pinMv  = readBatteryMilliVolts();
  uint32_t vbatMv = (uint32_t)(pinMv * BAT_DIV_RATIO);

  bool l80fix = gps.location.isValid();
  if (l80fix && !S.l80FirstFixMs) S.l80FirstFixMs = millis();

  char l80buf[128];
  if (l80fix) {
    snprintf(l80buf, sizeof(l80buf),
      "{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat\":%d,\"ttff_s\":%lu}",
      gps.location.lat(), gps.location.lng(),
      (int)gps.satellites.value(),
      (unsigned long)(S.l80FirstFixMs / 1000));
  } else {
    snprintf(l80buf, sizeof(l80buf),
      "{\"fix\":false,\"sat\":%d}",
      (int)gps.satellites.value());
  }

  char lteBuf[128];
  if (G.fix) {
    snprintf(lteBuf, sizeof(lteBuf),
      "{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat_used\":%d,\"sat_view\":%d,\"ttff_s\":%lu}",
      G.lat, G.lng, G.satUsed, G.satView,
      (unsigned long)(G.firstFixMs / 1000));
  } else {
    snprintf(lteBuf, sizeof(lteBuf),
      "{\"fix\":false,\"sat_used\":%d,\"sat_view\":%d}",
      G.satUsed, G.satView);
  }

  snprintf(out, cap,
    "{\"ts\":%lu,\"csq\":%d,\"reg\":%d,\"vbat_mv\":%lu,\"l80\":%s,\"lte\":%s}",
    (unsigned long)(millis() / 1000),
    S.csq, S.reg, (unsigned long)vbatMv,
    l80buf, lteBuf);
}

static void doPost() {
  char body[512];
  buildPayload(body, sizeof(body));
  Serial.print(F("[POST] ")); Serial.println(body);

  S.postTries++;
  int status = -1;
  if (httpPostJson(POST_URL_HOST, POST_PATH, body, &status)) {
    S.lastStatus = status;
    if (status == 200) S.postOks++;
  } else {
    S.lastStatus = -1;
  }
  drawOled();
}

// ========== setup / loop ==========
void setup() {
  Serial.begin(115200);
  delay(200);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(F("boot..."));
  display.display();

  analogReadResolution(12);

  gpsSerial.setRxBufferSize(1024);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);

  lteSerial.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);

  Serial.println();
  Serial.println(F("=== 07_gps_lte_send ==="));
  Serial.println(F("powering on modules..."));

  ltePowerOn();

  display.clearDisplay();
  display.setCursor(0, 0);
  display.println(F("LTE bring-up..."));
  display.display();

  // 초기 bring-up 시도 (실패해도 loop에서 재시도)
  if (lteBringUp()) {
    Serial.println(F("[LTE] ready"));
  } else {
    Serial.println(F("[LTE] initial bring-up failed — will retry in loop"));
  }
  S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;
  S.nextPostAt    = millis() + POST_INTERVAL_MS;
}

void loop() {
  // GPS 피드
  while (gpsSerial.available()) {
    char c = (char)gpsSerial.read();
    gps.encode(c);
    S.gpsChars++;
  }

  if (!S.lteReady) {
    // LTE 미준비 → BRINGUP_RETRY_MS 마다 재시도 (초기 실패 or 후천적 드랍 모두 커버)
    if ((int32_t)(millis() - S.nextBringUpAt) >= 0) {
      Serial.println(F("[LTE] bring-up attempt..."));
      lteBringUp();
      S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;
      if (S.lteReady) {
        Serial.println(F("[LTE] recovered"));
        S.nextPostAt = millis() + 2000;  // 2초 후 첫 POST
      }
    }
  } else {
    // POST 타이밍
    if ((int32_t)(millis() - S.nextPostAt) >= 0) {
      pollLteGnss();
      doPost();
      S.nextPostAt = millis() + POST_INTERVAL_MS;

      // 연속 실패 FAIL_STREAK_REINIT회 → 강제 재-bring-up
      if (S.lastStatus != 200) {
        S.failStreak++;
        Serial.printf("[LTE] fail streak %d\n", S.failStreak);
        if (S.failStreak >= FAIL_STREAK_REINIT) {
          Serial.println(F("[LTE] forcing re-bring-up"));
          S.lteReady     = false;
          S.failStreak   = 0;
          S.nextBringUpAt = millis();  // 즉시 재시도
        }
      } else {
        S.failStreak = 0;
      }
    }
  }

  // OLED 주기 갱신
  static uint32_t lastDraw = 0;
  if (millis() - lastDraw > 500) {
    lastDraw = millis();
    drawOled();
  }

  // LTE URC 흘려보기
  drainLte();
}
