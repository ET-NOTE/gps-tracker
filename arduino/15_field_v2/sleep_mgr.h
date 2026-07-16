// =================================================================
// sleep_mgr — 전원 사이클(deep sleep) + wake/reset 부기 + 정지 자동 sleep.
//   책임: 부팅 시 wake/reset 원인 판정 + RTC 카운터, 모션 wake bounce 필터,
//         정지(LIS quiet + GPS no-drift) 5분 → deep sleep, 모션/10분-timer wake,
//         timer-wake heartbeat(1 POST 후 즉시 re-sleep).
//   wake 소스 = LIS INT (항시전원). GPS+LTE 는 hw_power::railOff 로 차단.
//   ⚠️ LIS 미검출 시 sleep 자체 비활성 (wake 불가 deadlock 방지).
// =================================================================
#pragma once
#include <Arduino.h>

namespace sleep_mgr {
  void begin(uint32_t bootMs);          // setup 초반 (motion::init 이후 호출 — bounce 체크에 LIS 필요)
  void checkStationary();               // loop: 정지 5분 → enterDeepSleep
  void timerWakeTick();                 // loop: timer-wake 2분 guard
  void onPostSuccess();                 // main 이 POST 200 시 호출 (timer-wake heartbeat 완료)
  void enterDeepSleep(const char *reason);

  bool timerWakeMode();
  const char* wakeReason();
  const char* resetCause();          // POWERON/DEEPSLEEP/BROWNOUT/... (payload reset_cause)
  uint32_t lastSleepUptimeS();       // 직전 sleep 시점 uptime (RTC 보존)

  // 정지 진행상황 (STATUS/telemetry)
  bool     stationaryActive();
  uint32_t stationaryHeldMs();
  float    lastDriftM();
  int      stationaryFixes();        // 최근 drift 평가의 유효 fix 수
  bool     stationaryGpsAvail();     // 최근 평가 시 GPS 가용 여부

  // RTC 카운터 (telemetry diag)
  uint32_t bootCount();
  uint32_t wakeCount();
  uint32_t wakeMotion();
  uint32_t brownoutCount();
}
