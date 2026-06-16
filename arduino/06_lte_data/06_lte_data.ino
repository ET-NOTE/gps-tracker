// ESP32-C3 mini + SIM7080G LTE 데이터 통신 검증
// SIM : 1NCE (MCC 901 MNC 40, 현재 SK Telecom 로밍)
// APN : iot.1nce.net (user/pass 없음)
//
// 부팅시 진단 시퀀스 자동 실행:
//   1) AT 응답    2) SIM READY    3) 신호세기    4) 망등록
//   5) PDP 활성화 6) IP 받기      7) 8.8.8.8 핑
// 각 단계 OLED + Serial로 실시간 표시. 실패해도 다음 단계로 진행 (진단용).
//
// 로컬 명령 (Serial Monitor):
//   /pwr   PWRKEY 1.5s 펄스 + 5s 부팅 대기
//   /at    AT 한 번 전송
//   /run   진단 시퀀스 전체 실행 (AT~PING)
//   /ping  8.8.8.8 재핑
//   /ip    CNACT? 현재 IP
//   /off   PDP 내리기
//   /on    PDP 올리기
//   그 외 passthrough

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <HardwareSerial.h>

#define PIN_SDA        8
#define PIN_SCL        9
#define OLED_ADDR      0x3C

#define PIN_PWR_EN     6
#define PIN_LTE_RX     4
#define PIN_LTE_TX     2
#define PIN_PWRKEY     7
#define PIN_DTR        10
#define LTE_BAUD       115200

#define APN_NAME       "iot.1nce.net"

Adafruit_SSD1306 display(128, 64, &Wire, -1);
HardwareSerial   lte(1);

String   lastResp;
char     statAT[8]    = "?";
char     statSIM[10]  = "?";
char     statCSQ[6]   = "?";
char     statREG[6]   = "?";
char     statPDP[6]   = "?";
char     statIP[24]   = "-";
char     statPING[12] = "?";

static void drawOled() {
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println(F("LTE data test"));
  display.println(F("-------------"));
  display.print(F("AT  :")); display.println(statAT);
  display.print(F("SIM :")); display.println(statSIM);
  display.print(F("CSQ :")); display.print(statCSQ);
  display.print(F(" REG:")); display.println(statREG);
  display.print(F("PDP :")); display.println(statPDP);
  display.print(F("IP:")); display.println(statIP);
  display.print(F("PING:")); display.println(statPING);
  display.display();
}

static void drainRx(uint32_t ms) {
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    while (lte.available()) {
      char c = (char)lte.read();
      Serial.write(c);
      lastResp += c;
      if (lastResp.length() > 1024) lastResp.remove(0, 512);
    }
    delay(2);
  }
}

static bool sendAT(const char *cmd, const char *expect, uint32_t timeoutMs) {
  lastResp = "";
  Serial.print(F(">> "));
  Serial.println(cmd);
  lte.print(cmd);
  lte.print("\r\n");
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    while (lte.available()) {
      char c = (char)lte.read();
      Serial.write(c);
      lastResp += c;
      if (lastResp.length() > 1024) lastResp.remove(0, 512);
    }
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

// 모듈이 이미 깨어있으면 PWRKEY 펄스 주지 않음 (펄스가 toggle이라 켠 걸 꺼버림).
// 응답 없으면 한 번 펄스 + 5s 대기 후 AT 재시도.
static void powerOn() {
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, LOW);
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, HIGH);        // idle
  delay(200);

  Serial.println(F("[LOCAL] probing AT (maybe already on)..."));
  if (sendAT("AT", "OK", 1500)) {
    Serial.println(F("[LOCAL] module already alive. skip PWRKEY."));
    return;
  }

  Serial.println(F("[LOCAL] no AT. pulsing PWRKEY 1.5s..."));
  pulsePwrKey();
  Serial.println(F("[LOCAL] waiting 5s for boot (URCs below)..."));
  drainRx(5000);

  Serial.println();
  Serial.println(F("[LOCAL] probing AT again..."));
  sendAT("AT", "OK", 2000);
}

