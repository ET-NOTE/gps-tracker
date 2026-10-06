#pragma once
#include "EasyHttps.h"
#include "Enrollment.h"

// Shared by examples 04, 06 and 07. The complete ZIP contains these sources.
// Credentials stay inside this helper/EEPROM; the user copies only [REGISTER].
class ShieldSetup {
public:
  EasyHttps modem;
  Enrollment device;

  void begin() {
    Serial.begin(115200);
    enrolled = device.load();
    Serial.println(F("[AUTO v3] 1NCE setup. Upload unchanged."));
    if (enrolled) showCode();
    if (!modem.begin() || !modem.prepareCertificate()) {
      modem.printError(); stop();
    }
    Serial.println(F("[READY] Connecting to 1NCE. Keep the serial monitor open."));
  }

  // Reuse the caller's payload buffer; no second SRAM allocation on UNO.
  bool connect(char *buffer, uint16_t capacity) {
    nextWait = 60000UL;
    if (!modem.connect("iot.1nce.net")) {
      modem.printError();
      if (modem.needsReset()) stop();
      return false;
    }
    if (enrolled) return true;
    int status = modem.bootstrap(buffer, capacity);
    bool saved = status == 200 && device.saveResponse(buffer);
    memset(buffer, 0, capacity);
    if (!saved) {
      Serial.print(F("[REGISTER HTTPS] ")); Serial.println(status);
      if (status < 0) modem.printError();
      else Serial.println(F("Setup not completed. Will retry; no manual settings needed."));
      if (status == 429) nextWait = 900000UL;
      if (modem.needsReset()) stop();
      return false;
    }
    enrolled = true;
    showCode();
    return true;
  }

  int send(const char *body) {
    int status = modem.post(device.key, body);
    if (status < 0) modem.printError();
    else {
      Serial.print(F("[HTTPS] ")); Serial.println(status);
      if (status == 200) Serial.println(F("Saved. Open My devices / My data."));
      else if (status == 409) { showCode(); Serial.println(F("Waiting for web registration. Expired code? Type NEW + Enter.")); }
      else if (status == 401 || status == 403) Serial.println(F("Connection rejected or code expired. See the recovery guide."));
      else if (status == 429) { nextWait = 900000UL; Serial.println(F("Rate limited. Waiting 15 minutes.")); }
    }
    if (modem.needsReset()) stop();
    return status;
  }

  // Explicit recovery for an expired UNCLAIMED code, never an automatic reset.
  void pause() {
    uint8_t matched = 0;
    unsigned long start = millis();
    while (millis() - start < nextWait) {
      while (Serial.available()) {
        char c = Serial.read();
        if (c == '\r' || c == '\n') {
          if (matched == 3) {
            device.clear(); enrolled = false;
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

  static void stop() {
    Serial.println(F("[STOP] Check the message above, then reset UNO."));
    while (true) delay(1000);
  }

private:
  bool enrolled = false;
  unsigned long nextWait = 60000UL;
  void showCode() const {
    Serial.print(F("[REGISTER] "));
    for (uint8_t i = 0; i < 16; ++i) {
      if (i && i % 4 == 0) Serial.print('-');
      Serial.print(device.code[i]);
    }
    Serial.println();
    Serial.println(F("Open https://shield.serial.kr/devices > Register device."));
    Serial.println(F("Paste this code within 24 hours. Already registered? No action needed."));
  }
};
