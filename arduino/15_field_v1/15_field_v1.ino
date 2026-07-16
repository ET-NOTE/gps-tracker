// =================================================================
// 15_field_v1 — FIELD 배포 후보 (15_a_modular 2026-07-02 스냅샷: Block1~8 + P0 + P1).
//   동료 휴대용. 운영 sleep 스케줄(OBSERVE_MODE 0: 정지 5분→deep sleep, 10분 timer wake),
//   모션 wake, 부저 활성, Serial=CDC + setTxTimeoutMs(0)(non-blocking, 리더 있으면 로그 가능).
//   FQBN: esp32:esp32:esp32c3:CDCOnBoot=cdc.
//   ⚠️ 이 폴더는 릴리스 스냅샷 — 이후 15_a_modular 개선은 재스냅샷 필요.
// ---------------------------------------------------------------
// (원본) 15_a_modular — 13_4_aa 구조적 리팩터.
//   목표: 사고 대응 패치 누적으로 얽힌 복구 경로(7개)/블로킹 구조를 모듈로 분리하고
//         단일 recovery state machine 으로 통합. 블록별 실기 검증하며 이관.
//   원본 golden reference: ../13_4_aa_motion_aware_tracker
//
//   Block 1 (done): config.h + buzzer.
//   Block 2 (done): hw_power — 공유 PWR_EN 레일 + PWRKEY.
//   Block 3 (done): gps — LC86G·NMEA·안테나·fix·drift·batch.
//   Block 4 (done*): motion — LIS3DH. wake OK. ※런타임 카운터 open item (motion.cpp).
//   Block 5 (done): lte — AT + bring-up + SIM.
//   Block 6 (done): lte HTTP keepalive + telemetry. POST 200 검증.
//   Block 7 (done): recovery — 복구 경로 통합 단일 state machine (무오발동 검증).
//   Block 8 (현재): sleep_mgr — deep sleep + wake 부기 + 정지 자동 sleep + timer-wake heartbeat.
//     검증: 정지 5분(또는 테스트 단축) → deep sleep → 모션 wake → 재bringup. wake 카운터.
//   ※ 부저는 아티팩트 진단 위해 config 에서 OFF. drive_capture.ps1 = 실외 관찰용.
// =================================================================
#include <esp_system.h>
#include "config.h"
#include "buzzer.h"
#include "hw_power.h"
#include "gps.h"
#include "motion.h"
#include "lte.h"
#include "telemetry.h"
#include "recovery.h"
#include "sleep_mgr.h"
#include "breadcrumb.h"

static uint32_t bootMs = 0;
static uint32_t nextPostAt = 0;
static bool diagPending = true;   // wake 후 첫 POST 에 diag{} 포함 (매 부팅 true — deep sleep 재부팅마다)

// 부저 마일스톤 가드 — RTC 보존 (deep sleep/wake 넘어 세션당 1회). 모션 wake 시 fix/post 재활성.
RTC_DATA_ATTR static bool buzzBoot      = false;
RTC_DATA_ATTR static bool buzzFirstFix  = false;
RTC_DATA_ATTR static bool buzzFirstPost = false;

static uint16_t readVbatMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(PIN_BAT);
  return (uint16_t)((sum / 16) * BAT_DIV_RATIO);
}

static void printStatus() {
  uint32_t up_s = (millis() - bootMs) / 1000;
  Serial.printf("[STATUS %lus wake=%s] %s vbat=%umV heap=%lu | LTE:%s CSQ=%d REG=%d IP=%s conn=%d bu=%u | esc(bf=%u hr=%u ss=%u) | GPS:%s sat=%d batch=%u | MOT t=%lu lis=%s",
    (unsigned long)up_s, sleep_mgr::wakeReason(), recovery::stateStr(),
    (unsigned)readVbatMv(), (unsigned long)ESP.getFreeHeap(),
    lte::ready() ? "OK" : "--", lte::csq(), lte::reg(), lte::ip(),
    (int)lte::httpConnected(), (unsigned)lte::bringUpCount(),
    (unsigned)recovery::bringFails(), (unsigned)recovery::hardResets(), (unsigned)recovery::softStreak(),
    gps::hasFix() ? "FIX" : "---", gps::satellites(), (unsigned)gps::batchCount(),
    (unsigned long)motion::events(), motion::ok() ? "ok" : "--");
  if (sleep_mgr::stationaryActive()) {
    Serial.printf(" | STAT %lu/%lus drift=%.1fm",
      (unsigned long)(sleep_mgr::stationaryHeldMs() / 1000),
      (unsigned long)(STATIONARY_WINDOW_MS / 1000), sleep_mgr::lastDriftM());
  }
  if (sleep_mgr::timerWakeMode()) Serial.print(F(" | TIMER_HB"));
  Serial.println();
}

