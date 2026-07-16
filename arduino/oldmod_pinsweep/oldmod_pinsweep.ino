// ============================================================================
//  구모듈 SIM7080 핀맵 자동 스위프 (standalone C3, 브레드보드)
//  목적: AT 무응답 원인이 핀맵인지 찾기 — RX/TX(2·4↔4·2) x DTR(L/H) x PWRKEY(반전/native)
//        조합을 자동으로 훑어 "AT -> OK" 나오는 조합을 보고.
//  고정핀: PWRKEY=GPIO7, DTR=GPIO10, PWR_EN=GPIO6, BUZZER=GPIO1. UART 후보=GPIO2·4.
//  빌드: arduino-cli compile -b esp32:esp32:esp32c3:CDCOnBoot=cdc <folder>
//        upload  -b esp32:esp32:esp32c3:CDCOnBoot=cdc -p COMxx <folder>
//  모니터 115200. (전부 무응답이면 = 핀맵 아닌 물리 문제 → 화면 하단 체크리스트)
// ============================================================================
#include <Arduino.h>
#include <HardwareSerial.h>

#define PIN_PWR_EN 6
#define PIN_PWRKEY 7
#define PIN_DTR    10
#define PIN_BUZZER 1
#define LTE_BAUD   115200

HardwareSerial modem(1);
int wRx = -1, wTx = -1, wDtr = -1;   // 찾은 조합 저장

static void beep(int n, int on, int gap) {
  for (int i = 0; i < n; i++) { digitalWrite(PIN_BUZZER, HIGH); delay(on); digitalWrite(PIN_BUZZER, LOW); if (i < n - 1) delay(gap); }
}

// inv=1 => idle HIGH / pulse LOW (반전, 구모듈 예상) ; inv=0 => idle LOW / pulse HIGH (native)
static void pulsePwrkey(int inv) {
  int idle = inv ? HIGH : LOW, pulse = inv ? LOW : HIGH;
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, idle);  delay(200);
  digitalWrite(PIN_PWRKEY, pulse); delay(1200);
  digitalWrite(PIN_PWRKEY, idle);
}

static bool tryCombo(int rx, int tx, int dtrHigh) {
  pinMode(PIN_DTR, OUTPUT); digitalWrite(PIN_DTR, dtrHigh ? HIGH : LOW);
  modem.end(); delay(60);
  modem.begin(LTE_BAUD, SERIAL_8N1, rx, tx);
  delay(200);
  for (int k = 0; k < 3; k++) {
    while (modem.available()) modem.read();
    modem.print("AT\r\n");
    String r = ""; uint32_t t0 = millis();
    while (millis() - t0 < 800) { while (modem.available()) { char c = modem.read(); if (c != '\r') r += c; } }
    r.replace("\n", " "); r.trim();
    Serial.printf("   rx=%d tx=%d dtr=%s AT#%d -> [%s]\n", rx, tx, dtrHigh ? "HIGH" : "LOW", k + 1, r.length() ? r.c_str() : "(무응답)");
    if (r.indexOf("OK") >= 0) { wRx = rx; wTx = tx; wDtr = dtrHigh; return true; }
  }
  return false;
}

static bool sweep(const char* phase) {
  Serial.printf("== %s ==\n", phase);
  int rxs[2] = {2, 4}, txs[2] = {4, 2};
  for (int i = 0; i < 2; i++)
    for (int d = 0; d < 2; d++)
      if (tryCombo(rxs[i], txs[i], d)) {
        Serial.printf(">>> FOUND: RX=%d TX=%d DTR=%s  (%s) <<<\n", rxs[i], txs[i], d ? "HIGH" : "LOW", phase);
        beep(3, 120, 120);
        return true;
      }
  return false;
}

void setup() {
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_PWR_EN, OUTPUT); digitalWrite(PIN_PWR_EN, LOW);   // 레일 ON(배선됐으면)
  Serial.begin(115200); Serial.setTxTimeoutMs(0); delay(1800);
  Serial.println();
  Serial.println("=== 구모듈 핀맵 자동 스위프 (SIM7080 AT 탐색) ===");
  Serial.println("고정핀: PWRKEY=7 DTR=10 PWR_EN=6 BUZZER=1 / UART 후보 GPIO2·4");
  beep(1, 500, 0);

  bool found = sweep("Phase0: 펄스없이(이미 ON 가정)");
  if (!found) { Serial.println("-- PWRKEY 반전 펄스(HIGH->LOW->HIGH) 후 6s --"); pulsePwrkey(1); delay(6000); found = sweep("Phase1: 반전펄스 후"); }
  if (!found) { Serial.println("-- PWRKEY native 펄스(LOW->HIGH->LOW) 후 6s --"); pulsePwrkey(0); delay(6000); found = sweep("Phase2: native펄스 후"); }

  if (!found) {
    Serial.println();
    Serial.println("xxx 모든 조합(RX/TX x DTR x PWRKEY 2극성) 무응답 xxx");
    Serial.println("=> 핀맵 문제 아닐 가능성 큼. 물리 점검:");
    Serial.println("   1) SIM7080 5V 어댑터 ON + 모듈 전원 LED?");
    Serial.println("   2) ESP GPIO7(PWRKEY) -> 모듈 PWRKEY 배선?");
    Serial.println("   3) ESP GPIO2/4 <-> 모듈 TXD/RXD 실제 연결(크로스)?");
    Serial.println("   4) GND 공통 확실?(브레드보드 접점)");
  } else {
    Serial.printf("\n★ 최종: RX=%d TX=%d DTR=%s — 이후 2초마다 AT 핑\n", wRx, wTx, wDtr ? "HIGH" : "LOW");
  }
}

void loop() {
  if (wRx < 0) { delay(1000); return; }
  static uint32_t last = 0;
  if (millis() - last >= 2000) {
    last = millis();
    while (modem.available()) modem.read();
    modem.print("AT\r\n");
    String r = ""; uint32_t t0 = millis();
    while (millis() - t0 < 800) { while (modem.available()) { char c = modem.read(); if (c != '\r') r += c; } }
    r.replace("\n", " "); r.trim();
    bool ok = r.indexOf("OK") >= 0;
    Serial.printf("[PING] rx=%d tx=%d -> %s [%s]\n", wRx, wTx, ok ? "OK" : "무응답", r.c_str());
    if (ok) beep(1, 40, 0);
  }
}
