// 05_1 SIM7080G 단독 TCP POST + 내장 GNSS 테스트 (L80, MMA, 스위치 없음)
//
// 목적:
//   1) CA* (CAOPEN/CASEND/CARECV/CACLOSE) 스택의 안정성 검증
//   2) CGNSPWR=1 항상 ON 유지하면서 TCP POST 공존 가능한지 확인
//   3) LTE 내장 GNSS 첫 fix까지 시간 측정 (cycling 없는 조건)
//
// 비교 대상:
//   - 05번: SH* HTTP 스택 통합 검증 (안정적)
//   - 10번: 통합 트래커. SH*로 회귀 (CA*는 2회차 POST부터 fail)
//   - 05_1 (이거): CA* 단독 검증. POST 단위 동작 + 연속 동작 모두 점검
//
// 진단 출력:
//   - 매 명령 >> << 페어
//   - POST 직전 AT+CASTATE? 로 소켓 상태 스냅샷
//   - HTTP/1.1 응답 상태코드 파싱
//   - 실패 시 lastResp 출력
//
// Arduino IDE Tools:
//   USB CDC On Boot: ENABLED

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <HardwareSerial.h>

// --- pins ---
#define PIN_SDA       8
#define PIN_SCL       9
#define OLED_ADDR     0x3C

#define PIN_PWR_EN    6
#define PIN_PWRKEY    7
#define PIN_DTR       10
#define PIN_BAT       3

#define PIN_LTE_RX    4
#define PIN_LTE_TX    2
#define LTE_BAUD      115200

// --- config ---
#define APN_NAME            "iot.1nce.net"
// IP 직결 (DNS 우회)
#define POST_HOST_IP        "210.114.18.16"
#define POST_HOST_HDR       "seriallog.com"
#define POST_PORT           80
#define POST_PATH           "/gps-tracker/ingest"
#define POST_INTERVAL_MS    30000UL

#define BAT_DIV_RATIO       2.0f

#define DBG  1
#define DBGLN(...)  do { if (DBG) Serial.println(__VA_ARGS__); } while (0)
#define DBGP(...)   do { if (DBG) Serial.print(__VA_ARGS__); } while (0)

Adafruit_SSD1306 display(128, 64, &Wire, -1);
HardwareSerial   lteSerial(1);

String lastResp;

struct Stats {
  bool     lteReady   = false;
  int      csq        = -1;
  int      reg        = -1;
  char     ip[24]     = "-";
  uint32_t postTries  = 0;
  uint32_t postOks    = 0;
  int      lastStatus = -1;
  uint32_t nextPostAt = 0;
  uint32_t bringUpAt  = 0;
} S;

struct LteGnss {
  bool     fix         = false;
  double   lat         = 0;
  double   lng         = 0;
  int      satView     = 0;
  int      satUsed     = 0;
  uint32_t firstFixMs  = 0;   // 첫 fix까지 걸린 시간 (from boot)
} G;

// ================ util ================
static uint16_t readVbatMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(PIN_BAT);
  return (uint16_t)((sum / 16) * BAT_DIV_RATIO);
}

static void drawOled(const __FlashStringHelper *state) {
  display.clearDisplay();
  display.setCursor(0, 0);
  display.print(F("SIM TCP+GNSS ")); display.println(state);
  display.print(F("CSQ:"));  display.print(S.csq);
  display.print(F(" REG:")); display.print(S.reg);
  display.print(F(" P:"));   display.print(S.postOks);
  display.print('/');         display.println(S.postTries);
  display.print(F("s="));    display.print(S.lastStatus);
  display.print(F(" IP:"));  display.println(S.ip);
  // GNSS 라인
  display.print(F("GNSS "));
  display.print(G.fix ? F("FIX") : F("---"));
  display.print(F(" v/u "));
  display.print(G.satView); display.print('/'); display.println(G.satUsed);
  if (G.fix) {
    display.print(F(" "));
    display.print(G.lat, 5); display.print(',');
    display.println(G.lng, 5);
  } else {
    display.println(F(" -"));
  }
  display.print(F("ttff:"));
  if (G.firstFixMs) { display.print(G.firstFixMs / 1000); display.print('s'); }
  else              { display.print(F("--")); }
  display.print(F(" up:")); display.print(millis() / 1000); display.print('s');
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
    Serial.print(F("<< (timeout) "));
    Serial.println(lastResp);
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

// ================ bring-up ================
static bool lteBringUp() {
  if (!sendAT("AT", "OK", 2000)) return false;
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
    drawOled(F("REG wait"));
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

  // 망 연결성 진단: 8.8.8.8 핑 (TCP fail 시 망 자체 vs port 차단 구분용)
  if (pdp) {
    DBGLN(F("[NET] ping test 8.8.8.8"));
    sendAT("AT+SNPING4=\"8.8.8.8\",3,16,1000", "+SNPING4:", 12000);
    // 응답에서 +SNPING4 발생 횟수 카운트하면 패킷 도달 확인 가능
  }

  // 내장 GNSS ON (cold start로 깨끗한 fix 유도)
  sendAT("AT+CGNSPWR=0", "OK", 2000);
  delay(200);
  sendAT("AT+CGNSCOLD", "OK", 2000);
  sendAT("AT+CGNSPWR=1", "OK", 2000);
  return pdp;
}

// CGNSINF 폴링 → G.* 갱신
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
    if (G.firstFixMs == 0) {
      G.firstFixMs = millis();
      DBGP(F("[GNSS] first fix at ")); DBGP(G.firstFixMs / 1000); DBGLN(F("s"));
    }
  }
  if (idx > 14) G.satView = tok[14].toInt();
  if (idx > 15) G.satUsed = tok[15].toInt();
}