static void doPost() {
  bc::set("do_post");
  static char body[8192];   // batch 최대 120 fix + diag 조각 → 원본과 동일 8KB
  uint8_t posted = telemetry::buildPayload(body, sizeof(body), bootMs, diagPending);
  if (DBG) { Serial.print(F("[POST body] ")); Serial.println(body); }

  int status = -1;
  uint32_t t0 = millis();
  bool ok = lte::httpPost(body, &status);
  bool ok200 = ok && status == 200;
  Serial.printf("[POST] elapsed=%lums status=%d ok=%d conn=%d posted=%u\n",
    (unsigned long)(millis() - t0), status, (int)ok, (int)lte::httpConnected(), posted);

  if (ok200 && posted > 0) gps::batchDrop(posted);
  recovery::notifyPostResult(ok200);
  if (ok200) diagPending = false;   // wake diag 는 첫 성공 POST 1회만
  if (ok200 && !buzzFirstPost) { buzzFirstPost = true; buzzer::beep(4, 80, 80); buzzer::flush(); }

  if (lte::consumeServerBeep())  { Serial.println(F("[BUZ] server cmd:beep")); buzzer::beep(5, 200, 100); buzzer::flush(); }
  if (lte::consumeServerReset()) { Serial.println(F("[LTE] server cmd:reset → hardCycle")); lte::hardCycle(); }

  if (ok200) sleep_mgr::onPostSuccess();   // timer-wake heartbeat 완료 시 여기서 re-sleep
}

void setup() {
  bootMs = millis();
  buzzer::init();   // ★ 최상단: GPIO1 즉시 LOW (능동 부저 boot-floating buzz 방지)
  bc::set("setup");
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);   // ★ FIELD: 리더 없으면 로그 drop(non-blocking) → CDC-full stuck 방지
  delay(200);
  Serial.println();
  Serial.println(F("=== 15_field_v1 — FIELD build (production candidate) ==="));

  esp_reset_reason_t rr = esp_reset_reason();
  Serial.printf("[BOOT] reset_reason=%d\n", (int)rr);

  analogReadResolution(12);

  hw_power::init();
  Serial.println(F("[PWR] railOn"));
  hw_power::railOn();

  Serial.println(F("[MOT] init"));  motion::init();
  sleep_mgr::begin(bootMs);          // wake/reset 부기 + bounce 필터 (motion 이후)

  // 부저 마일스톤 — 부팅/wake 청각 피드백
  if (strcmp(sleep_mgr::wakeReason(), "motion") == 0) {
    buzzFirstFix = false; buzzFirstPost = false;   // wake 마다 fix/post 비프 재활성
    buzzer::beep(WAKE_BEEP_COUNT, 60, 60);          // (FIELD) 모션 wake: 6회
  } else if (!buzzBoot) {
    buzzBoot = true;
    buzzer::beep(1, 400, 0);                        // cold boot: 긴 1회
  }
  buzzer::flush();

  Serial.println(F("[GPS] init"));  gps::init(bootMs);

  Serial.println(F("[LTE] power-on (bringUp 은 recovery)"));
  lte::init();
  recovery::init(bootMs);

  nextPostAt = millis() + 2000;
  printStatus();
}

void loop() {
  gps::feed();
  motion::tick();
  if (gps::consumeFirstFixEvent()) {
    Serial.println(F("[GPS] first fix event"));
    if (!buzzFirstFix) { buzzFirstFix = true; buzzer::beep(3, 80, 80); buzzer::flush(); }
  }

  recovery::tick();

  if (recovery::online() && (int32_t)(millis() - nextPostAt) >= 0) {
    doPost();
    nextPostAt = millis() + lte::postIntervalMs();
  }

  sleep_mgr::checkStationary();   // 정지 5분 → deep sleep
  sleep_mgr::timerWakeTick();     // timer-wake 2분 guard

  static uint32_t lastStatusMs = 0;
  if (millis() - lastStatusMs > STATUS_PRINT_MS) {
    lastStatusMs = millis();
    printStatus();
  }
  buzzer::update();
  delay(10);
}
