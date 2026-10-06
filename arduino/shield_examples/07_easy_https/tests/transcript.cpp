#include "EasyHttps.h"
#include "ShieldSetup.h"
#include "ShieldRootCA.h"
#include <cassert>
#include <iostream>
#include <vector>

uint32_t fakeMillis = 0;
Console Serial;
FakeEEPROM EEPROM;
Wire wire;

struct Modem {
  std::string pem;
  std::vector<std::string> commands;
  bool tlsFails = false, dateFails = false, noDownload = false, convertFails = false;
  bool corruptWrite = false, noBodyPrompt = false, noHttpResult = false, noNtp = false;
  bool noState = false, rebootTls = false, simReady = true;
  std::string responseBody;
  bool readTruncated = false, readWrongLength = false, readNoHeader = false;
  int status = 200, connected = 0, writes = 0, conversions = 0;
  Modem() {
    wire = Wire{}; Serial.text.clear(); Serial.input.clear(); fakeMillis = 0;
    wire.command = [this](const std::string &cmd) {
      commands.push_back(cmd);
      auto ok = [] { wire.answer("\r\nOK\r\n"); };
      auto error = [] { wire.answer("\r\nERROR\r\n"); };
      if (cmd == "AT+SHSTATE?") wire.answer("\r\n+SHSTATE: " + std::to_string(noState ? 0 : connected) + "\r\nOK\r\n");
      else if (cmd == "AT+SHDISC") { connected = 0; ok(); }
      else if (cmd.find("AT+CFSGFIS=") == 0) {
        if (pem.empty()) error();
        else wire.answer("\r\n+CFSGFIS: " + std::to_string(pem.size()) + "\r\nOK\r\n");
      } else if (cmd.find("AT+CFSRFILE=") == 0) {
        wire.answer("\r\n+CFSRFILE: " + std::to_string(pem.size()) + "\r\n" + pem + "\r\nOK\r\n");
      } else if (cmd.find("AT+CFSDFILE=") == 0) { pem.clear(); ok(); }
      else if (cmd.find("AT+CFSWFILE=") == 0) {
        if (noDownload) return;
        ++writes; wire.remaining = SHIELD_ROOT_CA_SIZE;
        wire.dataDone = [this](const std::string &data) {
          pem = data; if (corruptWrite) pem[100] = '?';
          wire.answer("\r\nOK\r\n");
        };
        wire.answer("\r\nDOWNLOAD\r\n");
      } else if (cmd.find("AT+CSSLCFG=\"CONVERT\"") == 0) {
        ++conversions;
        if (convertFails) error(); else ok();
      } else if (cmd == "AT+CPIN?") wire.answer(simReady ? "\r\n+CPIN: READY\r\nOK\r\n" : "\r\n+CPIN: SIM PIN\r\nOK\r\n");
      else if (cmd == "AT+CEREG?") wire.answer("\r\n+CEREG: 0,5\r\nOK\r\n");
      else if (cmd == "AT+CSQ") wire.answer("\r\n+CSQ: 20,99\r\nOK\r\n");
      else if (cmd == "AT+CNACT?") wire.answer("\r\n+CNACT: 0,1\r\nOK\r\n");
      else if (cmd == "AT+CNTP") wire.answer(noNtp ? "\r\nOK\r\n" : "\r\nOK\r\n+CNTP: 1\r\n");
      else if (cmd == "AT+CCLK?") wire.answer(dateFails ? "\r\n+CCLK: \"00/01/01,00:00:00+00\"\r\nOK\r\n" : "\r\n+CCLK: \"26/10/06,02:30:00+00\"\r\nOK\r\n");
      else if (cmd == "AT+SHCONN") {
        if (rebootTls) { wire.answer("\r\nRDY\r\n"); return; }
        if (tlsFails) error(); else { connected = 1; ok(); }
      } else if (cmd.find("AT+SHBOD=") == 0) {
        if (noBodyPrompt) return;
        wire.remaining = std::stoul(cmd.substr(9));
        wire.dataDone = [](const std::string &) { wire.answer("\r\nOK\r\n"); };
        wire.answer("\r\n> ");
      } else if (cmd.find("AT+SHREQ=") == 0) {
        ok();
        if (!noHttpResult) wire.answer("\r\n+SHREQ: \"POST\"," + std::to_string(status) + "," + std::to_string(responseBody.size()) + "\r\n");
      } else if (cmd.find("AT+SHREAD=") == 0) {
        ok(); // Documented response order: OK, then SHREAD URC and raw bytes.
        if (!readNoHeader) wire.answer("\r\n+SHREAD: " + std::to_string(responseBody.size() + (readWrongLength ? 1 : 0)) + "\r\n" + (readTruncated ? responseBody.substr(0, 30) : responseBody));
      } else ok();
    };
  }
  bool saw(const std::string &prefix) {
    for (const auto &c : commands) if (c.find(prefix) == 0) return true;
    return false;
  }
};

const char *key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const char *body = "{\"test\":true}";
void ready(EasyHttps &client) { assert(client.begin()); assert(client.prepareCertificate()); }