// ================ TCP HTTP POST ================
static bool waitForByte(char ch, uint32_t timeoutMs) {
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    drainLte();
    if (lastResp.indexOf(ch) >= 0) return true;
    delay(5);
  }
  return false;
}

// UART가 일정 시간 조용해질 때까지 대기 (모듈이 이전 명령 응답 다 흘려보내게)
static void waitUartIdle(uint32_t idleMs, uint32_t maxWaitMs) {
  uint32_t lastByte = millis();
  uint32_t t0       = millis();
  while (millis() - t0 < maxWaitMs) {
    if (lteSerial.available()) {
      while (lteSerial.available()) {
        lteSerial.read();   // 통째 폐기
        lastByte = millis();
      }
    }
    if (millis() - lastByte >= idleMs) return;   // idleMs 동안 침묵 → OK
    delay(10);
  }
}

// 첫 성공 POST 이후엔 매번 PDP 리프레시 (CA* "한 세션 1연결" 룰 회피)
static bool needPdpRefresh = false;

static bool refreshPdp() {
  DBGLN(F("[POST] PDP refresh"));
  sendAT("AT+CNACT=0,0", "OK", 3000);
  delay(500);
  String c = String("AT+CNCFG=0,1,\"") + APN_NAME + "\"";
  sendAT(c.c_str(), "OK", 2000);
  if (!sendAT("AT+CNACT=0,1", "ACTIVE", 15000)) {
    // ACTIVE 못 봐도 CNACT? 로 IP 확인
    if (sendAT("AT+CNACT?", "+CNACT: 0,1", 2000)) return true;
    DBGLN(F("[POST] PDP refresh fail"));
    return false;
  }
  delay(300);
  return true;
}

static bool tcpHttpPost(const char *body, int *statusOut) {
  char cmd[200];
  *statusOut = -1;

  DBGLN(F("[POST] start (TCP CA*)"));

  // 0. 모듈 alive 확인
  if (!sendAT("AT", "OK", 1500)) {
    DBGLN(F("[POST] module unresponsive, abort"));
    return false;
  }

  // 0.5. 이전 POST 후라면 PDP 강제 새로 받기 — 매 연결을 "fresh PDP"로
  if (needPdpRefresh) {
    if (!refreshPdp()) return false;
  }

  // 1. 진단
  sendAT("AT+CASTATE?", "OK", 1500);
  bool socketOpen = (lastResp.indexOf("+CASTATE: 0,1") >= 0);

  // 2. 소켓 열려있을 때만 CACLOSE
  if (socketOpen) {
    sendAT("AT+CACLOSE=0", "OK", 2500);
  }

  // 3. UART idle 대기
  waitUartIdle(500, 3000);

  // 4. CAOPEN
  snprintf(cmd, sizeof(cmd), "AT+CAOPEN=0,0,\"TCP\",\"%s\",%d", POST_HOST_IP, POST_PORT);
  if (!sendAT(cmd, "+CAOPEN: 0,0", 12000)) {
    DBGLN(F("[POST] CAOPEN fail"));
    DBGP(F("    last: ")); DBGLN(lastResp);
    return false;
  }
  DBGLN(F("[POST] connected"));

  // HTTP 요청 빌드
  size_t bodyLen = strlen(body);
  char req[700];
  int hdrLen = snprintf(req, sizeof(req),
    "POST %s HTTP/1.1\r\n"
    "Host: %s\r\n"
    "User-Agent: ESP32C3-SIM-test\r\n"
    "Content-Type: application/json\r\n"
    "Content-Length: %u\r\n"
    "Connection: close\r\n\r\n",
    POST_PATH, POST_HOST_HDR, (unsigned)bodyLen);
  if (hdrLen < 0 || (size_t)hdrLen + bodyLen >= sizeof(req)) {
    sendAT("AT+CACLOSE=0", "OK", 1500);
    return false;
  }
  memcpy(req + hdrLen, body, bodyLen);
  int totalLen = hdrLen + bodyLen;

  // CASEND → '>' → data → "OK"
  snprintf(cmd, sizeof(cmd), "AT+CASEND=0,%d", totalLen);
  if (DBG) { Serial.print(F(">> ")); Serial.println(cmd); }
  lteSerial.print(cmd); lteSerial.print("\r\n");

  lastResp = "";
  if (!waitForByte('>', 5000)) {
    DBGLN(F("[POST] no '>' prompt"));
    sendAT("AT+CACLOSE=0", "OK", 1500);
    return false;
  }
  lteSerial.write((const uint8_t *)req, totalLen);
  if (!sendAT("", "OK", 10000)) {
    DBGLN(F("[POST] CASEND no OK"));
    sendAT("AT+CACLOSE=0", "OK", 1500);
    return false;
  }
  DBGLN(F("[POST] sent, waiting response"));

  // 응답 — CARECV 폴링
  String respBuf;
  uint32_t t0 = millis();
  while (millis() - t0 < 15000) {
    if (sendAT("AT+CARECV=0,1024", "OK", 3000)) {
      respBuf += lastResp;
    }
    int p = respBuf.indexOf("HTTP/1.1 ");
    if (p >= 0 && p + 12 <= (int)respBuf.length()) {
      *statusOut = respBuf.substring(p + 9, p + 12).toInt();
      DBGP(F("[POST] HTTP ")); DBGLN(*statusOut);
      break;
    }
    if (lastResp.indexOf("+CASTATE: 0,0") >= 0 ||
        lastResp.indexOf("+IPCLOSE")     >= 0 ||
        lastResp.indexOf("CLOSED")       >= 0) {
      DBGLN(F("[POST] remote closed"));
      break;
    }
    delay(300);
  }

  sendAT("AT+CACLOSE=0", "OK", 1000);

  // 다음 POST는 PDP 새로 받고 시작
  if (*statusOut > 0) needPdpRefresh = true;

  return (*statusOut > 0);
}

