// HW팀 코드 변형 2: DTR·PWRKEY 만 반전, RX/TX(2/4)·IPR·IFC·RXbuf 그대로.
//  - PWRKEY: idle LOW → pulse HIGH → idle LOW (native, 원 코드의 반전)
//  - DTR(GPIO10): 구동 HIGH (원 코드는 미구동/floating → 반전으로 HIGH 인가)
#include <HardwareSerial.h>

#define PIN_LTE_RX   2
#define PIN_LTE_TX   4
#define PIN_DTR      10
#define PIN_PWR_EN   6
#define PIN_PWRKEY   7
#define PIN_BUZZER   1

HardwareSerial lteSerial(1);
unsigned long lastCheckTime = 0;
const unsigned long checkInterval = 5000;

bool sendATCommand(String cmd, String expected_resp, uint32_t timeout_ms) {
  while(lteSerial.available()) lteSerial.read();
  lteSerial.println(cmd);
  Serial.print("[" + String(millis()/1000) + "s] " + cmd + " 전송 -> ");
  uint32_t start_time = millis();
  String response = "";
  while (millis() - start_time < timeout_ms) {
    if (lteSerial.available()) { char c = lteSerial.read(); response += c; }
  }
  if (response.indexOf(expected_resp) != -1) { Serial.println("OK (정상 수신)"); return true; }
  else {
    Serial.print("오류! ");
    if(response.length() > 0) { response.replace("\r"," "); response.replace("\n"," "); response.trim(); Serial.println("[실제 응답: " + response + "]"); }
    else { Serial.println("[응답 없음]"); }
    return false;
  }
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("\n=== SIM7080G 변형2: DTR·PWR 반전 (RX2/TX4 유지) ===");

  pinMode(PIN_PWR_EN, OUTPUT);
  pinMode(PIN_PWRKEY, OUTPUT);
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, HIGH);        // ★ DTR 반전 = HIGH 구동

  // ★ PWRKEY 반전: idle LOW 로 두고, HIGH 펄스로 트리거 (LOW->HIGH->LOW)
  digitalWrite(PIN_PWRKEY, LOW);
  digitalWrite(PIN_PWR_EN, LOW);      // 전원 레일 ON
  delay(500);
  Serial.println("SIM7080G 켜기 트리거 (HIGH 펄스)...");
  digitalWrite(PIN_PWRKEY, HIGH);     // 누름
  delay(1200);
  digitalWrite(PIN_PWRKEY, LOW);      // 뗌 (이후 LOW 고정)

  Serial.println("모듈 부팅 대기 (8초)...");
  delay(8000);

  lteSerial.setRxBufferSize(1024);
  lteSerial.begin(115200, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);

  sendATCommand("AT", "OK", 1000);
  sendATCommand("AT", "OK", 1000);
  sendATCommand("AT+IPR=115200", "OK", 1000);
  sendATCommand("AT+IFC=0,0", "OK", 1000);
  sendATCommand("ATE0", "OK", 1000);
  Serial.println("설정 완료!");
}

void loop() {
  unsigned long currentMillis = millis();
  if (currentMillis - lastCheckTime >= checkInterval) {
    lastCheckTime = currentMillis;
    Serial.println("----------------------------------------");
    sendATCommand("AT", "OK", 1000);
    sendATCommand("AT+CSQ", "OK", 1000);
  }
  if (Serial.available()) { while (Serial.available()) { lteSerial.write(Serial.read()); } }
}
