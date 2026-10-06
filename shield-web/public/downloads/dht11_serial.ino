#include <DHT.h>
DHT sensor(2, DHT11); // D2: modem D8/D9와 분리
void setup() { Serial.begin(115200); sensor.begin(); }
void loop() {
  delay(2500);
  float temperature = sensor.readTemperature();
  float humidity = sensor.readHumidity();
  if (isnan(temperature) || isnan(humidity)) {
    Serial.println("Sensor read failed"); return;
  }
  Serial.print(temperature); Serial.print(" C, ");
  Serial.print(humidity); Serial.println(" %");
}
