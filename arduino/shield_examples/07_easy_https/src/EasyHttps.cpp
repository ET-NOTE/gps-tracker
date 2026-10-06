#include "EasyHttps.h"
#include "ShieldRootCA.h"
#include <stdio.h>

void EasyHttps::parse() {
  if (checkingCa) {
    if (!strcmp(line, "-----BEGIN CERTIFICATE-----")) caStarted = true;
    if (caStarted && caOffset < SHIELD_ROOT_CA_SIZE) {
      for (uint8_t i = 0; line[i]; ++i) {
        if (caOffset >= SHIELD_ROOT_CA_SIZE || line[i] != (char)pgm_read_byte(SHIELD_ROOT_CA + caOffset))
          caMismatch = true;
        if (caOffset < SHIELD_ROOT_CA_SIZE) ++caOffset;
      }
      if (caOffset >= SHIELD_ROOT_CA_SIZE || pgm_read_byte(SHIELD_ROOT_CA + caOffset) != '\n')
        caMismatch = true;
      if (caOffset < SHIELD_ROOT_CA_SIZE) ++caOffset;
    }
  }
  if (!strcmp(line, "OK")) reply = 1;
  else if (!strcmp(line, "ERROR") || !strncmp(line, "+CME ERROR:", 11) || !strncmp(line, "+CMS ERROR:", 11)) reply = 2;
  if (!strcmp(line, "RDY")) { restarted = true; clock = 0; sim = pdp = false; }
  if (!strcmp(line, "DOWNLOAD")) download = true;
  int a, b;
  if (sscanf(line, "+CSQ: %d,%d", &a, &b) == 2) signal = a;
  if (sscanf(line, "+CEREG: %d,%d", &a, &b) == 2) registration = b;
  if (!strncmp(line, "+CPIN:", 6)) { const char *p = line + 6; while (*p == ' ') ++p; sim = !strcmp(p, "READY"); }
  if (sscanf(line, "+CNACT: %d,%d", &a, &b) == 2 && a == 0) pdp = b == 1;
  if (sscanf(line, "+CNTP: %d", &a) == 1) ntp = a;
  if (sscanf(line, "+SHSTATE: %d", &a) == 1) state = a;
  if (sscanf(line, "+CFSGFIS: %d", &a) == 1) fileSize = a;
  if (!strncmp(line, "+SHREQ:", 7)) {
    const char *p = strchr(line, ',');
    if (p && sscanf(p + 1, "%d,%d", &a, &b) == 2) { http = a; responseSize = b; }
  }
  if (readingResponse && sscanf(line, "+SHREAD: %d", &a) == 1) {
    if (responseStarted || a != responseSize || a < 1 || a >= responseCapacity) lost = true;
    else { responseStarted = true; responseRemaining = a; }
  }
  if (!strncmp(line, "+CCLK:", 6)) {
    char *p = strchr(line, '"');
    if (p) { char *q = strchr(++p, '"'); if (q) { *q = 0; clock = shield_example::clockEpoch(p); } }
  }
}

void EasyHttps::receive() {
  while (uart.available()) {
    char c = uart.read();
    ++received;
    if (responseRemaining) {
      responseBuffer[responseRead++] = c;
      if (!--responseRemaining) responseBuffer[responseRead] = 0;
      continue;
    }
    if (wantPrompt && c == '>') { prompt = true; wantPrompt = false; }
    if (c == '\r') continue;
    if (c == '\n') {
      if (length && !overflow) { line[length] = 0; parse(); }
      if (overflow && checkingCa) caMismatch = true;
      length = 0;
      overflow = false;
    } else if (!overflow) {
      if (length < sizeof(line) - 1) line[length++] = c;
      else overflow = true;
    }
  }
}

void EasyHttps::drain(uint32_t ms) {
  uint32_t start = millis();
  while (millis() - start < ms) receive();
}

void EasyHttps::resetReply() { reply = 0; length = 0; overflow = false; }

