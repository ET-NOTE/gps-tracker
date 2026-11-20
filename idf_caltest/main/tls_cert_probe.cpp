// Explicit hardware certificate-test entry point; never runs the tracker loop.
#include <Arduino.h>
#include "config.h"
#include "firmware_info.h"
#include "hw_power.h"
#include "buzzer.h"
#include "loopwdt.h"
#include "lte.h"
#if !GPS_TLS_CERT_TEST || !GPS_HTTPS_PILOT || !SLEEP_DISABLED
#error "This entry point is only for the awake certificate-test profile"
#endif

void setup() {
  buzzer::init();
  Serial.begin(115200);
  Serial.setTxTimeoutMs(50);
  delay(2000);
  Serial.println(firmware::settings);
  Serial.println("[CERT-TEST] NO credentials, GPS collection or production ingest");
  lwdt::arm();
  hw_power::init();
  hw_power::railOn();
  lte::init();
}

void loop() {
  lwdt::feed();
  static bool ready = false;
  if (!ready) {
    ready = lte::bringUp();
    if (ready) {
      lte::fetchBandInfo();
      Serial.println("[CERT-READY] Send RUN followed by newline for one fresh TLS probe");
    }
    delay(1000);
    return;
  }
  static String command;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (command == "RUN") {
        Serial.println("[CERT-BEGIN]");
        lte::certificateProbe();
        Serial.println("[CERT-END]");
      }
      command = "";
    } else if (command.length() < 16) command += c;
    else command = "invalid";
  }
  delay(10);
}
