// ============================================================================
//  구형(舊) LTE 모듈 — 모뎀 "지속 통신" 테스트  (HW팀 전달용, 2026-07-08)
// ----------------------------------------------------------------------------
//  목적: 구형 모듈이 모뎀과 "지속적으로" 통신되는지 확인.
//        안테나 없이/실내에서도 됨 — 등록/외부통신은 필요 없고, AT 응답이
//        "계속" 오는지만 봄.
//
//  해석:
//    · AT 응답이 계속 옴(무응답 0s 유지)  → 모뎀 통신 정상.
//    · 초반엔 응답하다 곧 무응답으로 전환  → 슬립 아님(AT+CSCLK=0 로 배제함)
//                                          = 전원/접점(냉납·커넥터) 문제 지목.
//
//  핀맵(구형 모듈 = TX/RX 스왑 + DTR HIGH — 실기 확인값):
//    ESP RX = GPIO4  ← 모듈 TX
//    ESP TX = GPIO2  → 모듈 RX
//    DTR    = GPIO10 (HIGH 유지)
//    PWR_EN = GPIO6  (LOW = GPS+LTE 공유 레일 ON)
//    PWRKEY = GPIO7  (idle LOW, 펄스 HIGH)
//    BUZZER = GPIO1
//    모뎀 UART 보드레이트 = 115200
//
//  빌드/플래시:
//    Arduino IDE: 보드 "ESP32C3 Dev Module", "USB CDC On Boot: Enabled" 선택 후 업로드.
//    또는 arduino-cli:
//      compile -b esp32:esp32:esp32c3:CDCOnBoot=cdc  <이 폴더>
//      upload  -b esp32:esp32:esp32c3:CDCOnBoot=cdc -p COMxx  <이 폴더>
//    시리얼 모니터 115200 bps.
//
//  부저 신호:
//    · 부팅: 길게 삐—— 1회
//    · 모뎀 응답 지속 중: 매 ping 마다 아주 짧게 "틱" 1회(하트비트)
//    · 무응답 5초 이상: 길게 삐—— (경고) — 통신 끊김을 소리로 인지
// ============================================================================

#include <Arduino.h>
#include <HardwareSerial.h>

// ── 핀맵 (구형 모듈: 스왑 + DTR HIGH) ──
#define PIN_LTE_RX   4       // ESP RX ← 모듈 TX
#define PIN_LTE_TX   2       // ESP TX → 모듈 RX
#define PIN_DTR      10
#define PIN_PWR_EN   6       // LOW = 레일 ON
#define PIN_PWRKEY   7
#define PIN_BUZZER   1
#define LTE_BAUD     115200

// ★ PWRKEY 극성 — 신 모듈=0 (idle LOW/pulse HIGH). 구 모듈=1 (idle HIGH/pulse LOW).
//   (2026-07-08) 구모듈 03_5 자동탐지 결과 = 구모듈은 INVERT 필요. 틀리면 PWRKEY 를 잘못된
//   레벨로 붙잡아 SIM7080 이 장기 press 로 인식 → 전원 on/off 오락가락(리부트)/불안정.
#define PWRKEY_INVERT 1

static HardwareSerial modem(1);   // UART1
static String   lastResp;
static uint32_t okCount = 0, toCount = 0;
static uint32_t lastOkMs = 0, bootMs = 0;

// AT 트랜잭션: cmd 전송 후 timeoutMs 내 expect 문자열이 오면 true.
static bool sendAT(const char* cmd, const char* expect, uint32_t timeoutMs) {
  lastResp = "";
  if (cmd && *cmd) { Serial.print(F(">> ")); Serial.println(cmd); modem.print(cmd); modem.print("\r\n"); }
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    while (modem.available()) { char c = (char)modem.read(); if (c != '\r') lastResp += c; }
    if (expect && lastResp.indexOf(expect) >= 0) { Serial.print(F("<< ")); Serial.println(lastResp); return true; }
    delay(3);
  }
  Serial.print(F("<< (timeout) ")); Serial.println(lastResp);
  return false;
}

static void beep(int count, int onMs, int gapMs) {
  for (int i = 0; i < count; i++) {
    digitalWrite(PIN_BUZZER, HIGH); delay(onMs);
    digitalWrite(PIN_BUZZER, LOW);  if (i < count - 1) delay(gapMs);
  }
}