bool EasyHttps::wait(uint32_t timeout) {
  uint32_t start = millis();
  while (!reply && !restarted && millis() - start < timeout) receive();
  if (!reply) lost = true; // Never send another command into a possibly unfinished data prompt.
  return reply == 1 && !needsReset();
}

bool EasyHttps::command(const __FlashStringHelper *text, uint32_t timeout) {
  if (needsReset()) return false;
  drain(60);
  if (needsReset()) return false;
  resetReply();
  uart.print(text); uart.print('\r');
  return wait(timeout);
}

bool EasyHttps::commandRam(const char *text, uint32_t timeout) {
  if (needsReset()) return false;
  drain(60);
  if (needsReset()) return false;
  resetReply();
  uart.print(text); uart.print('\r');
  return wait(timeout);
}

bool EasyHttps::begin() {
  stage = MODEM;
  digitalWrite(7, LOW); pinMode(7, OUTPUT);
  digitalWrite(6, HIGH); pinMode(6, OUTPUT);
  const uint32_t rates[] = {9600, 115200, 19200, 38400, 57600};
  bool ready = false;
  for (uint8_t i = 0; i < 5 && !ready; ++i) {
    uart.end(); uart.begin(rates[i]); drain(800);
    lost = restarted = false; // Only discovery retries are allowed before normal operation.
    ready = command(F("AT"), 1500);
    if (ready && rates[i] != 9600) {
      if (!command(F("AT+IPR=9600"))) return false;
      uart.end(); uart.begin(9600);
      ready = command(F("AT"));
    }
  }
  if (!ready && !received) {
    uart.end(); uart.begin(9600);
    digitalWrite(7, HIGH); drain(1500); digitalWrite(7, LOW); drain(12000);
    lost = restarted = false;
    ready = command(F("AT"));
  }
  if (!ready) return false;
  return command(F("ATE0")) && command(F("AT+IFC=0,0")) && command(F("AT+CMEE=2")) &&
         command(F("AT+CSCLK=0")) && command(F("AT+CGNSPWR=0"));
}

bool EasyHttps::closeHttp() {
  state = -1;
  if (!command(F("AT+SHSTATE?"))) return false;
  if (state == 0) return true;
  if (!command(F("AT+SHDISC"), 10000)) return false;
  state = -1;
  return command(F("AT+SHSTATE?")) && state == 0;
}

bool EasyHttps::matchesCertificate() {
  fileSize = -1;
  if (!command(F("AT+CFSGFIS=3,\"sh07-x1-22b557a2.pem\"")) || fileSize != SHIELD_ROOT_CA_SIZE) return false;
  // Compare PEM content as it streams in; do not allocate the certificate in UNO SRAM.
  caStarted = caMismatch = false; caOffset = 0; checkingCa = true;
  char cmd[80];
  snprintf_P(cmd, sizeof(cmd), PSTR("AT+CFSRFILE=3,\"sh07-x1-22b557a2.pem\",0,%u,0"), SHIELD_ROOT_CA_SIZE);
  bool ok = commandRam(cmd, 10000);
  checkingCa = false;
  return ok && caStarted && !caMismatch && caOffset == SHIELD_ROOT_CA_SIZE;
}

bool EasyHttps::writeCertificate() {
  char cmd[80];
  // Delete only this new example's own PEM, then confirm absence (avoids old trailing bytes).
  command(F("AT+CFSDFILE=3,\"sh07-x1-22b557a2.pem\""));
  if (needsReset()) return false;
  if (command(F("AT+CFSGFIS=3,\"sh07-x1-22b557a2.pem\"")) || needsReset()) return false;
  snprintf_P(cmd, sizeof(cmd), PSTR("AT+CFSWFILE=3,\"sh07-x1-22b557a2.pem\",0,%u,10000"), SHIELD_ROOT_CA_SIZE);
  drain(60); resetReply(); download = false;
  uart.print(cmd); uart.print('\r');
  uint32_t start = millis();
  while (!download && reply != 2 && !restarted && millis() - start < 3000) receive();
  if (!download || needsReset()) { lost = true; return false; }
  resetReply();
  // 1939 bytes at 9600 baud + 2 ms pacing fits the modem's 10-second input deadline.
  for (uint16_t i = 0; i < SHIELD_ROOT_CA_SIZE; ++i) {
    uart.write(pgm_read_byte(SHIELD_ROOT_CA + i));
    delay(2);
  }
  return wait(10000) && matchesCertificate();
}

