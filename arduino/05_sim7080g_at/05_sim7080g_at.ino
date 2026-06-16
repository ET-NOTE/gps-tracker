// ESP32-C3 mini + SIM7080G LTE — 진단용 passthrough 스케치
// Serial Monitor(115200, Both NL&CR)에서 직접 타이핑해서 AT 응답 눈으로 확인.
// OLED엔 최소 상태(rx바이트/last/baud)만 표기.
//
// Arduino IDE Tools 설정:
//   - USB CDC On Boot : Enabled   (Serial을 USB로 잡기 위해)
//   - Upload Mode     : UART 또는 USB-CDC (보드에 따라)
//
// 배선:
//   ESP RX = GPIO2 <- SIM7080G TX
//   ESP TX = GPIO4 -> SIM7080G RX
//   PWRKEY = GPIO7   (HIGH idle, LOW 1.5s 펄스)
//   DTR    = GPIO10  (LOW)
//   PWR_EN = GPIO6   (LOW = VBAT 공급)
//
// 사용:
//   시리얼모니터에서
//     /pwr   PWRKEY 펄스 (친구 코드와 동일 시퀀스)
//     /at    AT 한 번 전송
//     /reset 스케치 상태 리셋
//     그 외  그대로 모듈로 전달 (예: AT+CSQ)

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <HardwareSerial.h>

#define PIN_SDA        8
#define PIN_SCL        9
#define OLED_ADDR      0x3C

#define PIN_PWR_EN     6
#define PIN_LTE_RX     4   // ESP RX (원래 2였지만 스왑해봄)
#define PIN_LTE_TX     2   // ESP TX (원래 4였지만 스왑해봄)
#define PIN_PWRKEY     7
#define PIN_DTR        10
#define LTE_BAUD       115200

Adafruit_SSD1306 display(128, 64, &Wire, -1);
HardwareSerial   lte(1);

uint32_t rxBytesTotal = 0;
uint32_t txBytesTotal = 0;
uint8_t  lastRxByte   = 0;
char     stateMsg[20] = "boot";

static void drawOled() {
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println(F("SIM7080G passthru"));
  display.println(F("-----------------"));
  display.print(F("state: ")); display.println(stateMsg);
  display.print(F("baud : ")); display.println(LTE_BAUD);
  display.print(F("rx   : ")); display.println(rxBytesTotal);
  display.print(F("tx   : ")); display.println(txBytesTotal);
  display.print(F("last : 0x")); display.println(lastRxByte, HEX);
  display.display();
}

static void pulsePwrKey() {
  // 친구 Mega 코드와 동일 시퀀스
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, HIGH);
  delay(100);
  digitalWrite(PIN_PWRKEY, LOW);
  delay(1500);
  digitalWrite(PIN_PWRKEY, HIGH);
  // 부팅 대기는 호출측에서
}

void setup() {
  // USB CDC Serial (Serial Monitor로)
  Serial.begin(115200);

  // OLED
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  strcpy(stateMsg, "pwr on");
  drawOled();

  // VBAT 공급 ON
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);

  // DTR low = awake
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, LOW);

  // PWRKEY 초기 HIGH로 (idle)
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, HIGH);
  delay(200);

  // LTE UART
  lte.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);

  // 초기 한 번 파워키 펄스
  Serial.println();
  Serial.println(F("=== ESP32-C3 + SIM7080G passthrough ==="));
  Serial.println(F("Monitor 115200, Both NL & CR"));
  Serial.println(F("Commands:"));
  Serial.println(F("  /pwr   -> pulse PWRKEY"));
  Serial.println(F("  /at    -> send AT"));
  Serial.println(F("  /reset -> reset counters"));
  Serial.println(F("  other  -> pass-through"));
  Serial.println();
  Serial.println(F("[LOCAL] initial PWRKEY pulse"));
  strcpy(stateMsg, "pwrkey");
  drawOled();
  pulsePwrKey();

  strcpy(stateMsg, "boot 5s");
  drawOled();
  Serial.println(F("[LOCAL] wait 5s for boot"));
  uint32_t t0 = millis();
  while (millis() - t0 < 5000) {
    while (lte.available()) {
      uint8_t b = lte.read();
      lastRxByte = b; rxBytesTotal++;
      Serial.write(b);
    }
    delay(5);
  }

  strcpy(stateMsg, "ready");
  drawOled();
  Serial.println();
  Serial.println(F("[LOCAL] sending AT..."));
  lte.println("AT");
  txBytesTotal += 4;
}

void loop() {
  // Modem -> PC (+ OLED 카운터)
  while (lte.available()) {
    uint8_t b = lte.read();
    lastRxByte = b;
    rxBytesTotal++;
    Serial.write(b);
  }

  // PC -> Modem (with 로컬 명령 처리)
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.length() == 0) return;

    if (cmd == "/pwr") {
      Serial.println(F("[LOCAL] PWRKEY pulse + wait 5s"));
      strcpy(stateMsg, "pwrkey"); drawOled();
      pulsePwrKey();
      strcpy(stateMsg, "boot 5s"); drawOled();
      delay(5000);
      strcpy(stateMsg, "ready"); drawOled();
      return;
    }
    if (cmd == "/at") {
      Serial.println(F("[LOCAL] AT"));
      lte.println("AT");
      txBytesTotal += 4;
      return;
    }
    if (cmd == "/reset") {
      rxBytesTotal = 0; txBytesTotal = 0; lastRxByte = 0;
      Serial.println(F("[LOCAL] counters reset"));
      return;
    }

    // passthrough
    lte.print(cmd);
    lte.print("\r\n");
    txBytesTotal += cmd.length() + 2;
  }

  // OLED 주기적 갱신
  static uint32_t lastDraw = 0;
  if (millis() - lastDraw > 300) {
    lastDraw = millis();
    drawOled();
  }
}
