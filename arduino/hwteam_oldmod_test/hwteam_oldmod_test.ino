#include <HardwareSerial.h>

#define PIN_LTE_RX   2
#define PIN_LTE_TX   4
#define PIN_DTR      10
#define PIN_PWR_EN   6
#define PIN_PWRKEY   7       // 이 핀의 동작 로직을 뒤집습니다.
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
    if (lteSerial.available()) {
      char c = lteSerial.read();
      response += c;
    }
  }

  if (response.indexOf(expected_resp) != -1) {
    Serial.println("OK (정상 수신)");
    return true;
  } else {
    Serial.print("오류! ");
    if(response.length() > 0) {
      response.replace("\r", " ");
      response.replace("\n", " ");
      response.trim();
      Serial.println("[실제 응답: " + response + "]");
    } else {
      Serial.println("[응답 없음]");
    }
    return false;
  }
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("\n=== SIM7080G PWRKEY 논리 반전 테스트 ===");

  pinMode(PIN_PWR_EN, OUTPUT);
  pinMode(PIN_PWRKEY, OUTPUT);

  // 1. 전원 초기화: PWRKEY를 평소 상태인 HIGH로 먼저 묶어둡니다.
  digitalWrite(PIN_PWRKEY, HIGH);
  digitalWrite(PIN_PWR_EN, LOW); // 전원 레일 ON
  delay(500);

  // 2. ★ PWRKEY 펄스 하강 트리거 (HIGH -> LOW -> HIGH)
  // 전원 버튼을 1.2초 동안 '꾹 눌렀다 떼는' 동작을 구현합니다.
  Serial.println("SIM7080G 켜기 트리거 (LOW 펄스)...");
  digitalWrite(PIN_PWRKEY, LOW);   // 버튼 누름
  delay(1200);
  digitalWrite(PIN_PWRKEY, HIGH);  // 버튼 뗌 (이후 HIGH로 계속 고정)

  Serial.println("모듈 부팅 및 망 접속 대기 중 (8초)...");
  delay(8000);

  lteSerial.setRxBufferSize(1024);
  lteSerial.begin(115200, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);

  // 초기화 명령어 고정
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

  if (Serial.available()) {
    while (Serial.available()) {
      lteSerial.write(Serial.read());
    }
  }
}
