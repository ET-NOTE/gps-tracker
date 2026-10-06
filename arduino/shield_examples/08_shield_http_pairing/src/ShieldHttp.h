#pragma once
#include <Arduino.h>
#include <SoftwareSerial.h>

namespace shield_http_example {
inline bool validApn(const char *s) {
  unsigned n = strlen(s);
  if (!n || n > 63 || strstr(s, "YOUR_")) return false;
  for (unsigned i = 0; i < n; ++i)
    if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z') ||
          (s[i] >= '0' && s[i] <= '9') || s[i] == '-' || s[i] == '_' || s[i] == '.')) return false;
  return true;
}
inline bool validUid(const char *s) {
  if (strlen(s) != 37 || strncmp(s, "demo-", 5)) return false;
  for (unsigned i = 5; i < 37; ++i)
    if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
  return true;
}
}

// Independent classroom HTTP driver. Does not alter TLS or certificate settings.
class ShieldHttp {
public:
  ShieldHttp() : uart(8, 9) {}
  bool begin();
  bool connect(const char *apn);
  int post(const char *body);
  void printError();
  bool needsReset() const { return lost || restarted; }
  int signal = 99, registration = -1;
private:
  enum Stage : uint8_t { MODEM, SIM, NETWORK, HTTP_CONFIG, HTTP_CONNECT, SEND, CLOSE };
  Stage stage = MODEM;
  SoftwareSerial uart;
  char line[128];
  uint8_t length = 0, reply = 0;
  bool overflow = false, restarted = false, lost = false, sim = false, pdp = false;
  bool prompt = false, wantPrompt = false;
  int state = -1, http = -1;
  uint32_t received = 0;
  void parse();
  void receive();
  void drain(uint32_t ms);
  bool wait(uint32_t timeout);
  void resetReply();
  bool command(const __FlashStringHelper *text, uint32_t timeout = 3000);
  bool commandRam(const char *text, uint32_t timeout = 3000);
  bool closeHttp();
};
