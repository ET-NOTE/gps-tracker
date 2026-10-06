#include "src/ShieldHttp.h"
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

ShieldHttp shield;
char payload[224];
const unsigned long SEND_INTERVAL_MS = 60000UL;
void stopHere() {
  Serial.println(F("[STOP] Fix the problem, then reset UNO."));
  while (true) delay(1000);
}
void setup() {
  Serial.begin(115200);
  if (!shield_http_example::validApn(SHIELD_APN) || !shield_http_example::validUid(SHIELD_DEMO_UID)) {
    Serial.println(F("[CONFIG] Set APN and the 24-hour demo UID in config.h."));
    stopHere();
  }
  Serial.println(F("[HTTP DEMO] Unencrypted, LTE status only. Use HTTPS for real data."));
  if (!shield.begin()) { shield.printError(); stopHere(); }
}
void loop() {
  if (!shield.connect(SHIELD_APN)) {
    shield.printError();
    if (shield.needsReset()) stopHere();
    delay(SEND_INTERVAL_MS); return;
  }
  int n = snprintf_P(payload, sizeof(payload),
      PSTR("{\"shield_v\":2,\"device_uid\":\"%s\",\"build_tag\":\"example-http-8\",\"ts\":%lu,"
           "\"csq\":%d,\"reg\":%d,\"diag\":{\"gnss\":0},\"points\":[]}"),
      SHIELD_DEMO_UID, millis() / 1000UL, shield.signal, shield.registration);
  if (n < 0 || n >= (int)sizeof(payload)) stopHere();
  int status = shield.post(payload);
  if (status < 0) shield.printError();
  else {
    Serial.print(F("[HTTP] ")); Serial.println(status);
    if (status == 200) Serial.println(F("Accepted. Check Shield > My devices > Last received."));
    else if (status == 401) {
      Serial.println(F("Demo UID expired/disabled. Enable HTTP learning and update config.h."));
      stopHere();
    } else if (status >= 300 && status < 400) {
      Serial.println(F("Redirect not followed. Check current lesson endpoint.")); stopHere();
    } else if (status == 429) Serial.println(F("Rate limited. Wait 15 minutes."));
    else Serial.println(F("Not accepted. Check README and network."));
  }
  if (shield.needsReset()) { if (status >= 0) shield.printError(); stopHere(); }
  delay(status == 429 ? 900000UL : SEND_INTERVAL_MS);
}
