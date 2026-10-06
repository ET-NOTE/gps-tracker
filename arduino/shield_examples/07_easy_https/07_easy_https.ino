#include "src/EasyHttps.h"
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

EasyHttps shield;
char payload[256];
const unsigned long SEND_INTERVAL_MS = 60000UL;

void stopHere() {
  Serial.println(F("[STOP] Fix the problem, then reset UNO. No HTTP fallback."));
  while (true) delay(1000);
}

void setup() {
  Serial.begin(115200);
  if (!shield_example::safeToken(SHIELD_APN, 63) ||
      !shield_example::safeToken(SHIELD_UID, 64) ||
      !shield_example::hexKey(SHIELD_KEY)) {
    Serial.println(F("[CONFIG] Copy config.example.h to config.h and fill APN, UID, KEY."));
    stopHere();
  }

  // The SIM7080G handles TLS. Its public CA comes from this sketch's flash.
  // No Python, serial bridge, manual certificate download, or extra sensor.
  if (!shield.begin() || !shield.prepareCertificate()) {
    shield.printError();
    stopHere();
  }
  Serial.println(F("[READY] HTTPS example ready. Open Shield > My devices."));
}

void loop() {
  if (!shield.connect(SHIELD_APN)) {
    shield.printError();
    if (shield.needsReset()) stopHere();
    delay(SEND_INTERVAL_MS);
    return;
  }

  // Send actual LTE status only. This example does not invent GPS/sensor values.
  int n = snprintf_P(
      payload, sizeof(payload),
      PSTR("{\"shield_v\":2,\"device_uid\":\"%s\",\"build_tag\":\"example-https-7\",\"ts\":%lu,"
           "\"csq\":%d,\"reg\":%d,\"diag\":{\"gnss\":0},\"points\":[]}"),
      SHIELD_UID, millis() / 1000UL, shield.signal, shield.registration);
  if (n < 0 || n >= (int)sizeof(payload)) {
    Serial.println(F("[CONFIG] Payload too large."));
    stopHere();
  }

  int status = shield.post(SHIELD_KEY, payload);
  if (status < 0) {
    shield.printError();
  } else {
    Serial.print(F("[HTTPS] "));
    Serial.println(status);
    if (status == 200) Serial.println(F("Saved. Check My devices > Last received."));
    else if (status == 401 || status == 403) Serial.println(F("Check device UID / KEY (not login or claim code)."));
    else if (status == 409) Serial.println(F("Register this device in My devices first."));
    else if (status == 429) Serial.println(F("Too many requests. Wait before retrying."));
    else Serial.println(F("Not accepted. Check the README status table."));
  }
  if (shield.needsReset()) stopHere();
  // Wait, then send fresh status. No immediate retry or offline queue.
  delay(SEND_INTERVAL_MS);
}
