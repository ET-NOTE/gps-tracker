// Exercise the real LTE connection path with a deterministic SIM7080 transcript.
#include <cassert>
#include <deque>
#include <string>
#include <vector>
#include "../main/lte.cpp"

static std::string scenario, file;
static std::vector<std::string> commands;
static std::deque<char> rx;
static uint32_t clockMs;
static bool awaitingPem, active, ntpDone;
static int handshakes, caWrites;
SerialStub Serial;
uint32_t millis() { return clockMs; }
void delay(uint32_t ms) { clockMs += ms; }
namespace bc { void set(const char*) {} }

static void reply(const std::string &s) { rx.insert(rx.end(), s.begin(), s.end()); }
int HardwareSerial::available() { return int(rx.size()); }
int HardwareSerial::read() { int c = rx.front(); rx.pop_front(); return c; }
void HardwareSerial::write(const uint8_t *data, size_t size) {
  assert(awaitingPem);
  file.assign(reinterpret_cast<const char*>(data), size);
  if (scenario == "corrupt_ca") file[50] ^= 1;
  awaitingPem = false;
  ++caWrites;
  reply("\r\nOK\r\n");
}
void HardwareSerial::print(const char *s) {
  std::string cmd(s);
  if (cmd == "\r\n") return;
  commands.push_back(cmd);
  assert(cmd.find("http://") == cmd.npos && cmd.find("AT+SHSSL=0") == cmd.npos);
  assert(cmd.find("AT+SHSSL=1,\"\"") == cmd.npos);
  std::string answer = "\r\nOK\r\n";
  if (cmd == "AT+CNACT?") answer = "\r\n+CNACT: 0,1,\"10.0.0.1\"\r\nOK\r\n";
  if (cmd == "AT+SHSTATE?") answer = active ? "\r\n+SHSTATE: 1\r\nOK\r\n" : "\r\n+SHSTATE: 0\r\nOK\r\n";
  if (cmd == "AT+SHDISC") active = false;
  if (cmd.find("AT+CFSGFIS") == 0)
    answer = file.empty() ? "\r\nERROR\r\n" : "\r\n+CFSGFIS: " + std::to_string(file.size()) + "\r\nOK\r\n";
  if (cmd.find("AT+CFSRFILE") == 0) answer = "\r\n" + file + "\r\nOK\r\n";
  if (cmd.find("AT+CFSDFILE") == 0) file.clear();
  if (cmd.find("AT+CFSWFILE") == 0) { awaitingPem = true; answer = "\r\nDOWNLOAD\r\n"; }
  if (cmd == "AT+CCLK?") answer = (scenario == "clock_failure" || scenario == "cold_clock") && !ntpDone
      ? "\r\n+CCLK: \"00/01/01,00:00:00+00\"\r\nOK\r\n" : "\r\n+CCLK: \"26/11/04,12:00:00+00\"\r\nOK\r\n";
  if (cmd == "AT+CCLK?" && !ntpDone && scenario == "gps_epoch_clock")
    answer = "\r\n+CCLK: \"80/01/06,00:00:07+00\"\r\nOK\r\n";
  if (cmd == "AT+CCLK?" && scenario == "clock_stuck")
    answer = "\r\n+CCLK: \"80/01/06,00:00:07+00\"\r\nOK\r\n";
  if (cmd == "AT+CCLK?" && !ntpDone && scenario == "invalid_calendar")
    answer = "\r\n+CCLK: \"26/02/30,12:00:00+00\"\r\nOK\r\n";
  if (cmd == "AT+CCLK?" && !ntpDone && scenario.find("ntp_") == 0)
    answer = "\r\n+CCLK: \"80/01/06,00:00:07+00\"\r\nOK\r\n";
  if (cmd == "AT+CNTP") {
    ntpDone = scenario != "clock_failure";
    answer = ntpDone ? "\r\nOK\r\n+CNTP: 1\r\n" : "\r\nERROR\r\n";
    if (scenario == "ntp_time_reply") answer = "\r\nOK\r\n+CNTP: 1,\"2026/11/05,02:32:04\"\r\n";
    if (scenario == "ntp_error_code") answer = "\r\nOK\r\n+CNTP: 61\r\n";
    if (scenario == "ntp_code_prefix") answer = "\r\nOK\r\n+CNTP: 10\r\n";
    if (scenario == "ntp_invalid_code") answer = "\r\nOK\r\n+CNTP: 1bad\r\n";
    if (scenario == "ntp_incomplete") answer = "\r\nOK\r\n+CNTP: 1";
  }
  if (cmd == "AT+SHSSL=1,\"" GPS_CA_FILE "\"" && scenario == "binding_failure") answer = "\r\nERROR\r\n";
  if (cmd == "AT+SHCONN") {
    ++handshakes;
    active = scenario != "handshake_failure";
    if (!active) answer = "\r\nERROR\r\n";
  }
  reply(answer);
}

int main(int argc, char **argv) {
  assert(argc == 2); scenario = argv[1];
  bool success=lte::modemClockSet() || lte::syncModemClock();
  bool expected = scenario=="valid_clock" || scenario=="cold_clock" || scenario=="gps_epoch_clock" ||
                  scenario=="invalid_calendar" || scenario=="ntp_time_reply";
  assert(success==expected);
  assert(handshakes==0 && caWrites==0);
}