static int parseIntAfter(const char *tag, int commaIdx) {
  int p = lastResp.indexOf(tag);
  if (p < 0) return -1;
  int c = p;
  for (int i = 0; i <= commaIdx; i++) {
    c = lastResp.indexOf(',', c + 1);
    if (c < 0) return -1;
  }
  return lastResp.substring(c + 1).toInt();
}

// CEREG 응답이 stat=1(home) 또는 5(roaming) 될 때까지 최대 totalMs 폴링
static bool waitRegistered(uint32_t totalMs) {
  uint32_t t0 = millis();
  int stat = 0;
  while (millis() - t0 < totalMs) {
    if (sendAT("AT+CEREG?", "OK", 2000)) {
      // +CEREG: <n>,<stat>,...
      int p = lastResp.indexOf("+CEREG:");
      if (p >= 0) {
        int comma = lastResp.indexOf(',', p);
        if (comma >= 0) {
          stat = lastResp.substring(comma + 1).toInt();
          snprintf(statREG, sizeof(statREG), "%d", stat);
          drawOled();
          if (stat == 1 || stat == 5) return true;
        }
      }
    }
    delay(2000);
  }
  return false;
}

static void cmdRun() {
  // AT
  strcpy(statAT, "...");
  drawOled();
  bool atOk = sendAT("AT", "OK", 1500);
  strcpy(statAT, atOk ? "OK" : "FAIL");
  drawOled();
  if (!atOk) return;

  sendAT("ATE0", "OK", 1000);
  sendAT("AT+CMEE=2", "OK", 1000);

  // SIM
  strcpy(statSIM, "...");
  drawOled();
  if (sendAT("AT+CPIN?", "+CPIN:", 3000)) {
    if (lastResp.indexOf("READY") >= 0)       strcpy(statSIM, "READY");
    else if (lastResp.indexOf("SIM PIN") >= 0) strcpy(statSIM, "PIN");
    else                                      strcpy(statSIM, "?");
  } else {
    strcpy(statSIM, "NOSIM");
  }
  drawOled();

  // CSQ
  if (sendAT("AT+CSQ", "+CSQ:", 1500)) {
    int p = lastResp.indexOf("+CSQ:");
    int rssi = lastResp.substring(p + 5).toInt();
    snprintf(statCSQ, sizeof(statCSQ), "%d", rssi);
  } else {
    strcpy(statCSQ, "?");
  }
  drawOled();

  // COPS — 통신사 확인 (Serial에만 출력)
  sendAT("AT+COPS?", "OK", 2000);

  // 등록 대기
  strcpy(statREG, "wait");
  drawOled();
  if (!waitRegistered(90000)) {
    strcpy(statREG, "TOUT");
    drawOled();
    return;
  }

  // PDP (1NCE는 APN만 있으면 됨, user/pass 없음)
  strcpy(statPDP, "...");
  drawOled();
  // 기존 세션 정리
  sendAT("AT+CNACT=0,0", "OK", 3000);
  delay(500);
  // APN 설정 후 활성화
  String cmd = String("AT+CNCFG=0,1,\"") + APN_NAME + "\"";
  sendAT(cmd.c_str(), "OK", 2000);
  if (sendAT("AT+CNACT=0,1", "+APP PDP: 0,ACTIVE", 20000)) {
    strcpy(statPDP, "OK");
  } else if (lastResp.indexOf("ACTIVE") >= 0) {
    strcpy(statPDP, "OK");
  } else {
    strcpy(statPDP, "FAIL");
  }
  drawOled();

  // IP
  if (sendAT("AT+CNACT?", "+CNACT:", 2000)) {
    // +CNACT: 0,1,"10.217.184.1"
    int q1 = lastResp.indexOf('"');
    int q2 = lastResp.indexOf('"', q1 + 1);
    if (q1 > 0 && q2 > q1) {
      String ip = lastResp.substring(q1 + 1, q2);
      ip.toCharArray(statIP, sizeof(statIP));
    }
  }
  drawOled();

  // 핑: SNPING4는 OK 받고 나서 N회에 걸쳐 +SNPING4: URC가 뿌려짐.
  // 3회 응답 다 받거나 타임아웃까지 수집.
  strcpy(statPING, "...");
  drawOled();
  sendAT("AT+SNPING4=\"8.8.8.8\",3,16,1000", "OK", 3000);
  {
    int ok = 0;
    uint32_t t0 = millis();
    while (millis() - t0 < 12000 && ok < 3) {
      while (lte.available()) {
        char c = (char)lte.read();
        Serial.write(c);
        lastResp += c;
        if (lastResp.length() > 1024) lastResp.remove(0, 512);
      }
      // 새로 들어온 +SNPING4 카운트
      int count = 0, idx = 0;
      while ((idx = lastResp.indexOf("+SNPING4:", idx)) >= 0) {
        count++;
        idx += 9;
      }
      if (count != ok) {
        ok = count;
        snprintf(statPING, sizeof(statPING), "%d/3", ok);
        drawOled();
      }
      delay(20);
    }
    if (ok == 0) strcpy(statPING, "FAIL");
    snprintf(statPING, sizeof(statPING), "%d/3", ok);
    drawOled();
  }

  Serial.println();
  Serial.println(F("[LOCAL] diag complete"));
}

