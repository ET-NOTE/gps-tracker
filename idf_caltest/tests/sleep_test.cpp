// Real sleep manager and telemetry; only hardware/transport boundaries are faked.
#include <cassert>
#include <cstdlib>
#include <string>
#include <vector>
#include <algorithm>
#include "../main/sleep_mgr.cpp"

static std::string scenario;
static uint32_t clockMs = 10000;
static bool pinLow = false, lisOk = true, active = false, railOff = false;
static bool held = false, slept = false, armed = false, invalidRaw = false;
static int posts = 0, shutdowns = 0, resumes = 0, drops = 0;
static void (*observer)() = nullptr;
static std::vector<std::string> trace;
SerialStub Serial;
uint32_t millis() { return clockMs; }
void delay(uint32_t ms) { clockMs += ms; }
int digitalRead(int) { return pinLow ? LOW : HIGH; }
void digitalWrite(int, int) {}
void pinMode(int, int) {}
int analogReadMilliVolts(int) { return 1900; }
void SerialStub::flush() { if(scenario=="final_interrupt") pinLow=true; }
esp_err_t gpio_hold_en(gpio_num_t) { return scenario=="hold_error" ? -1 : ESP_OK; }
esp_err_t gpio_hold_dis(gpio_num_t) { return ESP_OK; }
void gpio_deep_sleep_hold_en() { held=true; }
void gpio_deep_sleep_hold_dis() { held=false; }
esp_err_t esp_deep_sleep_enable_gpio_wakeup(uint64_t pin, int level) {
  assert(pin==(1ULL<<PIN_LIS_INT) && level==ESP_GPIO_WAKEUP_GPIO_LOW);
  armed=true; trace.push_back("arm");
  return scenario=="wake_error" ? -1 : ESP_OK;
}
esp_err_t esp_sleep_enable_timer_wakeup(uint64_t us) {
  assert(us==600000000ULL); return scenario=="timer_error" ? -1 : ESP_OK;
}
esp_err_t esp_sleep_disable_wakeup_source(esp_sleep_wakeup_cause_t) { armed=false; return ESP_OK; }
void esp_deep_sleep_start() {
  assert(armed && held && railOff && !pinLow);
  trace.push_back("sleep"); slept=true;
}
esp_sleep_wakeup_cause_t esp_sleep_get_wakeup_cause() { return ESP_SLEEP_WAKEUP_TIMER; }
uint64_t esp_sleep_get_gpio_wakeup_status() { return 1ULL<<PIN_LIS_INT; }
esp_reset_reason_t esp_reset_reason() { return ESP_RST_DEEPSLEEP; }
namespace bc { void set(const char*) {} const char* last() { return "sleep_prepare"; } }
namespace buzzer { void beep(uint8_t,uint16_t,uint16_t) {} void flush(uint32_t) {} }
namespace motion {
void tick() { if(scenario!="stuck_low") pinLow=false; }
void clearLatch() { if(scenario!="stuck_low") pinLow=false; }
bool ok() { return lisOk; } bool active() { return ::active; }
uint32_t badStreak() { return scenario=="i2c_error" ? 1 : 0; }
int rawMagMg() { return invalidRaw ? -1 : 1000; }
uint32_t events() { return 0; } uint32_t lastMs() { return 0; }
uint32_t activityMg() { return ::active ? 100 : 0; }
uint32_t stillMs() { return 900000; } uint32_t reinits() { return 0; }
}
namespace hw_power {
void railOff() { ::railOff=true; trace.push_back("rail_off");
  if(scenario=="after_rail") pinLow=true;
  if(scenario=="sensor_after_rail") invalidRaw=true;
}
void railOn() { ::railOff=false; trace.push_back("rail_on"); }
bool holdOffForSleep() { return true; } void releaseSleepHold() { held=false; }
}
namespace lte {
void setSleepObserver(void (*f)()) { observer=f; }
bool ready() { return scenario!="early_bounce"; }
bool httpPost(const char*, int* status) {
  ++posts; trace.push_back("post");
  if((scenario=="during_flush" && posts==1) || (scenario=="during_event" && posts==2)) {
    pinLow=true; if(observer) observer(); // tick clears it; retained guard must still abort
  }
  *status=scenario=="post_fail" ? 500 : 200;
  return scenario!="post_fail";
}
ShutdownResult shutdownForSleep() {
  ++shutdowns; trace.push_back("shutdown");
  if(scenario=="during_shutdown" || scenario=="timeout_motion") {
    pinLow=true; if(observer) observer();
  }
  if(scenario=="sensor_shutdown") lisOk=false;
  if(scenario=="timeout" || scenario=="timeout_motion") return ShutdownResult::Unconfirmed;
  return scenario=="early_bounce" ? ShutdownResult::NotStarted : ShutdownResult::Confirmed;
}
void resumeAfterSleepAbort(bool, ShutdownResult) { ++resumes; assert(observer==nullptr); }
int csq() { return 20; } int reg() { return 5; } int modemVbatMv() { return 3800; }
uint32_t firstAtOkMs() { return 100; } uint16_t bringUpCount() { return 1; }
const char* iccid() { return "89880000000000000000"; }
const char* imei() { return "123456789012345"; }
const char* imsi() { return "123456789012345"; }
const char* band() { return "M1-B5"; }
}
namespace gps {
uint8_t batchCount() { return scenario=="payload" ? 120 : 3; }
void batchDrop(uint8_t n) { drops+=n; }
bool batchGet(uint8_t i,float& lat,float& lng,int& sat,uint32_t& at) {
  lat=37.5f; lng=127.1f; sat=12; at=millis()-1000*(i+1); return true;
}
bool getFix(Fix& f) { f={37.5,127.1,12,0.8f,34.0f,true}; return true; }
uint32_t firstFixMs() { return 100; } uint32_t lastFixMs() { return millis(); }
int satellites() { return 12; } float hdop() { return 0.8f; }
const char* antennaStatus() { return "OK_EXT"; }
int recentDrift(float& drift,uint32_t) { drift=0; return 10; }
}
namespace recovery {
uint32_t lastSuccessMs() { return 100; }
uint32_t postOks() { return 1; } uint32_t postFails() { return 0; }
}

