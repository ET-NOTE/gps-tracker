// =================================================================
// motion — LIS3DH 가속도계 (모션 wake 소스 + 정지 판정 입력).
//   책임: I2C init + 0x19/0x18 auto-probe, INT1 (active-low) 인터럽트 기반
//         모션 이벤트 카운트, I2C wedge 자동 복구(reinit).
//   디커플링: sleep/POST 를 직접 안 부름. 이벤트/quiet 를 accessor 로 노출.
// =================================================================
#pragma once
#include <Arduino.h>

namespace motion {
  void init();       // Wire.begin + LIS3DH init + attach INT
  void tick();       // loop 마다: latch clear + I2C 헬스/reinit

  bool     ok();               // LIS 초기화 & 헬시
  uint32_t events();           // 누적 모션 이벤트
  uint32_t lastMs();           // 마지막 이벤트 millis (0=없음)
  bool     quiet(uint32_t quietMs);  // 최근 quietMs 동안 이벤트 0
  void     clearLatch();             // INT1_SRC 읽어 latch clear (deep sleep 진입 전 자가-wake 방지)
  uint32_t reinits();          // I2C wedge reinit 누적 (RTC 보존)
  uint32_t badStreak();        // 현재 연속 0xFF (I2C 결선 진단)

  // (P2 튜닝 진단 2026-07-03) 원시 가속도 — THS/DUR 재튜닝용. ±2g HR, mg 단위.
  bool     readRaw(int16_t &xMg, int16_t &yMg, int16_t &zMg);
  int      rawMagMg();         // |a| (중력 포함). 동적성분 ≈ |rawMagMg()-1000|. 실패 -1.
}
