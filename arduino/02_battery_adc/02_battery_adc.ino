// ESP32-C3 mini - Battery ADC on GPIO3 + OLED readout
// ADC1_CH3 (GPIO3)은 아날로그 입력 사용 가능
// 보통 배터리 측정은 분압 저항(예: 100k/100k = 2:1)을 거쳐 ADC 입력
// 실제 배터리 전압 = ADC_mV * DIV_RATIO

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define PIN_SDA      8
#define PIN_SCL      9
#define OLED_ADDR    0x3C

#define PIN_BAT      3
#define DIV_RATIO    2.0f   // TODO: 실제 분압비로 보정 (100k/100k면 2.0)
#define ADC_SAMPLES  16

Adafruit_SSD1306 display(128, 64, &Wire, -1);

static float readBatteryVoltage(uint16_t *rawOut, uint32_t *mvOut) {
  uint32_t rawSum = 0, mvSum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) {
    rawSum += analogRead(PIN_BAT);
    mvSum  += analogReadMilliVolts(PIN_BAT);
    delay(2);
  }
  uint16_t raw = rawSum / ADC_SAMPLES;
  uint32_t mv  = mvSum / ADC_SAMPLES;
  if (rawOut) *rawOut = raw;
  if (mvOut)  *mvOut  = mv;
  return (mv * DIV_RATIO) / 1000.0f;   // volts
}

// Li-ion 1셀 대략 추정 (4.20V=100%, 3.30V=0%) - 선형 근사
static uint8_t batteryPercent(float v) {
  if (v >= 4.20f) return 100;
  if (v <= 3.30f) return 0;
  return (uint8_t)((v - 3.30f) / (4.20f - 3.30f) * 100.0f);
}

void setup() {
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);

  analogReadResolution(12);            // 0..4095
  // 기본 11dB attenuation -> ~0..3.1V 측정 범위

  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
}

void loop() {
  uint16_t raw;
  uint32_t mv;
  float vbat = readBatteryVoltage(&raw, &mv);
  uint8_t pct = batteryPercent(vbat);

  display.clearDisplay();
  display.setCursor(0, 0);
  display.println(F("Battery ADC test"));
  display.println(F("----------------"));

  display.print(F("pin   : GPIO"));
  display.println(PIN_BAT);

  display.print(F("raw   : "));
  display.println(raw);

  display.print(F("pin mV: "));
  display.println(mv);

  display.print(F("VBAT  : "));
  display.print(vbat, 3);
  display.println(F(" V"));

  display.print(F("level : "));
  display.print(pct);
  display.println(F(" %"));

  display.display();
  delay(500);
}
