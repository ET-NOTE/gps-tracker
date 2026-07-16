// =================================================================
// telemetry — 모듈 상태(gps/motion/lte + 배터리)를 서버 JSON payload 로 조합.
//   순수 view/formatter. 데이터 모듈에 단방향 의존 (telemetry → gps/motion/lte).
//   Block 6: 핵심 payload + batch fixes. diag/stationary 조각은 Block 7/8 에서 확장.
// =================================================================
#pragma once
#include <Arduino.h>

namespace telemetry {
  const char* deviceUid();   // sim-<iccid 뒤8> (없으면 esp-<mac>)
  // body 작성. 포함한 batch fix 수 반환 (POST 200 시 gps::batchDrop 에 사용).
  //   diagPending=true 면 wake 진단 조각(diag{}) 포함 (wake 후 첫 POST 만).
  uint8_t buildPayload(char *out, size_t cap, uint32_t bootMs, bool diagPending);
  // deep sleep 진입 이벤트 payload (railOff 전, LTE 살아있을 때 전송).
  void buildSleepPayload(char *out, size_t cap, uint32_t bootMs, const char *reason);
}