bool EasyHttps::prepareCertificate() {
  stage = CERTIFICATE;
  certificateReady = false;
  if (!closeHttp() || !command(F("AT+CFSINIT"))) return false;
  bool ok = matchesCertificate();
  if (!ok && !needsReset()) {
    Serial.println(F("[CA] Installing bundled public CA. Keep power connected."));
    ok = writeCertificate();
  } else if (ok) {
    Serial.println(F("[CA] Existing public CA matches this example."));
  }
  // Convert at boot to recover from an interrupted previous conversion; never during each POST.
  if (ok) ok = command(F("AT+CSSLCFG=\"CONVERT\",2,\"sh07-x1-22b557a2.pem\""), 20000);
  bool closed = command(F("AT+CFSTERM"));
  certificateReady = ok && closed;
  return certificateReady;
}

bool EasyHttps::syncClock() {
  stage = CLOCK; ntp = -1; clock = 0;
  if (!command(F("AT+CNTPCID=0")) || !command(F("AT+CNTP=\"time.cloudflare.com\",0")) ||
      !command(F("AT+CNTP"), 5000)) return false;
  uint32_t start = millis();
  while (ntp < 0 && !restarted && millis() - start < 45000UL) receive();
  return ntp == 1 && command(F("AT+CCLK?")) && clock != 0;
}

bool EasyHttps::connect(const char *apn) {
  stage = NETWORK;
  if (!shield_example::safeToken(apn, 63) || !certificateReady || needsReset() || !closeHttp()) return false;
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
  signal = 99;
  if (!command(F("AT+CSQ"))) return false;
  pdp = false;
  if (!command(F("AT+CNACT?"))) return false;
  if (!pdp) {
    char cmd[100];
    snprintf_P(cmd, sizeof(cmd), PSTR("AT+CNCFG=0,1,\"%s\""), apn);
    if (!commandRam(cmd) || !command(F("AT+CNACT=0,1"), 20000)) return false;
    drain(1000); pdp = false;
    if (!command(F("AT+CNACT?")) || !pdp) return false;
  }
  return syncClock();
}

int EasyHttps::post(const char *key, const char *body) {
  if (!shield_example::hexKey(key)) return -1;
  return exchange(key, body, false);
}

int EasyHttps::bootstrap(char *response, uint16_t capacity) {
  if (!response || capacity < 127) return -1;
  responseBuffer = response; responseCapacity = capacity;
  responseRead = responseRemaining = 0; responseStarted = false;
  response[0] = 0;
  int status = exchange(nullptr, "{}", true);
  readingResponse = false; responseRemaining = 0;
  responseBuffer = nullptr; responseCapacity = 0;
  if (status != 200) memset(response, 0, capacity);
  return status;
}