int main(int argc,char** argv) {
  assert(argc==2); scenario=argv[1];
  if(scenario=="payload") {
    char body[8192], sleep[1024];
    const auto count=telemetry::buildPayload(body,sizeof(body),0,true);
    assert(strlen(body)<4096 && count>0 && count<120);
    telemetry::buildSleepPayload(sleep,sizeof(sleep),0,"stationary_lis_only");
    puts(body); puts(sleep); return 0;
  }
  lisOk=scenario!="no_lis";
  active=scenario=="active";
  pinLow=scenario=="stuck_low";
  invalidRaw=scenario=="raw_error";
  if(scenario=="wrap") clockMs=0xffffff00U;
#if KC_TEST_BUILD
  sleep_mgr::begin(0);
  assert(!sleep_mgr::timerWakeMode());
  // Even a caller forcing a timer mode may never reach teardown.
  sleep_mgr::timerWake_=true;
  sleep_mgr::onPostSuccess();
  sleep_mgr::timerWake_=true;
  clockMs=200000;
  sleep_mgr::timerWakeTick();
#endif
  const bool result=sleep_mgr::enterDeepSleep("test");
#if KC_TEST_BUILD
  assert(!result && !slept && posts==0 && shutdowns==0 && !railOff && trace.empty());
#else
  const bool success=scenario=="success" || scenario=="wrap" || scenario=="timeout" ||
                     scenario=="post_fail" || scenario=="early_bounce";
  assert(result==success && slept==success);
  if(success) {
    auto at=[](const char* s) { return std::find(trace.begin(),trace.end(),s)-trace.begin(); };
    assert(at("arm")<at("shutdown") && at("shutdown")<at("rail_off") && at("rail_off")<at("sleep"));
    assert(resumes==0 && sleep_mgr::sleepAborts()==0);
    if(scenario=="post_fail") assert(drops==0);
  } else {
    assert(!armed && !held && !railOff && observer==nullptr);
    assert(sleep_mgr::sleepAborts()==1);
    assert(resumes==shutdowns);
    const bool intentSent=posts>=2;
    assert(sleep_mgr::resumeReportPending()==intentSent);
    if(intentSent) {
      char resume[8192]; telemetry::buildPayload(resume,sizeof(resume),0,false);
      assert(strstr(resume,"\"event\":\"wake\"") && strstr(resume,"\"wake\":\"sleep_abort\""));
      assert(sleep_mgr::resumeReportPending()); // failed POST cannot acknowledge it
      sleep_mgr::onPostSuccess();
      assert(!sleep_mgr::resumeReportPending());
    }
    if(scenario=="during_flush") assert(posts==1 && shutdowns==0);
    if(scenario=="during_event") assert(posts==2 && shutdowns==0);
    // A cancelled attempt must not leave inSleep_ latched forever.
    scenario="success"; lisOk=true; active=false; pinLow=false; invalidRaw=false;
    assert(sleep_mgr::enterDeepSleep("retry"));
  }
#endif
  puts("PASS");
}
