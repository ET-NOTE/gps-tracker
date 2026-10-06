// Install Adafruit DHT sensor library + Adafruit Unified Sensor with Library Manager.
#include <DHT.h>

const uint8_t DHT_PIN = 2; // Placeholder: change to your sensor's data pin (avoid D6-D9).
DHT sensor(DHT_PIN, DHT11);

void setup() {
  Serial.begin(115200);
  sensor.begin();
  delay(2000);
}

void loop() {
  float temperature = sensor.readTemperature(), humidity = sensor.readHumidity();
  if (isnan(temperature) || isnan(humidity))
    Serial.println(F("[DHT] Read failed. Check DATA/VCC/GND and pull-up."));
  else {
    Serial.print(F("temperature_c="));
    Serial.print(temperature, 1);
    Serial.print(F(" humidity_pct="));
    Serial.println(humidity, 1);
  }
  delay(2500); // DHT11 is slow. Do not poll in a tight loop.
}
