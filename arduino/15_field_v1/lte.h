// =================================================================
// lte — SIM7080G AT 계층 + bring-up (등록/PDP/IP) + soft/hard reset + SIM 식별.
//   Block 5: 데이터 준비(PDP+IP)까지. HTTP(SHxxx)는 Block 6 에서 이 모듈에 추가.
//   블로킹 AT 트랜잭션을 이 모듈에 격리. 전원 토글은 hw_power 에 위임.
//   ※ 원본의 esp_task_wdt_reset feed 는 no-op 이라 이관 안 함 (2026-07-02 제거 결정).
// =================================================================
#pragma once
#include <Arduino.h>

namespace lte {
  void init();          // UART begin + power-on (hw_power::railOn() 선행 가정)
  bool bringUp();       // AT→CPIN→CEREG→CNACT→IP. true=PDP ready.
  bool reactivateData();// (P1) 등록 유지한 채 PDP/SHCONN 만 재활성 (CFUN 안 함 — data-plane 복구)
  bool softReset();     // CFUN 0→1 (+COPS=0) 재등록
  void hardCycle();     // hw_power::railCycle + power-on (무거운 복구)
  void fetchSimInfo();  // ICCID/IMEI/IMSI
  void refresh();       // CSQ + CEREG 재조회 (cached csq_/reg_ 갱신)

  // ── HTTP (Block 6) ──
  //   host/path 는 config 상수(POST_URL_HOST/POST_PATH). SHCONN/SHREQ keepalive 유지.
  bool     httpPost(const char *body, int *statusOut);
  void     resetHttpKeepalive();     // 모듈 reset / CFUN cycle 시 SHCONF/SHCONN 재설정 필요
  bool     httpConnected();
  uint32_t postIntervalMs();         // 서버 cmd 로 조정됨 (RAM, reset 시 default 복귀)
  bool     consumeServerBeep();      // 서버 cmd:beep 1회 (main 이 buzzer 트리거)
  bool     consumeServerReset();     // 서버 cmd:reset 1회 (main/recovery 가 hardCycle)

  // 상태
  bool     ready();
  int      csq();
  int      reg();
  const char* ip();
  uint16_t bringUpCount();
  uint32_t firstAtOkMs();   // 첫 AT OK 시각 (payload at_ms, 0=아직)
  const char* iccid();
  const char* imei();
  const char* imsi();
}
