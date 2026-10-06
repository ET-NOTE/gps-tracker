#include <cassert>
#include <deque>
#include <string>
#include "../main/lte.cpp"

static uint32_t clockMs=10000, responseAt=0;
static std::deque<char> rx;
static std::string scenario, scheduled;
static int shutdownCommands=0, pulses=0, cycles=0, gpsResets=0, observed=0;
static bool modemOn=true;
SerialStub Serial;
uint32_t millis() { return clockMs; }
void delay(uint32_t ms) { clockMs+=ms; }
void SerialStub::flush() {}
int HardwareSerial::available() {
  if(!scheduled.empty() && int32_t(clockMs-responseAt)>=0) {
    // Byte-wise replies exercise URC recognition across drain() calls.
    rx.push_back(scheduled.front()); scheduled.erase(0,1); responseAt=clockMs+10;
  }
  return int(rx.size());
}
int HardwareSerial::read() { auto c=rx.front(); rx.pop_front(); return c; }
void HardwareSerial::print(const char* cmd) {
  if(strcmp(cmd,"AT+CPOWD=1\r\n")==0) {
    ++shutdownCommands; modemOn=false;
    if(scenario=="confirmed" || scenario=="resume") scheduled="\r\nNORMAL POWER DOWN\r\n";
    if(scenario=="ok_only") scheduled="\r\nOK\r\n";
    if(scenario=="error") scheduled="\r\nERROR\r\n";
    responseAt=clockMs+200;
  } else if(strcmp(cmd,"AT\r\n")==0 && modemOn) {
    rx.push_back('O'); rx.push_back('K');
  }
}
namespace bc { void set(const char*) {} }
namespace hw_power {
void pulsePwrKey() { ++pulses; modemOn=true; }
void railCycle() { ++cycles; modemOn=false; delay(12000); }
}
namespace gps { void reconfigure() { ++gpsResets; } }
static void observe() { ++observed; }
int main(int argc,char** argv) {
  assert(argc==2); scenario=argv[1];
  lte::serialStarted_=scenario!="not_started";
  lte::ready_=true; lte::csq_=20; lte::reg_=5;
  lte::httpConnected_=true; lte::httpConfigured_=true;
  lte::brPhase_=1;
  lte::lastResp="NORMAL POWER DOWN"; // stale URC must not count as confirmation
  for(char c:std::string("NORMAL POWER DOWN")) rx.push_back(c);
  lte::setSleepObserver(observe);
  const uint32_t start=clockMs;
  auto result=lte::shutdownForSleep();
#if KC_TEST_BUILD
  assert(result==lte::ShutdownResult::NotStarted && shutdownCommands==0 && pulses==0);
  assert(lte::ready() && lte::httpConnected() && observed==0 && clockMs==start);
#else
  if(scenario=="not_started") {
    assert(result==lte::ShutdownResult::NotStarted && shutdownCommands==0 && observed==0);
  } else {
    bool confirmed=scenario=="confirmed" || scenario=="resume";
    assert(result==(confirmed ? lte::ShutdownResult::Confirmed : lte::ShutdownResult::Unconfirmed));
    assert(!lte::ready() && !lte::httpConnected() && !lte::bringInProgress());
    assert(lte::csq()==-1 && lte::reg()==-1);
    assert(shutdownCommands==1 && pulses==0 && observed>0);
    if(!confirmed) assert(clockMs-start==LTE_SHUTDOWN_TIMEOUT_MS);
    else assert(clockMs-start<LTE_SHUTDOWN_TIMEOUT_MS);
    if(scenario=="resume" || scenario=="timeout_resume") {
      lte::setSleepObserver(nullptr);
      lte::resumeAfterSleepAbort(false,result);
      assert(!lte::ready() && pulses==1);
      assert(cycles==(confirmed ? 0 : 1) && gpsResets==(confirmed ? 0 : 1));
    }
  }
#endif
  puts("PASS");
}
