// =================================================================
// hw_power — GPS(L86) + LTE(SIM7080) 공유 전원 레일 (PWR_EN) + PWRKEY 시퀀싱.
//   이 하드웨어의 최대 결합 지점을 한 곳에 격리: LTE 만 power-cycle 할 수 없고
//   railCycle() 은 GPS 도 함께 껐다 켠다. 순수 GPIO/타이밍만 담당 (UART/AT 없음).
//   LTE AT 핸드셰이크는 lte 모듈(Block 5)이 pulsePwrKey()/railCycle() 를 호출해 조합.
// =================================================================
#pragma once
#include <Arduino.h>

namespace hw_power {
  void init();          // 핀 모드 + DTR/PWRKEY idle. (레일 상태는 안 바꿈)
  void railOn();        // PWR_EN LOW → GPS+LTE 전원 ON. inrush settle 포함.
  void railOff();       // PWR_EN HIGH → 레일 OFF.
  void railCycle();     // OFF(2s) → ON(2s). 모듈 hard power-cycle 의 GPIO 파트.
  void pulsePwrKey();   // PWRKEY idle→pulse→idle. SIM7080 전원 토글 신호.
}
