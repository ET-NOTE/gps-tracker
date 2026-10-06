#include "src/EasyHttps.h"
#include "src/Enrollment.h"

// 1NCE SIM + Arduino UNO: upload the complete ZIP without editing this sketch.
// The modem receives individual credentials through verified HTTPS, once.
const char SHIELD_APN[] = "iot.1nce.net";
EasyHttps shield;
Enrollment enrollment;
#define SHIELD_UID enrollment.uid
char payload[256];
const unsigned long SEND_INTERVAL_MS = 60000UL;
bool enrolled = false;

void stopHere() {
  Serial.println(F("[STOP] Check the message above, then reset UNO."));
  while (true) delay(1000);
}

void showCode() {
  Serial.print(F("[REGISTER] "));
  for (uint8_t i = 0; i < 16; ++i) {
    if (i && i % 4 == 0) Serial.print('-');
    Serial.print(enrollment.code[i]);
  }
  Serial.println();
  Serial.println(F("Open https://shield.serial.kr/devices > Register device."));
  Serial.println(F("Paste this code within 24 hours. Already registered? No action needed."));
}

// Explicit recovery only; resets this example's identity, not server history.
// Type NEW followed by Enter when an UNCLAIMED registration code has expired.
void pauseWithRecovery(unsigned long ms) {
  uint8_t matched = 0;
  unsigned long start = millis();
  while (millis() - start < ms) {
    while (Serial.available()) {
      char c = Serial.read();
      if (c == '\r' || c == '\n') {
        if (matched == 3) {
          enrollment.clear(); enrolled = false;
          Serial.println(F("[NEW] New identity requested. Old server data is retained."));
          return;
        }
        matched = 0;
      } else if (matched < 3 && c == "NEW"[matched]) ++matched;
      else matched = 255;
    }
    delay(5);
  }
}

void setup() {
  Serial.begin(115200);
  enrolled = enrollment.load();
  Serial.println(F("[07 v2] 1NCE auto setup. No config.h, UID or KEY entry."));
  if (enrolled) showCode();
  if (!shield.begin() || !shield.prepareCertificate()) {
    shield.printError(); stopHere();
  }
  Serial.println(F("[READY] Connecting to 1NCE. Keep the serial monitor open."));
}

void loop() {
  if (!shield.connect(SHIELD_APN)) {
    shield.printError();
    if (shield.needsReset()) stopHere();
    pauseWithRecovery(SEND_INTERVAL_MS); return;
  }
  if (!enrolled) {
    int status = shield.bootstrap(payload, sizeof(payload));
    if (status != 200 || !enrollment.saveResponse(payload)) {
      memset(payload, 0, sizeof(payload));
      Serial.print(F("[REGISTER HTTPS] ")); Serial.println(status);
      shield.printError();
      if (shield.needsReset()) stopHere();
      pauseWithRecovery(SEND_INTERVAL_MS); return;
    }
    memset(payload, 0, sizeof(payload));
    enrolled = true;
    showCode();
  }

  // Real LTE status only; no fabricated GPS or sensor values.
  int n = snprintf_P(
      payload, sizeof(payload),
      PSTR("{\"shield_v\":2,\"device_uid\":\"%s\",\"build_tag\":\"example-https-7\",\"ts\":%lu,"
           "\"csq\":%d,\"reg\":%d,\"diag\":{\"gnss\":0},\"points\":[]}"),
      SHIELD_UID, millis() / 1000UL, shield.signal, shield.registration);
  if (n < 0 || n >= (int)sizeof(payload)) stopHere();
  int status = shield.post(enrollment.key, payload);
  if (status < 0) shield.printError();
  else {
    Serial.print(F("[HTTPS] ")); Serial.println(status);
    if (status == 200) Serial.println(F("Saved. Open My devices > Last received."));
    else if (status == 409) { showCode(); Serial.println(F("Waiting for web registration. Expired code? Type NEW + Enter.")); }
    else if (status == 401 || status == 403) Serial.println(F("Credential rejected or code expired. See the recovery guide; do not edit UID/KEY."));
    else if (status == 429) Serial.println(F("Too many requests. Waiting before retry."));
  }
  if (shield.needsReset()) stopHere();
  pauseWithRecovery(SEND_INTERVAL_MS);
}
