#pragma once
// =================================================================
// loopwdt — loop task 하드웨어 워치독 (2026-07-06 P6)
//   배경: 07-04/07-05 aa(15_field_v2)가 수시간 offline. 원인 후보 = loop()이 라이브러리/HW
//     경로(I2C 버스 wedge, USB CDC, deep-sleep/wake 등)에서 멈춤 → 잡을 워치독이 없음.
//     (07-02 에 task-WDT feed 를 "no-op 이라" 제거했는데, 올바른 조치는 loop task 를 등록해
//      제대로 feed 하는 것이었음. 제거로 인해 loop hang 이 무한 방치됨.)
//   조치: setup 끝에서 loop task 를 TWDT 에 등록(panic=on), loop top + AT 대기루프 + sleep 진입
//     에서 feed. timeout 초과(=진짜 hang) → panic reset(ESP_RST_TASK_WDT) → 부팅 → recovery.
//     panic 백트레이스가 hang 위치 진단에도 도움. (panic reset 은 RTC 소실 — INT-WDT 와 동일.)
//   정상 블로킹(bringup/httpPost)은 sendAT/probeModem feed 로 커버되어 오탐 없음.
// =================================================================
#include "config.h"

#if LOOP_WDT_ENABLED
#include "esp_task_wdt.h"

namespace lwdt {
  inline bool &_armed() { static bool a = false; return a; }   // arm 전 feed 는 무시(로그오염 방지)
  inline void arm() {
    esp_task_wdt_config_t c = {};
    c.timeout_ms     = LOOP_WDT_TIMEOUT_MS;
    c.idle_core_mask = 0;            // idle task 는 감시 안 함 — loop task 만
    c.trigger_panic  = true;         // timeout → panic reset → recovery
    esp_err_t e = esp_task_wdt_init(&c);
    if (e == ESP_ERR_INVALID_STATE) esp_task_wdt_reconfigure(&c);   // 코어가 이미 init 함
    esp_task_wdt_add(NULL);          // 현재(loop) task 등록
    _armed() = true;
    esp_task_wdt_reset();
    Serial.printf("[WDT] loop task-WDT armed timeout=%lus panic=1\n",
      (unsigned long)(LOOP_WDT_TIMEOUT_MS / 1000));
  }
  inline void feed() { if (_armed()) esp_task_wdt_reset(); }
}

#else
namespace lwdt { inline void arm() {} inline void feed() {} }
#endif
