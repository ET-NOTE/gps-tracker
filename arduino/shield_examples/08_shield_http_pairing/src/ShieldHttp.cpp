#include "ShieldHttp.h"
#include <stdio.h>

void ShieldHttp::parse() {
  if (!strcmp(line, "OK")) reply = 1;
  else if (!strcmp(line, "ERROR") || !strncmp(line, "+CME ERROR:", 11)) reply = 2;
  if (!strcmp(line, "RDY")) { restarted = true; sim = pdp = false; }
  int a, b;
  if (sscanf(line, "+CSQ: %d,%d", &a, &b) == 2) signal = a;
  if (sscanf(line, "+CEREG: %d,%d", &a, &b) == 2) registration = b;
  if (!strncmp(line, "+CPIN:", 6)) { const char *p = line + 6; while (*p == ' ') ++p; sim = !strcmp(p, "READY"); }
  if (sscanf(line, "+CNACT: %d,%d", &a, &b) == 2 && a == 0) pdp = b == 1;
  if (sscanf(line, "+SHSTATE: %d", &a) == 1) state = a;
  if (!strncmp(line, "+SHREQ:", 7)) { const char *p = strchr(line, ','); if (p) http = atoi(p + 1); }
}
void ShieldHttp::receive() {
  while (uart.available()) {
    char c = uart.read(); ++received;
    if (wantPrompt && c == '>') { prompt = true; wantPrompt = false; }
    if (c == '\r' || c == '\n') {
      if (length && !overflow) { line[length] = 0; parse(); }
      length = 0; overflow = false;
    } else if (!overflow) {
      if (length < sizeof(line) - 1) line[length++] = c;
      else overflow = true;
    }
  }
}
void ShieldHttp::drain(uint32_t ms) {
  uint32_t start = millis(); while (millis() - start < ms) receive();
}
void ShieldHttp::resetReply() { reply = 0; length = 0; overflow = false; }
bool ShieldHttp::wait(uint32_t timeout) {
  uint32_t start = millis();
  while (!reply && !restarted && millis() - start < timeout) receive();
  if (!reply) lost = true;
  return reply == 1 && !needsReset();
}
bool ShieldHttp::command(const __FlashStringHelper *text, uint32_t timeout) {
  if (needsReset()) return false;
  drain(60); if (needsReset()) return false;
  resetReply(); uart.print(text); uart.print('\r'); return wait(timeout);
}
bool ShieldHttp::commandRam(const char *text, uint32_t timeout) {
  if (needsReset()) return false;
  drain(60); if (needsReset()) return false;
  resetReply(); uart.print(text); uart.print('\r'); return wait(timeout);
}
bool ShieldHttp::begin() {
  stage = MODEM;
  digitalWrite(7, LOW); pinMode(7, OUTPUT);
  digitalWrite(6, HIGH); pinMode(6, OUTPUT);
  const uint32_t rates[] = {9600, 115200, 19200, 38400, 57600};
  bool ready = false;
  for (uint8_t i = 0; i < 5 && !ready; ++i) {
    uart.end(); uart.begin(rates[i]); drain(800);
    lost = restarted = false;
    ready = command(F("AT"), 1500);
    if (ready && rates[i] != 9600) {
      if (!command(F("AT+IPR=9600"))) return false;
      uart.end(); uart.begin(9600); ready = command(F("AT"));
    }
  }
  if (!ready && !received) {
    uart.end(); uart.begin(9600);
    digitalWrite(7, HIGH); drain(1500); digitalWrite(7, LOW); drain(12000);
    lost = restarted = false; ready = command(F("AT"));
  }
  return ready && command(F("ATE0")) && command(F("AT+IFC=0,0")) &&
         command(F("AT+CMEE=2")) && command(F("AT+CSCLK=0")) && command(F("AT+CGNSPWR=0"));
}
bool ShieldHttp::closeHttp() {
  state = -1; if (!command(F("AT+SHSTATE?"))) return false;
  if (state == 0) return true;
  if (!command(F("AT+SHDISC"), 10000)) return false;
  state = -1; return command(F("AT+SHSTATE?")) && state == 0;
}
bool ShieldHttp::connect(const char *apn) {
  stage = NETWORK;
  if (!shield_http_example::validApn(apn) || needsReset() || !closeHttp()) return false;
  stage = SIM; sim = false;
  if (!command(F("AT+CPIN?")) || !sim) return false;
  stage = NETWORK; registration = -1;
  uint32_t start = millis();
  do {
    if (!command(F("AT+CEREG?"))) return false;
    if (registration == 1 || registration == 5) break;
    drain(2000);
  } while (!needsReset() && millis() - start < 90000UL);
  if (registration != 1 && registration != 5) return false;
  signal = 99; if (!command(F("AT+CSQ"))) return false;
  pdp = false; if (!command(F("AT+CNACT?"))) return false;
  if (!pdp) {
    char cmd[100];
    snprintf_P(cmd, sizeof(cmd), PSTR("AT+CNCFG=0,1,\"%s\""), apn);
    if (!commandRam(cmd) || !command(F("AT+CNACT=0,1"), 20000)) return false;
    drain(1000); pdp = false;
    if (!command(F("AT+CNACT?")) || !pdp) return false;
  }
  return true; // Receipt-time status does not require NTP or a certificate clock.
}
int ShieldHttp::post(const char *body) {
  stage = HTTP_CONFIG;
  if (strlen(body) > 224 || needsReset()) return -1;
  int result = -1;
  do {
    // HTTP is explicit, not a fallback. Stored TLS/CA settings are untouched.
    if (!command(F("AT+SHCONF=\"URL\",\"http://shield.serial.kr\"")) ||
        !command(F("AT+SHCONF=\"BODYLEN\",224")) ||
        !command(F("AT+SHCONF=\"HEADERLEN\",200"))) break;
    stage = HTTP_CONNECT;
    if (!command(F("AT+SHCONN"), 60000)) break;
    state = -1; if (!command(F("AT+SHSTATE?")) || state != 1) break;
    stage = SEND;
    // SIMCom requires SHCHEAD after SHCONN. Clear old headers before any SHREQ.
    if (!command(F("AT+SHCHEAD")) ||
        !command(F("AT+SHAHEAD=\"Content-Type\",\"application/json\""))) break;
    drain(60); resetReply(); prompt = false; wantPrompt = true; http = -1;
    uart.print(F("AT+SHBOD=")); uart.print(strlen(body)); uart.print(F(",10000\r"));
    uint32_t start = millis();
    while (!prompt && reply != 2 && !restarted && millis() - start < 3000) receive();
    wantPrompt = false;
    if (!prompt || needsReset()) { lost = true; break; }
    resetReply(); uart.print(body);
    if (!wait(10000) || !command(F("AT+SHREQ=\"/ingest/shield-demo\",3"), 15000)) break;
    start = millis();
    while (http < 0 && !restarted && millis() - start < 45000UL) receive();
    if (http < 0) lost = true;
    if (!needsReset()) result = http;
  } while (false);
  Stage failure = stage;
  if (!needsReset() && !closeHttp()) { stage = CLOSE; lost = true; return result; }
  stage = failure; return result;
}
void ShieldHttp::printError() {
  if (restarted) { Serial.println(F("[MODEM] Modem restarted. Check power and reset UNO.")); return; }
  switch (stage) {
    case MODEM: Serial.println(F("[MODEM] Check power / pins / baud.")); break;
    case SIM: Serial.println(F("[SIM] Check insertion / PIN / activation.")); break;
    case NETWORK: Serial.println(F("[NET] Check APN / antenna / allowance.")); break;
    case HTTP_CONFIG: Serial.println(F("[HTTP CONFIG] Modem rejected settings.")); break;
    case HTTP_CONNECT: Serial.println(F("[HTTP CONNECT] Check network and server.")); break;
    case SEND: Serial.println(F("[SEND] Result unknown; no immediate retry.")); break;
    case CLOSE: Serial.println(F("[CLOSE] Cleanup failed. Reset UNO.")); break;
  }
  if (lost) Serial.println(F("[MODEM] Stream state uncertain. Reset UNO."));
}
