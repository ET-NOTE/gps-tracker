// =================================================================
// breadcrumb — 마지막 실행 단계를 RTC 에 기록 (crash/stuck 위치 진단).
//   RTC_DATA_ATTR 라 deep sleep/soft reset/brownout/WDT/panic 모두 보존 (POWERON 만 초기화).
//   다음 부팅에서 reset_cause + last_op 조합으로 "어디서 죽었는지" 파악.
//   의미있는 경계에서만 set() (loop idle 처럼 빈번한 곳 X).
// =================================================================
#pragma once
#include <Arduino.h>

namespace bc {
  void set(const char *op);
  const char* last();
}