// ================ payload ================
static void buildPayload(char *out, size_t cap) {
  uint32_t vbatMv = readVbatMv();
  char lteBuf[128];
  if (G.fix) {
    snprintf(lteBuf, sizeof(lteBuf),
      "{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat_used\":%d,\"sat_view\":%d,\"ttff_s\":%lu}",
      G.lat, G.lng, G.satUsed, G.satView,
      (unsigned long)(G.firstFixMs / 1000));
  } else {
    snprintf(lteBuf, sizeof(lteBuf),
      "{\"fix\":false,\"sat_used\":%d,\"sat_view\":%d}", G.satUsed, G.satView);
  }
  snprintf(out, cap,
    "{\"src\":\"05_1_sim_only\",\"ts\":%lu,\"csq\":%d,\"reg\":%d,"
    "\"vbat_mv\":%lu,\"tries\":%lu,\"oks\":%lu,\"lte\":%s}",
    (unsigned long)(millis() / 1000), S.csq, S.reg,
    (unsigned long)vbatMv,
    (unsigned long)S.postTries, (unsigned long)S.postOks,
    lteBuf);
}

static void doPost() {
  char body[256];
  buildPayload(body, sizeof(body));
  if (DBG) { Serial.print(F("[POST body] ")); Serial.println(body); }

  S.postTries++;
  int status = -1;
  if (tcpHttpPost(body, &status)) {
    S.lastStatus = status;
    if (status == 200) S.postOks++;
  } else {
    S.lastStatus = -1;
  }
  drawOled(F("idle"));
}

// ================ setup/loop ================
void setup() {
  Serial.begin(115200);
  delay(200);
  DBGLN();
  DBGLN(F("=== 05_1 SIM-only TCP test ==="));

  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);

  analogReadResolution(12);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  drawOled(F("boot"));

  lteSerial.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);
  ltePowerOn();
  drawOled(F("bringup"));
  lteBringUp();

  S.bringUpAt  = millis();
  S.nextPostAt = millis() + 2000;
  drawOled(F("idle"));
}

void loop() {
  if (!S.lteReady) {
    static uint32_t nextRetryAt = 0;
    if ((int32_t)(millis() - nextRetryAt) >= 0) {
      DBGLN(F("[LTE] retry bring-up"));
      ltePowerOn();
      lteBringUp();
      nextRetryAt = millis() + 30000UL;
      if (S.lteReady) S.nextPostAt = millis() + 2000;
    }
  } else {
    if ((int32_t)(millis() - S.nextPostAt) >= 0) {
      pollLteGnss();             // 최신 GNSS 상태 스냅샷
      drawOled(F("POSTing"));
      doPost();
      S.nextPostAt = millis() + POST_INTERVAL_MS;
    }

    // POST 사이에도 GNSS 진행상황 보고 싶어서 5초마다 폴링
    static uint32_t nextGnssPoll = 0;
    if ((int32_t)(millis() - nextGnssPoll) >= 0) {
      pollLteGnss();
      nextGnssPoll = millis() + 5000;
    }
  }

  static uint32_t lastDraw = 0;
  if (millis() - lastDraw > 1000) {
    lastDraw = millis();
    drawOled(F("idle"));
  }

  drainLte();
  delay(20);
}