int main() {
  {
    Modem m; EasyHttps c; ready(c);
    assert(m.pem == SHIELD_ROOT_CA && m.writes == 1);
    assert(c.connect("iot.1nce.net") && c.post(key, body) == 200);
    assert(m.saw("AT+CSSLCFG=\"IGNORERTCTIME\",1,0"));
    assert(m.saw("AT+SHCONF=\"URL\",\"https://shield.serial.kr\""));
    assert(!m.saw("AT+SHSSL=0") && !m.saw("AT+SHSSL=1,\"\""));
    assert(Serial.text.find(key) == std::string::npos);
    EasyHttps afterReset; ready(afterReset);
    assert(m.writes == 1 && m.conversions == 2); // Reuse PEM, confirm conversion at each boot.
  }
  {
    Modem m; m.pem = SHIELD_ROOT_CA; m.pem[100] = '?'; EasyHttps c; ready(c);
    assert(m.writes == 1 && m.pem == SHIELD_ROOT_CA); // Same size is not sufficient.
  }
  for (int fault = 0; fault < 3; ++fault) {
    Modem m; m.noDownload = fault == 0; m.convertFails = fault == 1; m.corruptWrite = fault == 2;
    EasyHttps c; assert(c.begin()); assert(!c.prepareCertificate());
    assert(c.post(key, body) == -1 && !m.saw("AT+SHAHEAD=\"X-Device-Key\""));
  }
  for (int fault = 0; fault < 3; ++fault) {
    Modem m; EasyHttps c; ready(c);
    m.dateFails = fault == 0; m.noNtp = fault == 1; m.simReady = fault != 2;
    assert(!c.connect("iot.1nce.net"));
    c.printError();
    assert(Serial.text.find(fault == 2 ? "[SIM]" : "[TIME]") != std::string::npos);
    assert(!m.saw("AT+SHAHEAD=\"X-Device-Key\""));
  }
  for (int fault = 0; fault < 3; ++fault) {
    Modem m; EasyHttps c; ready(c); assert(c.connect("iot.1nce.net"));
    m.tlsFails = fault == 0; m.noState = fault == 1; m.rebootTls = fault == 2;
    assert(c.post(key, body) == -1);
    assert(!m.saw("AT+SHAHEAD=\"X-Device-Key\""));
    assert(!m.saw("AT+SHBOD="));
  }
  for (int fault = 0; fault < 2; ++fault) {
    Modem m; EasyHttps c; ready(c); assert(c.connect("iot.1nce.net"));
    m.noBodyPrompt = fault == 0; m.noHttpResult = fault == 1;
    assert(c.post(key, body) == -1 && c.needsReset());
    size_t calls = m.commands.size();
    assert(c.post(key, body) == -1 && m.commands.size() == calls);
  }
  for (int status : {401, 409, 429, 500}) {
    Modem m; m.status = status; EasyHttps c; ready(c); assert(c.connect("iot.1nce.net"));
    assert(c.post(key, body) == status && !c.needsReset());
  }
  for (int fault = 0; fault < 5; ++fault) {
    Modem m; EasyHttps c; ready(c); assert(c.connect("iot.1nce.net"));
    m.responseBody = "uno-shield-" + std::string(32, 'a') + "\n" + key + "\n" + std::string(16, 'b') + "\n";
    m.readTruncated = fault == 1; m.readWrongLength = fault == 2; m.readNoHeader = fault == 3;
    if (fault == 4) m.responseBody += "x";
    char output[256]; int result = c.bootstrap(output, sizeof(output));
    assert((result == 200) == (fault == 0));
    if (!fault) assert(std::string(output) == m.responseBody && !c.needsReset());
    else assert(output[0] == 0);
    assert(m.saw("AT+SHREQ=\"/device/bootstrap\",3") && !m.saw("AT+SHAHEAD=\"X-Device-Key\""));
    assert(Serial.text.find(key) == std::string::npos);
  }
  {
    Modem m; EasyHttps c; ready(c); assert(c.connect("iot.1nce.net"));
    assert(c.utcNow() == 1791253800UL);
    m.dateFails = true; assert(c.utcNow() == 0);
    m.dateFails = false;
    std::string maxBody(447, 'x'), tooLarge(448, 'x');
    assert(c.post(key, maxBody.c_str()) == 200);
    size_t calls = m.commands.size();
    assert(c.post(key, tooLarge.c_str()) == -1 && m.commands.size() == calls);
  }
  {
    EEPROM = FakeEEPROM{};
    Modem m;
    m.responseBody = "uno-shield-" + std::string(32, 'a') + "\n" + key + "\n" + std::string(16, 'b') + "\n";
    ShieldSetup first; first.begin();
    char buffer[448]; assert(first.connect(buffer, sizeof(buffer)));
    assert(Serial.text.find("[REGISTER] bbbb-bbbb-bbbb-bbbb") != std::string::npos);
    assert(Serial.text.find(key) == std::string::npos);
    for (char byte : buffer) assert(byte == 0); // Bootstrap response wiped.
    auto saved = EEPROM.bytes;
    m.commands.clear();
    ShieldSetup nextSketch; nextSketch.begin(); // Same class in 04, 06, 07.
    assert(nextSketch.connect(buffer, sizeof(buffer)));
    assert(!m.saw("AT+SHREQ=\"/device/bootstrap\",3"));
    assert(EEPROM.bytes == saved);
    assert(!strcmp(first.device.uid, nextSketch.device.uid));
    Serial.input = "NEWx\n"; nextSketch.pause(); assert(EEPROM.bytes == saved);
    Serial.input = "NEW\r\n"; nextSketch.pause();
    Enrollment erased{}; assert(!erased.load());
    assert(nextSketch.connect(buffer, sizeof(buffer)));
    assert(m.saw("AT+SHREQ=\"/device/bootstrap\",3"));
    m.status = 429; nextSketch.send(body);
    auto start = fakeMillis; nextSketch.pause(); assert(fakeMillis - start >= 900000UL);
  }
  std::cout << "HTTPS: 22 fault/response scenarios + UTC/body bounds + cross-sketch enrollment, wipe, recovery and rate-limit passed.\n";
}