void setup() {
  Serial.begin(115200);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  drawOled();

  lte.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);

  Serial.println();
  Serial.println(F("=== LTE data diagnostic ==="));
  Serial.println(F("APN: " APN_NAME));
  Serial.println(F("Commands:"));
  Serial.println(F("  /pwr   PWRKEY pulse + 5s wait"));
  Serial.println(F("  /at    send AT"));
  Serial.println(F("  /run   full diagnostic sequence"));
  Serial.println(F("  /ping  /ip  /on  /off"));
  Serial.println(F("  others passthrough"));
  Serial.println();

  // 자동 실행: 전원/파워키 처리 → 전체 진단
  powerOn();
  cmdRun();
}

void loop() {
  // modem -> PC
  while (lte.available()) {
    char c = (char)lte.read();
    Serial.write(c);
    lastResp += c;
    if (lastResp.length() > 1024) lastResp.remove(0, 512);
  }

  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.length() == 0) return;

    if (cmd == "/pwr") {
      Serial.println(F("[LOCAL] PWRKEY pulse 1.5s"));
      pulsePwrKey();
      Serial.println(F("[LOCAL] waiting 5s for boot (URCs below)..."));
      drainRx(5000);
      Serial.println();
      Serial.println(F("[LOCAL] pwr done"));
      return;
    }
    if (cmd == "/at") {
      Serial.println(F("[LOCAL] AT"));
      lte.print("AT\r\n");
      return;
    }
    if (cmd == "/run") { cmdRun(); return; }
    if (cmd == "/ping") {
      sendAT("AT+SNPING4=\"8.8.8.8\",3,16,1000", "+SNPING4:", 15000);
      return;
    }
    if (cmd == "/ip") {
      sendAT("AT+CNACT?", "OK", 2000);
      return;
    }
    if (cmd == "/off") {
      sendAT("AT+CNACT=0,0", "OK", 3000);
      strcpy(statPDP, "off"); drawOled();
      return;
    }
    if (cmd == "/on") {
      String c2 = String("AT+CNCFG=0,1,\"") + APN_NAME + "\"";
      sendAT(c2.c_str(), "OK", 2000);
      sendAT("AT+CNACT=0,1", "ACTIVE", 20000);
      return;
    }

    lte.print(cmd);
    lte.print("\r\n");
  }
}
