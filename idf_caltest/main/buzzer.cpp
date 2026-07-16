#include "buzzer.h"
#include "config.h"
#include "driver/gpio.h"

namespace buzzer {

static uint8_t  remaining = 0;
static uint16_t pulseMs   = 0;
static uint16_t gapMs     = 0;
static bool     isOn      = false;
static uint32_t nextEdge  = 0;

void init() {
  gpio_hold_dis((gpio_num_t)PIN_BUZZER);   // deep-sleep LOW 래치 해제 (wake 후)
#if BUZZER_ENABLED
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);           // 능동 부저: 부팅 즉시 LOW (floating buzz 방지)
#else
  // OFF 시 GPIO1 high-Z (INPUT_PULLDOWN) 로 격리 — LTE bringup 간섭 차단.
  pinMode(PIN_BUZZER, INPUT_PULLDOWN);
#endif
}

void beep(uint8_t count, uint16_t p, uint16_t g) {
#if !BUZZER_ENABLED
  (void)count; (void)p; (void)g;
  return;
#else
  remaining = count;
  pulseMs   = p;
  gapMs     = g;
  if (count == 0) return;
  digitalWrite(PIN_BUZZER, HIGH);
  isOn = true;
  nextEdge = millis() + p;
#endif
}

void update() {
#if BUZZER_ENABLED
  if (remaining == 0 && !isOn) return;
  uint32_t now = millis();
  if ((int32_t)(now - nextEdge) < 0) return;
  if (isOn) {
    digitalWrite(PIN_BUZZER, LOW);
    isOn = false;
    if (remaining > 0) remaining--;
    if (remaining > 0) nextEdge = now + gapMs;
  } else if (remaining > 0) {
    digitalWrite(PIN_BUZZER, HIGH);
    isOn = true;
    nextEdge = now + pulseMs;
  }
#endif
}

void flush(uint32_t maxMs) {
#if BUZZER_ENABLED
  uint32_t t0 = millis();
  while ((remaining > 0 || isOn) && (millis() - t0) < maxMs) {
    update();
    delay(5);
  }
  digitalWrite(PIN_BUZZER, LOW);
  isOn = false;
  remaining = 0;
#else
  (void)maxMs;
#endif
}

} // namespace buzzer
