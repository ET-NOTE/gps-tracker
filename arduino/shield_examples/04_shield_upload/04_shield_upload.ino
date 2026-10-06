#include "src/ShieldSetup.h"
#include <DHT.h>

// 1NCE + UNO R3, DHT11 DATA on D2. Upload the complete ZIP unchanged.
// Install Adafruit DHT sensor library and Adafruit Unified Sensor first.
ShieldSetup shield;
DHT sensor(2, DHT11);
char body[448];

void setup() {
  sensor.begin();
  shield.begin();
  delay(2000);
}

void loop() {
  if (!shield.connect(body, sizeof(body))) {
    shield.pause();
    return;
  }
  float t = sensor.readTemperature(), h = sensor.readHumidity();
  uint32_t at = shield.modem.utcNow();
  if (!at || isnan(t) || isnan(h) || t < 0 || t > 50 || h < 0 || h > 100) {
    Serial.println(F("[DATA] Missing clock or valid DHT11 reading; nothing sent."));
    shield.pause();
    return;
  }
  char temp[12], hum[12];
  dtostrf(t, 1, 1, temp);
  dtostrf(h, 1, 1, hum);
  int n = snprintf_P(
      body, sizeof(body),
      PSTR(
          "{\"shield_v\":3,\"device_uid\":\"%s\",\"build_tag\":\"example-dht11-1\",\"ts\":%lu,"
          "\"csq\":%d,\"reg\":%d,\"diag\":{\"gnss\":0},\"points\":[],\"sensor_set\":\"dht11-example\","
          "\"channels\":[{\"key\":\"temperature\",\"label\":\"Temperature\",\"unit\":\"C\"},"
          "{\"key\":\"humidity\",\"label\":\"Humidity\",\"unit\":\"%%\"}],"
          "\"sensors\":[{\"at\":%lu,\"values\":{\"temperature\":%s,\"humidity\":%s}}]}"),
      shield.device.uid, millis() / 1000UL, shield.modem.signal, shield.modem.registration, at, temp, hum);
  if (n < 0 || n >= (int)sizeof(body)) {
    Serial.println(F("[STOP] Payload too large."));
    while (true)
      delay(1000);
  }
  shield.send(body);
  // Failed samples are not queued. The next cycle reads a fresh sensor value.
  shield.pause();
}
