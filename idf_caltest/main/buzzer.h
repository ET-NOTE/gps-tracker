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

  // [2026-08-14] motion 의 activity 샘플 오염 가드용 — 부저 진동(같은 PCB)이 LIS 에 실려
  //   activity EMA 를 밀어올리는 것을 소거하기 위해 부저 동작 상태를 노출.
  bool     busy();          // 비프 시퀀스 진행 중 (ON 또는 남은 펄스 있음)
  uint32_t lastActiveMs();  // 마지막으로 부저가 울리던 millis (0=이 세션 미사용)
}
