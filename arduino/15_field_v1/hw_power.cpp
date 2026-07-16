#include "hw_power.h"
#include "config.h"

namespace hw_power {

void init() {
  pinMode(PIN_PWR_EN, OUTPUT);
  // DTR/PWRKEY 는 idle 로 세팅 (레일 전원과 독립). SIM7080 default: DTR LOW=active.
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, LTE_DTR_IDLE);
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, LTE_PWRKEY_IDLE);
}

void railOn() {
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);      // 공유 레일 ON (GPS + LTE)
  delay(PWR_INRUSH_SETTLE_MS);        // GPS inrush 안정 — LTE PWRKEY 시점과 peak 분리
}

void railOff() {
  digitalWrite(PIN_PWR_EN, HIGH);
}

void railCycle() {
  digitalWrite(PIN_PWR_EN, HIGH);     // OFF
  delay(PWR_CYCLE_OFF_MS);
  digitalWrite(PIN_PWR_EN, LOW);      // ON
  delay(PWR_CYCLE_ON_MS);
}

void pulsePwrKey() {
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, LTE_PWRKEY_IDLE);
  delay(PWRKEY_PRE_MS);
  digitalWrite(PIN_PWRKEY, LTE_PWRKEY_PULSE);
  delay(PWRKEY_PULSE_MS);
  digitalWrite(PIN_PWRKEY, LTE_PWRKEY_IDLE);
}

} // namespace hw_power
