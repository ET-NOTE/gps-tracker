#include "recovery.h"
#include "config.h"
#include "lte.h"
#include "buzzer.h"
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
static uint32_t lastSuccessMs_ = 0;   // 0 = 이 세션 성공 POST 아직 없음 (진짜 성공만 — escalation rearm 은 아래 별도)
static uint32_t lastEscalationMs_ = 0;   // [2026-08-14] 60s 쿨다운 anchor — lastSuccessMs_ 재사용(의미 오염) 분리
static uint32_t stuckSinceMs_  = 0;   // stuck 시작 (성공 POST 시 0 으로 rearm)
static uint32_t lastRegPollMs_ = 0;
static uint32_t lastRegOkMs_   = 0;
static uint32_t lastHardCycleMs_ = 0;   // (③ 2026-07-08) hardCycle 인러시 back-off 용
static uint32_t postOks_       = 0;
static uint32_t postFails_     = 0;

void init(uint32_t bootMs) {
  bootMs_        = bootMs;
  nextBringUpAt_ = bootMs;   // 첫 loop 에서 즉시 bringUp 시도
  lastRegOkMs_   = bootMs;
  // [2026-07-14 fix#6] 첫 hardCycle 이 부팅후 2분간 back-off 로 막히던 것 해제 —
  //   과거로 초기화(모듈러 wrap 안전)해 부팅/재시작 직후 즉시 hardCycle 허용.
  lastHardCycleMs_ = bootMs - HARDCYCLE_MIN_INTERVAL_MS;
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
    //   (A 2026-07-08) 단, CSQ=99(무신호=커버리지 없음, 지하주차장 등)면 재부팅해도 어차피 무신호 →
    //     재부팅 루프만 됨 → skip, 저빈도 재시도만 지속. 신호 있는데 못 붙는 "진짜 stuck"일 때만 재부팅.
    if (lastSuccessMs_ == 0 && (now - bootMs_) > BOOT_STUCK_RESTART_MS) {
      // [2026-07-14 fix#7] csq>0 && !=99 (진짜 신호 있음)일 때만 재부팅. csq=99(무신호)/csq<=0(AT 무응답·불명)은
      //   재부팅해도 소용없어 skip (모뎀 행이면 esp_restart 로는 모뎀 전원 못 끊음 → 저빈도 재시도만).
      if (lte::csq() > 0 && lte::csq() != 99) restart("boot-stuck (signal present, no POST)");
    }
    if ((int32_t)(now - nextBringUpAt_) < 0) return;

    // (2026-07-08 non-blocking) 등록 대기 중이면 escalation/부저 없이 CEREG 폴만 (loop 90초 안 굶김)
    if (lte::bringInProgress()) {
      if (lte::bringUp()) {                          // 등록완료+PDP → ONLINE
        Serial.printf("[REC] → ONLINE (CSQ=%d REG=%d IP=%s)\n", lte::csq(), lte::reg(), lte::ip());
        lte::fetchSimInfo();
        bringFails_ = 0; hardResets_ = 0; softStreak_ = 0; dataStreak_ = 0; stuckSinceMs_ = 0;
        lastRegOkMs_ = millis();
        nextBringUpAt_ = millis() + LTE_BRINGUP_RETRY_MS;
      } else if (lte::bringInProgress()) {
        nextBringUpAt_ = millis() + REG_POLL_FAST_MS;   // 계속 폴(빠르게)
      } else {
        bringFails_++;                               // reg timeout → 실패로 카운트
        nextBringUpAt_ = millis() + LTE_BRINGUP_RETRY_MS;
      }
      return;
    }

    // 경로(3) bringup 실패 escalation — 재시도 전에 판정
    //   (③ 2026-07-08) hardCycle 인러시 back-off: 최소간격 미만이면 railCycle 생략(soft 재시도만).
    //     무신호 지역에선 hardCycle 해도 등록 안 되고 인러시 전류만 반복 → 전원 마진 보드 브라운아웃 유발.
    if (bringFails_ >= BRINGUP_FAIL_HARD) {
      bringFails_ = 0;
      if (now - lastHardCycleMs_ >= HARDCYCLE_MIN_INTERVAL_MS) {
        hardResets_++;
        // [2026-07-14 fix#3] 무신호(csq=99)면 restart 스킵 — hardResets_ 는 RTC 라 esp_restart 넘어 누적돼
        //   무신호 지역서 ~2분마다 재부팅 루프 되던 것 방지 (line 50 boot-stuck 과 동일 논리).
        if (hardResets_ > HARD_RESET_LIMIT && lte::csq() != 99) restart("bringup hardResets>limit");
        Serial.printf("[REC] bringup 연속실패 → hardCycle (hardResets=%u)\n", hardResets_);
        lte::hardCycle();
        lastHardCycleMs_ = now;
      } else {
        // [2026-07-14 fix#5] 로그 정정: 이 경로는 softReset(CFUN) 이 아니라 아래 bringUp() AT 재시도만 함.
        Serial.printf("[REC] hardCycle back-off (%lus 남음, 인러시 억제) — bringUp AT 재시도만\n",
          (unsigned long)((HARDCYCLE_MIN_INTERVAL_MS - (now - lastHardCycleMs_)) / 1000));
      }
    }

    // [2026-07-13 제거] LTE 재시도 짧은삐(50ms) — POST200 정상통신 짧은삐(60ms)와 귀로 구분 안 돼
    //   "짧은삐+통신두절 공존" 혼란 유발 → 제거. 이제 짧은삐1회 = 오직 정상통신 POST200.
    Serial.printf("[REC] bringUp 시도 (fails=%u hardResets=%u)\n", bringFails_, hardResets_);
    if (lte::bringUp()) {                            // (드물게 즉시 ready — 보통 Phase1→in-progress)
      Serial.printf("[REC] → ONLINE (CSQ=%d REG=%d IP=%s)\n", lte::csq(), lte::reg(), lte::ip());
      lte::fetchSimInfo();
      bringFails_ = 0; hardResets_ = 0; softStreak_ = 0; dataStreak_ = 0; stuckSinceMs_ = 0;
      lastRegOkMs_ = millis();
      nextBringUpAt_ = millis() + LTE_BRINGUP_RETRY_MS;
    } else if (lte::bringInProgress()) {
      nextBringUpAt_ = millis() + REG_POLL_FAST_MS;  // Phase1 성공 → 등록대기 진입, 빠르게 폴
    } else {
      bringFails_++;                                 // Phase1 실패(AT 무응답)
      nextBringUpAt_ = millis() + LTE_BRINGUP_RETRY_MS;
    }
    return;
  }

  // ───────────────── ONLINE 상태 ─────────────────
  // 경로(4)+(5) stuck watchdog: 마지막 성공 POST 후 60s 무응답.
  // (P1) REG 상태로 분기 — 등록 유지면 data-plane 만 가볍게(CFUN 안 함), 등록 상실이면 CFUN.
  // [2026-07-14 fix#1] lastSuccessMs_==0(첫 성공 POST 없음)도 stuck 으로 처리 — ONLINE(PDP up)인데
  //   POST 를 단 한 번도 성공 못 하는 영구 stuck 방지. (anchor=bootMs → uptime 60s 넘으면 escalation
  //   시작 → data재활성/soft/hard, 미해결 시 STUCK_RESTART_TIMEOUT(30분)에 restart.)
  // [2026-08-14] 쿨다운 anchor 를 lastEscalationMs_ 로 분리 — 기존 lastSuccessMs_=now rearm 은
  //   "마지막 성공 POST" 의미를 오염시켜 sleep_mgr 의 RECOVERY_STAY_AWAKE 판정이 escalation 시각
  //   기준으로 밀리던 문제(설계보다 수 분 늦게 sleep) 유발.
  uint32_t anchor = lastSuccessMs_ ? lastSuccessMs_ : bootMs_;
  if (lastEscalationMs_ && (int32_t)(lastEscalationMs_ - anchor) > 0) anchor = lastEscalationMs_;
  if ((now - anchor) > STUCK_POST_TIMEOUT_MS) {
    if (stuckSinceMs_ == 0) stuckSinceMs_ = now;
    if ((now - stuckSinceMs_) > STUCK_RESTART_TIMEOUT_MS) restart("stuck 30min (soft/hard 무효)");

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
      lastHardCycleMs_ = now;   // [2026-08-14] stuck 경로 hardCycle 도 인러시 back-off arm (기존 누락 — bringup 경로만 arm 됐음)
      nextBringUpAt_ = millis() + 1000;
    }
    lastEscalationMs_ = now;          // 60s cooldown rearm (stuckSinceMs_ 는 유지 = 총 stuck)
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
    lastEscalationMs_ = 0;
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
