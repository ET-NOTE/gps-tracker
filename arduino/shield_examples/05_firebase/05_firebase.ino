#include "src/ShieldModem.h"
#include <DHT.h>
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

ShieldModem shield;
DHT sensor(DHT_DATA_PIN, DHT11);
char body[240];

void setup() {
  Serial.begin(115200);
  sensor.begin();
  if (!shield_example::safeToken(SHIELD_APN, 63) || !shield_example::safeToken(FIREBASE_HOST, 95) ||
      !shield_example::safeToken(FIREBASE_DEVICE_ID, 40) ||
      !shield_example::hexKey(FIREBASE_DEVICE_KEY)) {
    Serial.println(F("[STOP] Complete Firebase setup and replace config.h placeholders."));
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
    Serial.println(F("[NET] SIM/APN/NTP failed. If modem rebooted, reset UNO."));
    delay(SEND_INTERVAL_MS);
    return;
  }
  float t = sensor.readTemperature(), h = sensor.readHumidity();
  uint32_t at = shield.utcNow();
  if (!at || isnan(t) || isnan(h) || t < 0 || t > 50 || h < 0 || h > 100) {
    Serial.println(F("[DATA] Valid sensor and UTC required."));
    delay(SEND_INTERVAL_MS);
    return;
  }
  char temp[12], hum[12];
  dtostrf(t, 1, 1, temp);
  dtostrf(h, 1, 1, hum);
  int n =
      snprintf_P(body, sizeof(body),
                 PSTR("{\"device_id\":\"%s\",\"at\":%lu,\"temperature_c\":%s,\"humidity_pct\":%s}"),
                 FIREBASE_DEVICE_ID, at, temp, hum);
  if (n < 0 || n >= (int)sizeof(body)) {
    Serial.println(F("[STOP] Payload too large."));
    while (true)
      delay(1000);
  }
  int status = shield.post(FIREBASE_HOST, FIREBASE_PATH, FIREBASE_DEVICE_KEY, FIREBASE_CA, body);
  Serial.print(F("[FIREBASE HTTP] "));
  Serial.println(status);
  Serial.println(status == 200
                     ? F("Saved. Open Firestore > shieldDevices > your device > latest/sample.")
                     : F("Not confirmed. See README; no immediate retry."));
  delay(SEND_INTERVAL_MS); // No automatic duplicate retry or indefinite history collection.
}
