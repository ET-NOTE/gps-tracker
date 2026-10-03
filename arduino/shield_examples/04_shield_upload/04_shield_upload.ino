#include "src/ShieldModem.h"
#include <DHT.h>
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

ShieldModem shield;
DHT sensor(DHT_DATA_PIN, DHT11);
char body[448]; // Maximum configured UID + two DHT channels fits; keep UNO SRAM for the stack.

void setup() {
  Serial.begin(115200);
  sensor.begin();
  if (!shield_example::safeToken(SHIELD_APN, 63) || !shield_example::safeToken(SHIELD_UID, 64) ||
      !shield_example::hexKey(SHIELD_KEY)) {
    Serial.println(F("[STOP] Copy config.example.h to config.h; replace YOUR_* values."));
    while (true)
      delay(1000);
  }
  if (!shield.begin())
    while (true)
      delay(1000);
  delay(2000);
}

void loop() {
  if (!shield.connectNetwork(SHIELD_APN)) {
    Serial.println(F("[NET] Check SIM/APN/antenna/NTP. If modem rebooted, reset UNO."));
    delay(SEND_INTERVAL_MS);
    return;
  }
  float t = sensor.readTemperature(), h = sensor.readHumidity();
  uint32_t at = shield.utcNow();
  if (!at || isnan(t) || isnan(h) || t < 0 || t > 50 || h < 0 || h > 100) {
    Serial.println(F("[DATA] Missing clock or valid DHT11 reading; nothing sent."));
    delay(SEND_INTERVAL_MS);
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
      SHIELD_UID, millis() / 1000UL, shield.signal, shield.registration, at, temp, hum);
  if (n < 0 || n >= (int)sizeof(body)) {
    Serial.println(F("[STOP] Payload too large."));
    while (true)
      delay(1000);
  }
  int status = shield.post(SHIELD_HOST, SHIELD_PATH, SHIELD_KEY, SHIELD_CA, body);
  Serial.print(F("[HTTP] "));
  Serial.println(status);
  Serial.println(status == 200
                     ? F("Saved. Open Shield > My data.")
                     : F("Not confirmed. Check README status table; no immediate retry."));
  delay(
      SEND_INTERVAL_MS); // Learning example: failed sample is not queued; next cycle takes a new sample.
}
