#include "ShieldHttp.h"
#include <cassert>
#include <iostream>
#include <vector>
uint32_t fakeMillis = 0;
Console Serial;
Wire wire;
struct Modem {
  std::vector<std::string> calls;
  std::string body;
  int status = 200, connected = 0;
  bool noPrompt = false, noResult = false, failConnect = false, reboot = false, sim = true;
  Modem() {
    wire = Wire{}; fakeMillis = 0; Serial.text.clear();
    wire.command = [this](const std::string &cmd) {
      calls.push_back(cmd);
      auto ok = [] { wire.answer("\r\nOK\r\n"); };
      if (cmd == "AT+CPIN?") wire.answer(sim ? "\r\n+CPIN: READY\r\nOK\r\n" : "\r\n+CPIN: SIM PIN\r\nOK\r\n");
      else if (cmd == "AT+CEREG?") wire.answer("\r\n+CEREG: 0,5\r\nOK\r\n");
      else if (cmd == "AT+CSQ") wire.answer("\r\n+CSQ: 20,99\r\nOK\r\n");
      else if (cmd == "AT+CNACT?") wire.answer("\r\n+CNACT: 0,1\r\nOK\r\n");
      else if (cmd == "AT+SHSTATE?") wire.answer("\r\n+SHSTATE: " + std::to_string(connected) + "\r\nOK\r\n");
      else if (cmd == "AT+SHDISC") { connected = 0; ok(); }
      else if (cmd == "AT+SHCONN") {
        if (reboot) wire.answer("\r\nRDY\r\n");
        else if (failConnect) wire.answer("\r\nERROR\r\n");
        else { connected = 1; ok(); }
      } else if (cmd.find("AT+SHBOD=") == 0) {
        if (noPrompt) return;
        wire.remaining = std::stoul(cmd.substr(9));
        wire.dataDone = [this](const std::string &data) { body = data; wire.answer("\r\nOK\r\n"); };
        wire.answer("\r\n> ");
      } else if (cmd == "AT+SHREQ=\"/ingest/shield-demo\",3") {
        ok(); if (!noResult) wire.answer("\r\n+SHREQ: \"POST\"," + std::to_string(status) + ",0\r\n");
      } else if (cmd == "AT+SHCHEAD") {
        assert(connected == 1); ok(); // SIMCom AT manual: only after SHCONN.
      } else ok();
    };
  }
};
int main() {
  assert(!shield_http_example::validUid("YOUR_DEMO_UID"));
  assert(!shield_http_example::validUid("uno-shield-test"));
  assert(shield_http_example::validUid("demo-0123456789abcdef0123456789abcdef"));
  assert(!shield_http_example::validApn("foo\"\rAT"));
  for (int status : {200, 401, 429, 308, 500}) {
    Modem m; m.status = status; ShieldHttp c;
    assert(c.begin() && c.connect("iot.1nce.net"));
    assert(c.post("{\"demo\":true}") == status && !c.needsReset());
    assert(m.body == "{\"demo\":true}");
    bool cleared = false;
    for (const auto &cmd : m.calls) {
      assert(cmd.find("CSSLCFG") == std::string::npos && cmd.find("SHSSL") == std::string::npos);
      assert(cmd.find("X-Device-Key") == std::string::npos && cmd.find("CFS") == std::string::npos);
      assert(cmd.find("CNTP") == std::string::npos);
      if (cmd == "AT+SHCHEAD") cleared = true;
      if (cmd.find("AT+SHREQ=") == 0) assert(cleared);
    }
  }
  for (int fault = 0; fault < 4; ++fault) {
    Modem m; ShieldHttp c; assert(c.begin() && c.connect("iot.1nce.net"));
    m.noPrompt = fault == 0; m.noResult = fault == 1; m.failConnect = fault == 2; m.reboot = fault == 3;
    assert(c.post("{}") == -1);
    if (fault != 2) {
      assert(c.needsReset()); auto size = m.calls.size();
      assert(c.post("{}") == -1 && size == m.calls.size());
    }
    if (fault >= 2) assert(m.body.empty());
  }
  { Modem m; m.sim = false; ShieldHttp c; assert(c.begin() && !c.connect("iot.1nce.net")); }
  std::cout << "10 HTTP modem scenarios passed; no certificate/key operations.\n";
}
