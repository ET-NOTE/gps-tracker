// 03_7 — LC86G baud 변경 유틸 (persistence 시도).
//
// (2026-07-01) 방향 반전: aa 에 이전에 9600→115200 로 변경 후 persistence 성공.
// 그러나 사용자가 "9600 유지 = 절대 원칙 (롤백 위험 0 이 아니므로 115200 금지)" 결정
// → 이 sketch 로 다시 **115200 → 9600** 로 되돌린다.
//
// 동작:
//   1. 115200 로 UART open (LC86G 현재 상태)
//   2. $PAIR864,0,0,9600*13 전송 (baud 변경)
//   3. $PAIR002*38 (flash 저장) 전송
//   4. 9600 로 재-open + NMEA 흐름 확인
//   5. 재부팅 (USB 재삽입) 후 9600 유지 확인 (13_4_aa GPS_BAUD=9600 로 flash 후 동작 확인).

#include <HardwareSerial.h>

#define PIN_PWR_EN  6
#define PIN_GPS_RX 20
#define PIN_GPS_TX 21

HardwareSerial gpsSerial(1);

// (2026-07-01) 115200 → 9600 로 되돌림.
// PAIR864 checksum "PAIR864,0,0,9600" = 0x13.
const char CMD_SET_BAUD[] = "$PAIR864,0,0,9600*13\r\n";

// PAIR513 = query internal antenna (부수적 확인)
const char CMD_QUERY_ANT[] = "$PAIR513,1*20\r\n";

// PAIR002 = save current config to flash (Quectel LC86G persistent)
// checksum = P^A^I^R^0^0^2 = 0x50^0x41^0x49^0x52^0x30^0x30^0x32 = ?
// 0x50^0x41=0x11, ^0x49=0x58, ^0x52=0x0A, ^0x30=0x3A, ^0x30=0x0A, ^0x32=0x38
// → 0x38
const char CMD_SAVE[] = "$PAIR002*38\r\n";

static void relayFor(uint32_t ms) {
  uint32_t start = millis();
  while (millis() - start < ms) {
    while (gpsSerial.available()) {
      int c = gpsSerial.read();
      if (c >= 0) Serial.write((uint8_t)c);
    }
    delay(1);
  }
}

void setup() {
  Serial.begin(115200);
  delay(3000);
  Serial.println();
  Serial.println(F("=== 03_7 LC86G baud 115200 → 9600 되돌리기 ==="));

  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);
  Serial.println(F("[PWR] PWR_EN=LOW (모듈 ON)"));
  delay(1500);

  // Step 1: 115200 로 open (LC86G 현재 상태)
  Serial.println(F("[STEP1] gpsSerial 115200 baud open"));
  gpsSerial.begin(115200, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  delay(500);
  Serial.println(F("[STEP1] NMEA 3s drain:"));
  relayFor(3000);

  // Step 2: baud 변경 명령 전송 (→ 9600)
  Serial.println();
  Serial.printf("[STEP2] TX: %s", CMD_SET_BAUD);
  gpsSerial.print(CMD_SET_BAUD);
  gpsSerial.flush();
  Serial.println(F("[STEP2] 응답 대기 2s (아직 115200):"));
  relayFor(2000);

  // Step 3: 9600 로 재-open
  Serial.println();
  Serial.println(F("[STEP3] gpsSerial 9600 baud 재-open"));
  gpsSerial.end();
  delay(100);
  gpsSerial.begin(9600, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  delay(300);

  Serial.println(F("[STEP3] NMEA 5s 확인 (9600 정상 문장 보여야):"));
  relayFor(5000);

  // ── Step 4: flash 저장 시도 ────────────────────
  Serial.println();
  Serial.printf("[STEP4] TX: %s", CMD_SAVE);
  gpsSerial.print(CMD_SAVE);
  gpsSerial.flush();
  Serial.println(F("[STEP4] flash save 응답 3s:"));
  relayFor(3000);

  // ── Step 5: 안테나 query ───────────────────────
  Serial.println();
  Serial.printf("[STEP5] TX: %s", CMD_QUERY_ANT);
  gpsSerial.print(CMD_QUERY_ANT);
  relayFor(2000);

  Serial.println();
  Serial.println(F("[DONE] setup 완료 — loop 에서 NMEA relay 계속"));
  Serial.println(F("       재부팅 후에도 9600 유지되면 flash 저장 성공."));
  Serial.println();
}

void loop() {
  while (gpsSerial.available()) {
    int c = gpsSerial.read();
    if (c >= 0) Serial.write((uint8_t)c);
  }
  delay(1);
}
