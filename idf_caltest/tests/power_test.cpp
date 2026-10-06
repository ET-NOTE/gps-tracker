#include <cassert>
#include <string>
#include "../main/hw_power.cpp"
static bool output[22]={}, held[22]={};
static int level[22]={}, holdFailure=-1;
static uint32_t elapsed=0;
void delay(uint32_t ms) { elapsed+=ms; }
void pinMode(int pin,int mode) { assert(mode==OUTPUT); output[pin]=true; }
void digitalWrite(int pin,int value) { assert(output[pin]); level[pin]=value; }
esp_err_t gpio_set_level(gpio_num_t pin,uint32_t value) { level[pin]=value; return ESP_OK; }
esp_err_t gpio_hold_en(gpio_num_t pin) {
  if(pin==holdFailure) return -1;
  assert(output[pin]); held[pin]=true; return ESP_OK;
}
esp_err_t gpio_hold_dis(gpio_num_t pin) {
  assert(output[pin]);
  if(pin==PIN_PWR_EN) {
#if !KC_TEST_BUILD
    // On boot, release only after the held OFF level was restored in the output latch.
    assert(level[pin]==HIGH);
#endif
  } else assert(level[pin]==LOW);
  held[pin]=false; return ESP_OK;
}
int main(int argc,char** argv) {
  assert(argc==2); std::string scenario=argv[1];
  held[PIN_PWR_EN]=held[PIN_PWRKEY]=held[PIN_DTR]=true;
  hw_power::init();
  assert(!held[PIN_PWR_EN] && !held[PIN_PWRKEY] && !held[PIN_DTR]);
  assert(level[PIN_DTR]==LOW && level[PIN_PWRKEY]==LOW);
  hw_power::railOn(); assert(level[PIN_PWR_EN]==LOW);
  uint32_t start=elapsed; hw_power::pulsePwrKey();
  assert(elapsed-start==1600 && level[PIN_PWRKEY]==LOW);
  hw_power::railOff(); assert(level[PIN_PWR_EN]==HIGH);
  if(scenario=="fail_rail") holdFailure=PIN_PWR_EN;
  if(scenario=="fail_key") holdFailure=PIN_PWRKEY;
  if(scenario=="fail_dtr") holdFailure=PIN_DTR;
  bool result=hw_power::holdOffForSleep();
  assert(result==(holdFailure<0));
  assert(held[PIN_PWR_EN]==result && held[PIN_PWRKEY]==result && held[PIN_DTR]==result);
  hw_power::releaseSleepHold();
  hw_power::railOn(); assert(level[PIN_PWR_EN]==LOW);
  puts("PASS");
}
