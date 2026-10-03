#include "src/ShieldModem.h"
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

ShieldModem shield;
char body[256]; // Includes the maximum 64-character UID; no synthetic sensor or position values.

void setup() {
  Serial.begin(115200);
  if (!shield_example::safeToken(SHIELD_APN, 63) || !shield_example::safeToken(SHIELD_UID, 64) ||
      !shield_example::hexKey(SHIELD_KEY)) {
    Serial.println(F("[STOP] Copy config.example.h to config.h; replace YOUR_* values."));
    while (true)
      delay(1000);
  }
  if (!shield.begin())
    while (true)
      delay(1000);
}

void loop() {
  if (!shield.connectNetwork(SHIELD_APN)) {
    Serial.println(F("[NET] Check SIM/APN/antenna/NTP. If modem rebooted, reset UNO."));
    delay(SEND_INTERVAL_MS);
    return;
  }
  int n = snprintf_P(
      body, sizeof(body),
      PSTR("{\"shield_v\":2,\"device_uid\":\"%s\",\"build_tag\":\"example-status-1\",\"ts\":%lu,"
           "\"csq\":%d,\"reg\":%d,\"diag\":{\"gnss\":0},\"points\":[]}"),
      SHIELD_UID, millis() / 1000UL, shield.signal, shield.registration);
  if (n < 0 || n >= (int)sizeof(body)) {
    Serial.println(F("[STOP] Payload too large."));
    while (true)
      delay(1000);
  }
  int status = shield.post(SHIELD_HOST, SHIELD_PATH, SHIELD_KEY, SHIELD_CA, body);
  Serial.print(F("[HTTP] "));
  Serial.println(status);
  Serial.println(status == 200 ? F("Saved. Open Shield > My devices > Last received.")
                               : F("Not confirmed. Check README; no immediate retry."));
  delay(SEND_INTERVAL_MS); // Next cycle sends fresh modem status. Failed reports are not queued.
}
