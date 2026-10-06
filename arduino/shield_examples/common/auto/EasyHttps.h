#pragma once
#include <Arduino.h>
#include <SoftwareSerial.h>
#include "ShieldParsing.h"

// Shared verified-HTTPS educational driver for examples 04, 06 and 07.
// UNO R3, SIM7080G, D6 DTR, D7 PWRKEY, D8 RX / D9 TX at 9600 baud.
class EasyHttps {
public:
  EasyHttps() : uart(8, 9) {}
  bool begin();
  bool prepareCertificate();
  bool connect(const char *apn);
  uint32_t utcNow();
  int post(const char *key, const char *body);
  int bootstrap(char *response, uint16_t capacity);
  void printError();
  bool needsReset() const { return lost || restarted; }
  int signal = 99, registration = -1;

private:
  enum Stage : uint8_t { MODEM, SIM, NETWORK, CLOCK, CERTIFICATE, TLS_CONFIG, TLS_CONNECT, SEND, CLOSE };
  Stage stage = MODEM;
  SoftwareSerial uart;
  char line[128];
  uint8_t length = 0, reply = 0;
  bool overflow = false, restarted = false, lost = false, sim = false, pdp = false;
  bool prompt = false, wantPrompt = false, download = false, certificateReady = false;
  bool checkingCa = false, caStarted = false, caMismatch = false;
  uint16_t caOffset = 0;
  int fileSize = -1, state = -1, ntp = -1, http = -1;
  uint32_t received = 0, clock = 0;
  char *responseBuffer = nullptr;
  uint16_t responseCapacity = 0, responseRead = 0, responseRemaining = 0;
  int responseSize = -1;
  bool readingResponse = false, responseStarted = false;
  int exchange(const char *key, const char *body, bool enrollment);
  void parse();
  void receive();
  void drain(uint32_t ms);
  bool wait(uint32_t timeout);
  void resetReply();
  bool command(const __FlashStringHelper *text, uint32_t timeout = 3000);
  bool commandRam(const char *text, uint32_t timeout = 3000);
  bool closeHttp();
  bool matchesCertificate();
  bool writeCertificate();
  bool syncClock();
};