int EasyHttps::exchange(const char *key, const char *body, bool enrollment) {
  stage = TLS_CONFIG;
  if (!certificateReady || strlen(body) > 256 || needsReset()) return -1;
  stage = CLOCK; clock = 0;
  if (!command(F("AT+CCLK?")) || !clock) return -1;
  stage = TLS_CONFIG;
  int result = -1;
  do {
    if (!command(F("AT+CSSLCFG=\"SSLVERSION\",1,3")) ||
        !command(F("AT+CSSLCFG=\"IGNORERTCTIME\",1,0")) ||
        !command(F("AT+CSSLCFG=\"SNI\",1,\"shield.serial.kr\"")) ||
        !command(F("AT+SHSSL=1,\"sh07-x1-22b557a2.pem\"")) ||
        !command(F("AT+SHCONF=\"URL\",\"https://shield.serial.kr\"")) ||
        !command(F("AT+SHCONF=\"BODYLEN\",256")) ||
        !command(F("AT+SHCONF=\"HEADERLEN\",350"))) break;
    stage = TLS_CONNECT;
    if (!command(F("AT+SHCONN"), 60000)) break;
    state = -1;
    if (!command(F("AT+SHSTATE?")) || state != 1) break;
    stage = SEND;
    // Key and body are sent only after the modem reports a connected TLS session.
    if (!command(F("AT+SHCHEAD")) || !command(F("AT+SHAHEAD=\"Content-Type\",\"application/json\""))) break;
    char cmd[100];
    if (key) {
      snprintf_P(cmd, sizeof(cmd), PSTR("AT+SHAHEAD=\"X-Device-Key\",\"%s\""), key);
      bool headerOk = commandRam(cmd);
      memset(cmd, 0, sizeof(cmd));
      if (!headerOk) break;
    }
    drain(60); resetReply(); prompt = false; wantPrompt = true; http = responseSize = -1;
    uart.print(F("AT+SHBOD=")); uart.print(strlen(body)); uart.print(F(",10000\r"));
    uint32_t start = millis();
    while (!prompt && reply != 2 && !restarted && millis() - start < 3000) receive();
    wantPrompt = false;
    if (!prompt || needsReset()) { lost = true; break; }
    resetReply(); uart.print(body);
    if (!wait(10000) || !command(enrollment ? F("AT+SHREQ=\"/device/bootstrap\",3") : F("AT+SHREQ=\"/ingest/shield\",3"), 15000)) break;
    start = millis();
    while (http < 0 && !restarted && millis() - start < 45000UL) receive();
    if (http < 0) lost = true;
    if (needsReset()) break;
    if (enrollment && http == 200) {
      if (responseSize != 126 || responseSize >= responseCapacity) break;
      snprintf_P(cmd, sizeof(cmd), PSTR("AT+SHREAD=0,%d"), responseSize);
      readingResponse = true;
      if (!commandRam(cmd, 10000)) break;
      // SIM7080G may return OK before its SHREAD data URC. Wait for both.
      start = millis();
      while ((!responseStarted || responseRemaining) && !needsReset() && millis() - start < 10000UL) receive();
      readingResponse = false;
      if (!responseStarted || responseRemaining) lost = true;
    }
    if (!needsReset()) result = http;
  } while (false);
  Stage failure = stage;
  if (!needsReset() && !closeHttp()) {
    stage = CLOSE; lost = true;
    return result; // An acknowledged POST remains acknowledged; do not duplicate it.
  }
  stage = failure;
  return result;
}

void EasyHttps::printError() {
  if (restarted) { Serial.println(F("[MODEM] Modem restarted. Check power and reset UNO.")); return; }
  switch (stage) {
    case MODEM: Serial.println(F("[MODEM] No reliable AT connection. Check power / shield pins / baud.")); break;
    case SIM: Serial.println(F("[SIM] USIM not ready. Check insertion / PIN / activation.")); break;
    case NETWORK: Serial.println(F("[NET] LTE/PDP failed. Check APN / antenna / data allowance.")); break;
    case CLOCK: Serial.println(F("[TIME] NTP/clock failed. Certificate date checks remain enabled.")); break;
    case CERTIFICATE: Serial.println(F("[CA] Certificate read/write/convert failed. Check power / modem firmware.")); break;
    case TLS_CONFIG: Serial.println(F("[TLS CONFIG] Modem rejected HTTPS security settings.")); break;
    case TLS_CONNECT: Serial.println(F("[TLS CONNECT] HTTPS connection failed. Check network / CA / clock / server.")); break;
    case SEND: Serial.println(F("[SEND] Request result unknown. Check connection; no immediate resend.")); break;
    case CLOSE: Serial.println(F("[CLOSE] Connection cleanup failed. Reset UNO before continuing.")); break;
  }
  if (lost) Serial.println(F("[MODEM] Response timed out or stream state is uncertain. Reset UNO."));
}
