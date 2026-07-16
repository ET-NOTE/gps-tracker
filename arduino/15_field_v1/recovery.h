// =================================================================
// recovery — LTE 연결 수명주기 + 복구 에스컬레이션 단일 state machine.
//   원본 13_4_aa 의 흩어진 복구 경로 5개를 한 결정기로 통합:
//     (1) boot-stuck esp_restart  (3) bringup 실패 escalation
//     (4) POST fail streak reinit (5) stuck watchdog soft→hard→restart
//     (6) REG lost soft reset
//   핵심 원칙: 매 tick 단 하나의 액션만 발동 (원본의 이중 리셋 오버랩 제거).
//   POST 자체는 main 이 수행하고 결과를 notifyPostResult() 로 통지 (data ⊥ connectivity).
//   서버 cmd:reset(경로7)=Block6 main, timer-wake(경로2)=Block8 sleep 담당.
// =================================================================
#pragma once
#include <Arduino.h>

namespace recovery {
  enum State { BRINGUP, ONLINE };

  void init(uint32_t bootMs);
  void tick();                        // 매 loop: 상태별 bringup/soft/hard/restart 결정+실행
  void notifyPostResult(bool ok200);  // main 이 POST 직후 호출
  bool online();                      // POST 가능 상태 (== lte::ready())

  const char* stateStr();
  uint32_t lastSuccessMs();
  uint32_t postOks();
  uint32_t postFails();
  uint8_t  bringFails();
  uint8_t  hardResets();
  uint8_t  softStreak();
}
