#include "src/ShieldSetup.h"

// 1NCE + UNO R3: upload the complete ZIP unchanged.
// Register once using the serial [REGISTER] code; no settings to fill in.
ShieldSetup shield;
char payload[256];

void setup() {
  shield.begin();
}

void loop() {
  if (!shield.connect(payload, sizeof(payload))) {
    shield.pause();
    return;
  }
  // Real LTE status only. This sketch does not send GPS or sensor values.
  int n = snprintf_P(
      payload, sizeof(payload),
      PSTR("{\"shield_v\":2,\"device_uid\":\"%s\",\"build_tag\":\"example-https-7\",\"ts\":%lu,"
           "\"csq\":%d,\"reg\":%d,\"diag\":{\"gnss\":0},\"points\":[]}"),
      shield.device.uid, millis() / 1000UL, shield.modem.signal, shield.modem.registration);
  if (n < 0 || n >= (int)sizeof(payload)) ShieldSetup::stop();
  shield.send(payload);
  shield.pause();
}
