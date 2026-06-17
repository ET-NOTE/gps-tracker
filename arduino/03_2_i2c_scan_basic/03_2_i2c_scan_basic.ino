// 03_2 — 가장 단순한 I2C 스캐너 (0x01 ~ 0x7F)
//
// 목적: 어떤 응답기가 어느 주소에 있는지 확인만. 칩/라이브러리 가정 없음.
//
// 핀: SDA=GPIO8, SCL=GPIO9 (기존 13_1, 03_1 과 동일 — 우리 보드 표준)
// 속도: 100 kHz (검증용으로 보수적. 빠른 400 kHz 는 배선 marginal 할 때 false-NACK)
//
// 출력: 3초마다 한 사이클 — found 0 이면 1초 사이에 점진적으로 wedge 인지 알기 쉬움.
//
// 알려진 주소 힌트:
//   0x18/0x19 = LIS3DH       0x1D/0x1E = LIS3DSH
//   0x3C/0x3D = SSD1306 OLED 0x68      = MPU6050/RTC/...
//   0x76/0x77 = BMP/BME280

#include <Wire.h>

#define PIN_SDA  8
#define PIN_SCL  9

static const char* hintFor(uint8_t a) {
  switch (a) {
    case 0x18: case 0x19: return "LIS3DH";
    case 0x1D: case 0x1E: return "LIS3DSH";
    case 0x3C: case 0x3D: return "SSD1306 OLED";
    case 0x68:            return "MPU6050 / RTC / DS3231";
    case 0x76: case 0x77: return "BMP/BME280";
    default:              return nullptr;
  }
}

void setup() {
  Serial.begin(115200);
  delay(5000);  // CDC USB 시리얼 준비 (ESP32-C3 mini)
  Serial.println();
  Serial.println(F("=== 03_2 basic I2C scanner ==="));
  Serial.printf("SDA=GPIO%d  SCL=GPIO%d  speed=100kHz\n", PIN_SDA, PIN_SCL);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);
}

void loop() {
  uint32_t t = millis() / 1000UL;
  Serial.println();
  Serial.printf("[%lus] scanning 0x01..0x7F...\n", (unsigned long)t);

  uint8_t found = 0;
  for (uint8_t a = 0x01; a < 0x7F; a++) {
    Wire.beginTransmission(a);
    uint8_t err = Wire.endTransmission();
    if (err == 0) {
      const char* h = hintFor(a);
      if (h) Serial.printf("  -> 0x%02X  responder (likely: %s)\n", a, h);
      else   Serial.printf("  -> 0x%02X  responder\n", a);
      found++;
    } else if (err != 2) {
      // err: 0=OK / 1=data too long / 2=NACK on addr (정상 — 응답기 없음) /
      //      3=NACK on data / 4=other / 5=timeout
      Serial.printf("  ?  0x%02X  err=%u\n", a, err);
    }
  }

  Serial.printf("[%lus] total: %u device(s)\n", (unsigned long)t, found);
  delay(3000);
}
