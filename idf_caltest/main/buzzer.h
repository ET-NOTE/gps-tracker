// =================================================================
// buzzer — non-blocking 액티브 부저 상태머신.
//   13_4_aa 에서 이관 (검증된 로직). BUZZER_ENABLED=0 이면 전부 no-op.
//   update() 를 loop 마다 호출해야 pulse/gap 이 진행됨. flush() 는 sleep 직전
//   마지막 비프를 끝까지 보장 (짧은 blocking).
// =================================================================
#pragma once
#include <Arduino.h>

namespace buzzer {
  void init();
  void beep(uint8_t count, uint16_t pulseMs, uint16_t gapMs);
  void update();
  void flush(uint32_t maxMs = 1500);
}