// 모듈 생존 확인: maxMs 동안 AT 주기 송신하며 OK 대기.
static bool modemProbe(uint32_t maxMs) {
  uint32_t t0 = millis(), lastPing = 0; String r = "";
  while (millis() - t0 < maxMs) {
    if (millis() - lastPing >= 700) { modem.print("AT\r\n"); lastPing = millis(); }
    while (modem.available()) { char c = (char)modem.read(); if (c != '\r') r += c; }
    if (r.indexOf("OK") >= 0) return true;
    delay(10);
  }
  return false;
}

static void powerOnModem() {
  pinMode(PIN_PWR_EN, OUTPUT); digitalWrite(PIN_PWR_EN, LOW);    // 레일 ON
  pinMode(PIN_DTR,    OUTPUT); digitalWrite(PIN_DTR,    HIGH);   // 구모듈 DTR HIGH
  const int pkIdle  = PWRKEY_INVERT ? HIGH : LOW;    // 구모듈=HIGH idle (반전)
  const int pkPulse = PWRKEY_INVERT ? LOW  : HIGH;
  pinMode(PIN_PWRKEY, OUTPUT); digitalWrite(PIN_PWRKEY, pkIdle);   // PWRKEY idle
  delay(500);
  Serial.printf("  PWRKEY 극성: invert=%d (idle=%s, pulse=%s)\n",
    PWRKEY_INVERT, pkIdle ? "HIGH" : "LOW", pkPulse ? "HIGH" : "LOW");
  Serial.println(F("  모듈 생존 확인(3s)..."));
  if (modemProbe(3000)) { Serial.println(F("  → 이미 ON (AT OK)")); return; }
  Serial.println(F("  → 무응답 → PWRKEY 펄스로 전원 ON 시도"));
  digitalWrite(PIN_PWRKEY, pkPulse); delay(1500); digitalWrite(PIN_PWRKEY, pkIdle);   // 전원 토글 펄스
  delay(3000);   // cold boot 대기
  if (modemProbe(8000)) Serial.println(F("  → ON (AT OK)"));
  else                  Serial.println(F("  → 여전히 무응답 (전원/접점 의심)"));
}

void setup() {
  bootMs = millis();
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);
  Serial.begin(115200); Serial.setTxTimeoutMs(0); delay(1500);
  Serial.println();
  Serial.println(F("=== 구형 LTE 모듈 모뎀 지속통신 테스트 (HW팀) ==="));
  Serial.println(F("  핀맵: RX=GPIO4 TX=GPIO2 (스왑) / DTR=GPIO10 HIGH / PWR_EN=GPIO6 LOW"));
  Serial.println(F("  기대: AT 응답이 '지속'되면 정상. 초반만 되고 끊기면 전원/접점(냉납) 의심."));
  beep(1, 600, 0);   // 부팅 길게 1회

  modem.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);
  powerOnModem();

  // 초기 시퀀스 + 슬립 비활성(DTR-sleep 요인 배제)
  sendAT("AT",         "OK",    2000);
  sendAT("ATE0",       "OK",    1000);
  sendAT("AT+CSCLK=0", "OK",    1000);   // ★ 슬립 끔 — 무응답이 사라지면 슬립, 그대로면 전원/접점
  sendAT("AT+CPIN?",   "READY", 5000);   // SIM 인식 확인(안테나 없어도 됨)
  Serial.println(F("  init 완료 → 2초마다 AT ping 으로 '지속 통신' 감시 시작"));
  Serial.println(F("  (아래 [MODEM] 줄의 '무응답 Ns' 가 계속 0 이면 정상, 늘어나면 통신 끊김)"));
}

void loop() {
  static uint32_t lastPing = 0;
  uint32_t now = millis();

  if (now - lastPing >= 2000) {          // 2초마다 AT ping
    lastPing = now;
    bool ok = sendAT("AT", "OK", 1000);
    if (ok) { okCount++; lastOkMs = now; } else { toCount++; }
    uint32_t silentS = lastOkMs ? (now - lastOkMs) / 1000 : (now - bootMs) / 1000;
    Serial.printf("  [MODEM] AT %s | OK=%lu timeout=%lu | 무응답 %lus\n",
      ok ? "응답O" : "무응답--", (unsigned long)okCount, (unsigned long)toCount, (unsigned long)silentS);
    if (ok)                 beep(1, 40, 0);    // 하트비트(짧은 틱)
    else if (silentS >= 5)  beep(1, 500, 0);   // 무응답 경고(긴 삐)
  }
}
