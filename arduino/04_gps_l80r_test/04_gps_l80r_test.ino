// ESP32-C3 mini + GPS L80-R (Quectel) + (선택) OLED
// GPS UART (9600 8N1, NMEA):
//   ESP RX = GPIO21  <- GPS TX
//   ESP TX = GPIO20  -> GPS RX
//   (배선 반대면 PIN_GPS_RX/TX 스왑)
// 전원제어 D6 (GPIO6): LOW=ON, HIGH=OFF. 시작시 LOW 줘서 GPS 켬.
//
// OLED 는 선택 — 미장착이면 Serial Monitor (115200) 만으로 디버그 가능.
// NMEA_ECHO 활성화하면 raw NMEA sentence 도 그대로 시리얼에 흘림.
//
// 라이브러리: TinyGPSPlus

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TinyGPSPlus.h>
#include <HardwareSerial.h>

#define PIN_SDA        8
#define PIN_SCL        9
#define OLED_ADDR      0x3C

#define PIN_PWR_EN     6      // GPS+LTE 전원 (LOW=ON)
#define PIN_GPS_RX    20      // ESP가 받는 쪽 (GPS TX -> ESP RX)
#define PIN_GPS_TX    21      // ESP가 보내는 쪽 (ESP TX -> GPS RX)
#define GPS_BAUD      9600

// 디버그 옵션 — 시리얼로 raw NMEA 까지 보고 싶을 때 1
#define NMEA_ECHO      0

Adafruit_SSD1306 display(128, 64, &Wire, -1);
bool oledOk = false;
TinyGPSPlus      gps;
HardwareSerial   gpsSerial(1);   // UART1

uint32_t bootMs       = 0;
uint32_t firstCharMs  = 0;
uint32_t firstFixMs   = 0;
uint32_t charsRx      = 0;
uint32_t sentencesOk  = 0;

void setup() {
  Serial.begin(115200);
  delay(2000);   // USB CDC 준비 대기
  Serial.println();
  Serial.println(F("=== 04 GPS L80-R standalone test ==="));
  Serial.printf("GPS UART: RX=GPIO%d  TX=GPIO%d  baud=%lu\n",
                PIN_GPS_RX, PIN_GPS_TX, (unsigned long)GPS_BAUD);
  Serial.printf("PWR_EN=GPIO%d (LOW=ON)\n", PIN_PWR_EN);

  // GPS 전원 ON
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);

  // OLED 선택 — I2C 응답 없으면 그냥 시리얼 단독으로 진행.
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  Wire.beginTransmission(OLED_ADDR);
  if (Wire.endTransmission() == 0) {
    oledOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  }
  Serial.printf("OLED@0x%02X: %s\n", OLED_ADDR, oledOk ? "OK" : "absent (serial-only)");
  if (oledOk) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println(F("GPS L80-R warm up"));
    display.println(F("waiting NMEA..."));
    display.display();
  }

  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  bootMs = millis();
  Serial.println(F("waiting NMEA..."));
}

void drawStatus() {
  if (!oledOk) return;
  display.clearDisplay();
  display.setCursor(0, 0);

  display.print(F("sat:"));
  display.print(gps.satellites.value());
  display.print(F(" fix:"));
  display.println(gps.location.isValid() ? F("Y") : F("N"));

  if (gps.location.isValid()) {
    display.print(F("LA "));
    display.println(gps.location.lat(), 5);
    display.print(F("LO "));
    display.println(gps.location.lng(), 5);
  } else {
    display.println(F("no fix"));
    display.println();
  }

  if (gps.time.isValid()) {
    display.print(F("UTC "));
    if (gps.time.hour() < 10) display.print('0');
    display.print(gps.time.hour());
    display.print(':');
    if (gps.time.minute() < 10) display.print('0');
    display.print(gps.time.minute());
    display.print(':');
    if (gps.time.second() < 10) display.print('0');
    display.println(gps.time.second());
  } else {
    display.println(F("UTC --:--:--"));
  }

  display.print(F("rx:"));
  display.print(charsRx);
  display.print(F(" ok:"));
  display.println(sentencesOk);

  display.print(F("ttfc:"));
  if (firstCharMs) {
    display.print((firstCharMs - bootMs) / 1000.0f, 1);
    display.print('s');
  } else {
    display.print('-');
  }
  display.print(F(" ttff:"));
  if (firstFixMs) {
    display.print((firstFixMs - bootMs) / 1000.0f, 1);
    display.print('s');
  } else {
    display.print('-');
  }

  display.display();
}

void loop() {
  while (gpsSerial.available()) {
    char c = gpsSerial.read();
    if (!firstCharMs) {
      firstCharMs = millis();
      Serial.printf("[+%.1fs] first NMEA char received\n",
                    (firstCharMs - bootMs) / 1000.0f);
    }
    #if NMEA_ECHO
    Serial.write(c);
    #endif
    charsRx++;
    if (gps.encode(c)) {
      sentencesOk++;
      if (!firstFixMs && gps.location.isValid()) {
        firstFixMs = millis();
        Serial.printf("[+%.1fs] *** FIRST FIX ***\n",
                      (firstFixMs - bootMs) / 1000.0f);
      }
    }
  }

  // OLED 갱신 250ms
  static uint32_t lastDraw = 0;
  if (millis() - lastDraw > 250) {
    lastDraw = millis();
    drawStatus();
  }

  // 시리얼 1초 한 줄 — OLED 없어도 좌표 / 위성 / TTFC / TTFF 확인 가능.
  static uint32_t lastLog = 0;
  uint32_t now = millis();
  if (now - lastLog >= 1000) {
    lastLog = now;
    const bool fix = gps.location.isValid();
    Serial.printf("[%lus] sat=%lu fix=%c lat=%.6f lng=%.6f alt=%.1fm hdop=%.1f rx=%lu ok=%lu",
                  now / 1000UL,
                  (unsigned long)gps.satellites.value(),
                  fix ? 'Y' : 'N',
                  fix ? gps.location.lat() : 0.0,
                  fix ? gps.location.lng() : 0.0,
                  gps.altitude.isValid() ? gps.altitude.meters() : 0.0,
                  gps.hdop.isValid() ? gps.hdop.hdop() : 0.0,
                  (unsigned long)charsRx,
                  (unsigned long)sentencesOk);
    if (gps.time.isValid() && gps.date.isValid()) {
      Serial.printf(" UTC=%04u-%02u-%02u %02u:%02u:%02u",
                    gps.date.year(), gps.date.month(), gps.date.day(),
                    gps.time.hour(), gps.time.minute(), gps.time.second());
    }
    Serial.printf(" ttfc=%s ttff=%s\n",
                  firstCharMs ? String((firstCharMs - bootMs) / 1000.0f, 1).c_str() : "-",
                  firstFixMs  ? String((firstFixMs  - bootMs) / 1000.0f, 1).c_str() : "-");
  }
}
