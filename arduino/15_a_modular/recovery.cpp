#include "recovery.h"
#include "config.h"
#include "lte.h"
#include "breadcrumb.h"
#include <esp_system.h>

namespace recovery {

static uint32_t bootMs_        = 0;
static uint32_t nextBringUpAt_ = 0;
// (P0 2026-07-02) 에스컬레이션 카운터 RTC 승격 — deep sleep-wake 넘어 누적.
//   정지+stuck 시 sleep loop 가 카운터를 리셋해 soft→hard→restart 를 막던 버그 수정.
//   RTC_DATA_ATTR 는 POWERON 시만 0, deep sleep/crash 는 보존 (성공 시 코드가 명시적 리셋).
RTC_DATA_ATTR static uint8_t  bringFails_ = 0;
RTC_DATA_ATTR static uint8_t  hardResets_ = 0;
RTC_DATA_ATTR static uint8_t  softStreak_ = 0;
RTC_DATA_ATTR static uint8_t  dataStreak_ = 0;   // (P1) REG OK 인데 POST 실패 시 data-plane 재활성 횟수
// 타임스탬프는 millis 기반이라 재부팅 시 무의미 → 세션 로컬(static) 유지.
static uint32_t lastSuccessMs_ = 0;   // 0 = 이 세션 성공 POST 아직 없음
static uint32_t stuckSinceMs_  = 0;   // stuck 시작 (성공 POST 시 0 으로 rearm)
static uint32_t lastRegPollMs_ = 0;
static uint32_t lastRegOkMs_   = 0;
static uint32_t postOks_       = 0;
static uint32_t postFails_     = 0;

void init(uint32_t bootMs) {
  bootMs_        = bootMs;
  nextBringUpAt_ = bootMs;   // 첫 loop 에서 즉시 bringUp 시도
  lastRegOkMs_   = bootMs;
}

static void restart(const char *why) {
  bc::set("rec_restart");
  Serial.printf("[REC] 🚨 esp_restart — %s\n", why);
  delay(200);   // 로그 flush (breadcrumb NVS/RTC 반영)
  esp_restart();
}

void tick() {
  uint32_t now = millis();

  // ───────────────── BRINGUP 상태 ─────────────────
  if (!lte::ready()) {
    // 경로(1) boot-stuck: 부팅 후 성공 POST 0 + uptime 초과 → 능동 재부팅
    if (lastSuccessMs_ == 0 && (now - bootMs_) > BOOT_STUCK_RESTART_MS) {
      restart("boot-stuck (no POST in 5min)");
    }
    if ((int32_t)(now - nextBringUpAt_) < 0) return;

    // 경로(3) bringup 실패 escalation — 재시도 전에 판정
    if (bringFails_ >= BRINGUP_FAIL_HARD) {
      bringFails_ = 0;
      hardResets_++;
      if (hardResets_ > HARD_RESET_LIMIT) restart("bringup hardResets>limit");
      Serial.printf("[REC] bringup 연속실패 → hardCycle (hardResets=%u)\n", hardResets_);
      lte::hardCycle();
    }

    Serial.printf("[REC] bringUp 시도 (fails=%u hardResets=%u)\n", bringFails_, hardResets_);
    if (lte::bringUp()) {
      Serial.printf("[REC] → ONLINE (CSQ=%d REG=%d IP=%s)\n", lte::csq(), lte::reg(), lte::ip());
      lte::fetchSimInfo();
      bringFails_ = 0; hardResets_ = 0; softStreak_ = 0; dataStreak_ = 0; stuckSinceMs_ = 0;
      lastRegOkMs_ = millis();
    } else {
      bringFails_++;
    }
    nextBringUpAt_ = millis() + LTE_BRINGUP_RETRY_MS;
    return;
  }

  // ───────────────── ONLINE 상태 ─────────────────
  // 경로(4)+(5) stuck watchdog: 마지막 성공 POST 후 60s 무응답.
  // (P1) REG 상태로 분기 — 등록 유지면 data-plane 만 가볍게(CFUN 안 함), 등록 상실이면 CFUN.
  if (lastSuccessMs_ > 0 && (now - lastSuccessMs_) > STUCK_POST_TIMEOUT_MS) {
    if (stuckSinceMs_ == 0) stuckSinceMs_ = now;
    if ((now - stuckSinceMs_) > STUCK_RESTART_TIMEOUT_MS) restart("stuck 5min (soft/hard 무효)");

    lte::refresh();                          // 최신 REG/CSQ
    bool regOk = (lte::reg() == 1 || lte::reg() == 5);

    if (regOk && dataStreak_ < DATA_RETRY_LIMIT) {
      // "reg OK but conn=0" → 등록 날리지 말고 PDP/SHCONN 만 재활성 (CFUN 안 함)
      Serial.printf("[REC] 60s 무응답 (REG=%d OK) → data 재활성 (streak=%u)\n", lte::reg(), dataStreak_ + 1);
      dataStreak_++;
      lte::reactivateData();                 // ready_ 유지 → 다음 POST 재시도
    } else if (softStreak_ < SOFT_TO_HARD_STREAK) {
      Serial.printf("[REC] 60s 무응답 (REG=%d) → softReset (streak=%u)\n", lte::reg(), softStreak_ + 1);
      softStreak_++;
      lte::softReset();                      // ready_=false → 다음 tick BRINGUP
      nextBringUpAt_ = millis() + 1000;
    } else {
      Serial.println(F("[REC] soft 반복 실패 → hardCycle"));
      softStreak_ = 0;
      lte::hardCycle();                      // ready_=false
      nextBringUpAt_ = millis() + 1000;
    }
    lastSuccessMs_ = now;             // 60s cooldown rearm (stuckSinceMs_ 는 유지 = 총 stuck)
    return;                          // ← 매 tick 단일 액션
  }

  // 경로(6) REG 모니터: 10s 마다 재조회, 30s 연속 미등록 → soft
  if ((now - lastRegPollMs_) > REG_POLL_MS) {
    lastRegPollMs_ = now;
    lte::refresh();
    int r = lte::reg();
    if (r == 1 || r == 5) {
      lastRegOkMs_ = now;
    } else if (lastRegOkMs_ > 0 && (now - lastRegOkMs_) > REG_LOST_MS) {
      Serial.println(F("[REC] REG 상실 30s → softReset"));
      lastRegOkMs_ = now;
      lte::softReset();
      nextBringUpAt_ = millis() + 1000;
      return;
    }
  }
}

void notifyPostResult(bool ok200) {
  if (ok200) {
    uint32_t now = millis();
    lastSuccessMs_ = now;
    stuckSinceMs_  = 0;
    softStreak_    = 0;
    dataStreak_    = 0;
    lastRegOkMs_   = now;
    postOks_++;
  } else {
    postFails_++;
  }
}

bool online() { return lte::ready(); }

const char* stateStr() { return lte::ready() ? "ONLINE" : "BRINGUP"; }
uint32_t lastSuccessMs() { return lastSuccessMs_; }
uint32_t postOks()       { return postOks_; }
uint32_t postFails()     { return postFails_; }
uint8_t  bringFails()    { return bringFails_; }
uint8_t  hardResets()    { return hardResets_; }
uint8_t  softStreak()    { return softStreak_; }

} // namespace recovery
