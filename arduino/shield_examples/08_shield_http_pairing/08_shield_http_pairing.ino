#include "src/ShieldHttp.h"
#include "src/DemoCodeInput.h"

// 1NCE + UNO R3: upload unchanged, then paste the classroom code in Serial.
ShieldHttp shield;
DemoCodeInput input;
char classroomCode[38] = {}; // RAM only; paste again after reset.
const char SHIELD_APN[] = "iot.1nce.net";

bool readCode() {
  bool changed = false;
  while (Serial.available()) {
    int result = input.feed(Serial.read(), classroomCode);
    if (result == 1) { Serial.println(F("[CODE] Accepted. Connecting...")); changed = true; }
    else if (result < 0) Serial.println(F("[CODE] Invalid. Copy the full classroom code, then Enter."));
  }
  return changed;
}

void waitForCode() {
  Serial.println(F("[CODE] My devices > HTTP learning: copy classroom code here + Enter."));
  while (!classroomCode[0]) { readCode(); delay(5); }
}

void pauseForCode(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    if (readCode()) return;
    delay(5);
  }
}
char payload[224];
const unsigned long SEND_INTERVAL_MS = 60000UL;
void stopHere() {
  Serial.println(F("[STOP] Fix the problem, then reset UNO."));
  while (true) delay(1000);
}
void setup() {
  Serial.begin(115200);
  Serial.println(F("[HTTP DEMO] Unencrypted, LTE status only. Use HTTPS for real data."));
  waitForCode();
  if (!shield.begin()) { shield.printError(); stopHere(); }
}
void loop() {
  if (!classroomCode[0]) waitForCode();
  if (!shield.connect(SHIELD_APN)) {
    shield.printError();
    if (shield.needsReset()) stopHere();
    pauseForCode(SEND_INTERVAL_MS); return;
  }
  int n = snprintf_P(payload, sizeof(payload),
      PSTR("{\"shield_v\":2,\"device_uid\":\"%s\",\"build_tag\":\"example-http-8\",\"ts\":%lu,"
           "\"csq\":%d,\"reg\":%d,\"diag\":{\"gnss\":0},\"points\":[]}"),
      classroomCode, millis() / 1000UL, shield.signal, shield.registration);
  if (n < 0 || n >= (int)sizeof(payload)) stopHere();
  int status = shield.post(payload);
  if (status < 0) shield.printError();
  else {
    Serial.print(F("[HTTP] ")); Serial.println(status);
    if (status == 200) Serial.println(F("Accepted. Check Shield > My devices > Last received."));
    else if (status == 401) {
      memset(classroomCode, 0, sizeof(classroomCode));
      Serial.println(F("[CODE] Expired or disabled. Create a new classroom code and paste here."));
      return;
    } else if (status >= 300 && status < 400) {
      Serial.println(F("Redirect not followed. Check current lesson endpoint.")); stopHere();
    } else if (status == 429) Serial.println(F("Rate limited. Wait 15 minutes."));
    else Serial.println(F("Not accepted. Check README and network."));
  }
  if (shield.needsReset()) { if (status >= 0) shield.printError(); stopHere(); }
  pauseForCode(status == 429 ? 900000UL : SEND_INTERVAL_MS);
}
