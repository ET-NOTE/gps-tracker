// ESP32-C3 mini + SSD1306 OLED 128x64 I2C
// I2C: SDA=GPIO8, SCL=GPIO9
// Library: Adafruit SSD1306 + Adafruit GFX

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define PIN_SDA      8
#define PIN_SCL      9
#define OLED_ADDR    0x3C
#define OLED_W       128
#define OLED_H       64

Adafruit_SSD1306 display(OLED_W, OLED_H, &Wire, -1);

void setup() {
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    while (true) { delay(1000); }
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(F("ESP32-C3 GPS Tracker"));
  display.println(F("--------------------"));
  display.println(F("OLED: OK"));
  display.print(F("SDA="));  display.print(PIN_SDA);
  display.print(F(" SCL=")); display.println(PIN_SCL);
  display.print(F("ADDR=0x"));
  display.println(OLED_ADDR, HEX);
  display.display();
}

void loop() {
  static uint32_t t0 = millis();
  static uint32_t n = 0;
  n++;

  display.fillRect(0, 48, OLED_W, 16, SSD1306_BLACK);
  display.setCursor(0, 48);
  display.print(F("uptime: "));
  display.print((millis() - t0) / 1000);
  display.println(F("s"));
  display.print(F("tick  : "));
  display.println(n);
  display.display();

  delay(500);
}
