#include "sleep_mgr.h"
#include "config.h"
#include "buzzer.h"
#include "motion.h"
#include "gps.h"
#include "hw_power.h"
#include "lte.h"
#include "telemetry.h"
#include "recovery.h"
#include "breadcrumb.h"
#include "loopwdt.h"
#include <esp_sleep.h>
#include <esp_system.h>
#include "driver/gpio.h"

namespace sleep_mgr {

RTC_DATA_ATTR static uint32_t rtcBoot_          = 0;
RTC_DATA_ATTR static uint32_t rtcWake_          = 0;
RTC_DATA_ATTR static uint32_t rtcWakeMotion_    = 0;
RTC_DATA_ATTR static uint32_t rtcBrown_         = 0;
RTC_DATA_ATTR static uint32_t rtcLastSleepUpS_  = 0;
RTC_DATA_ATTR static uint16_t rtcBounce_        = 0;   // [2026-08-14] 연속 bounce re-sleep 카운터 (오판 escape 용)

static uint32_t bootMs_          = 0;
static const char *wakeReason_   = "boot";
static const char *resetCause_   = "?";
static bool     timerWake_       = false;
[[maybe_unused]] static bool inSleep_ = false;

static uint32_t stationarySince_ = 0;
static float    lastDrift_       = 0;
static int      lastFixesN_      = 0;
static bool     lastGpsAvail_    = false;

// [2026-08-14] "sleep 미진입" 진단 — 현재 블로킹 게이트 + window 리셋 원인별 카운트 (telemetry 로 노출)
static const char *stayCause_    = "boot";
static uint16_t rstActive_ = 0, rstDrift_ = 0, rstNoGps_ = 0;
static uint32_t sleepAborts_ = 0;
static bool resumeReportPending_ = false;
[[maybe_unused]] static bool sleepIntentSent_ = false;
[[maybe_unused]] static bool movementDuringSleep_ = false;
RTC_DATA_ATTR static uint32_t rtcShutdownUnconfirmed_ = 0;

#if !SLEEP_DISABLED
// Read the latched interrupt BEFORE tick() clears it. Retain movement observed
// during HTTP/CPOWD even if the device becomes quiet again before they return.
static void observeSleepMotion() {
  const bool asserted = digitalRead(PIN_LIS_INT) == LOW;
  motion::tick();
  if (asserted || !motion::ok() || motion::badStreak() || motion::active())
    movementDuringSleep_ = true;
}

static bool settleBeforeSleep() {
  const uint32_t start = millis();
  uint32_t highSince = start;
  // One stale latch may be from the sleep beep. After this settling stage no
  // interrupt is discarded: movement cancels the entire sleep attempt.
  motion::clearLatch();
  while (millis() - start < SLEEP_PRE_SETTLE_MAX_MS) {
    lwdt::feed();
    const bool asserted = digitalRead(PIN_LIS_INT) == LOW;
    motion::tick();
    if (!motion::ok() || motion::badStreak()) return false;
    if (asserted || motion::active()) highSince = millis();
    else if (millis() - highSince >= 300) {
      const int mag = motion::rawMagMg();
      return mag >= MOTION_MAG_MIN_MG && mag <= MOTION_MAG_MAX_MG;
    }
    delay(20);
  }
  return false;
}

static bool abortSleep(const char *cause, bool wakeArmed = false,
                       bool railWasCut = false, bool shutdownStarted = false,
                       lte::ShutdownResult result = lte::ShutdownResult::NotStarted) {
  lte::setSleepObserver(nullptr);
  if (wakeArmed) esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  gpio_deep_sleep_hold_dis();
  gpio_hold_dis((gpio_num_t)PIN_BUZZER);
  hw_power::releaseSleepHold();
  if (railWasCut) hw_power::railOn();
  if (shutdownStarted) lte::resumeAfterSleepAbort(railWasCut, result);
  inSleep_ = false;
  timerWake_ = false; // movement/sensor failure promotes timer heartbeat to tracking
  stationarySince_ = 0;
  if (sleepIntentSent_) resumeReportPending_ = true;
  sleepIntentSent_ = false;
  stayCause_ = cause;
  sleepAborts_++;
  bc::set("sleep_abort");
  Serial.printf("[SLEEP] aborted: %s; tracking resumed\n", cause);
  return false;
}
#endif

// window 리셋 헬퍼 — 진행중이던 window 가 죽은 경우만 카운트 (게이트가 0 을 유지하는 tick 은 비카운트)
[[maybe_unused]] static void resetWindow(const char *cause, uint16_t &cnt) {
  if (stationarySince_ != 0) cnt++;
  stationarySince_ = 0;
  stayCause_ = cause;
}

static const char *resetReasonStr(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:   return "POWERON";
    case ESP_RST_EXT:       return "EXT";
    case ESP_RST_SW:        return "SW";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INT-WDT";
    case ESP_RST_TASK_WDT:  return "TASK-WDT";
    case ESP_RST_WDT:       return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
#if ESP_IDF_VERSION_MAJOR >= 5
    case ESP_RST_USB:       return "USB";   // IDF5+ 에만 존재 (코어버전 테스트 IDF4 가드)
#endif
    default:                return "OTHER";
  }
}

// -----------------------------------------------------------------
bool enterDeepSleep(const char *reason) {
#if SLEEP_DISABLED
  // All entry points (stationary, timer, bounce, future callers) obey the KC gate.
  stayCause_ = "disabled";
  return false;
#else
  if (inSleep_) return false;
  sleepIntentSent_ = false;
  if (!motion::ok()) return abortSleep("no_lis");
  inSleep_ = true;
  bc::set("sleep_prepare");
  buzzer::beep(2, 150, 120);
  buzzer::flush();
  delay(BUZZ_RINGDOWN_MS);
  if (!settleBeforeSleep()) return abortSleep("settle_abort");

  movementDuringSleep_ = false;
  lte::setSleepObserver(observeSleepMotion);
  observeSleepMotion();
  if (movementDuringSleep_) return abortSleep("motion_before_post");

  if (lte::ready()) {
    if (gps::batchCount() > 0) {
      static char fbody[8192];
      uint8_t posted = telemetry::buildPayload(fbody, sizeof(fbody), bootMs_, false);
      int fst = -1;
      const bool sent = lte::httpPost(fbody, &fst);
      if (sent && fst == 200 && posted > 0) gps::batchDrop(posted);
      Serial.printf("[SLEEP] batch flush: %u fix, status=%d\n", posted, fst);
    }
    observeSleepMotion();
    if (movementDuringSleep_) return abortSleep("motion_after_flush");
    // Last online notification is sleep intent. It can still be cancelled;
    // sleep_aborts in subsequent telemetry explains the resumed session.
    static char sbody[1024];
    telemetry::buildSleepPayload(sbody, sizeof(sbody), bootMs_, reason);
    int st = -1;
    const bool sent = lte::httpPost(sbody, &st);
    sleepIntentSent_ = sent && st == 200;
    Serial.printf("[SLEEP] sleep_enter POST status=%d\n", st);
  }
  observeSleepMotion();
  if (movementDuringSleep_) return abortSleep("motion_after_post");

  // Validate wake configuration before shutting down communications.
  if (esp_deep_sleep_enable_gpio_wakeup(1ULL << PIN_LIS_INT, ESP_GPIO_WAKEUP_GPIO_LOW) != ESP_OK)
    return abortSleep("wake_gpio_error", true);
#if TIMER_WAKE_ENABLED
  if (esp_sleep_enable_timer_wakeup(TIMER_WAKE_INTERVAL_US) != ESP_OK)
    return abortSleep("wake_timer_error", true);
#endif

  const lte::ShutdownResult shutdown = lte::shutdownForSleep();
  if (shutdown == lte::ShutdownResult::Unconfirmed) rtcShutdownUnconfirmed_++;
  observeSleepMotion();
  if (movementDuringSleep_)
    return abortSleep("motion_during_shutdown", true, false, true, shutdown);

  hw_power::railOff();
  // Any motion now restores both GPS and LTE. Do not clear and ignore a stuck
  // LOW interrupt or sleep anyway after a settle timeout.
  observeSleepMotion();
  const int mag = motion::rawMagMg();
  if (movementDuringSleep_ || mag < MOTION_MAG_MIN_MG || mag > MOTION_MAG_MAX_MG)
    return abortSleep("final_motion_or_sensor", true, true, true, shutdown);

  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  if (!hw_power::holdOffForSleep() || gpio_hold_en((gpio_num_t)PIN_BUZZER) != ESP_OK)
    return abortSleep("gpio_hold_error", true, true, true, shutdown);
  gpio_deep_sleep_hold_en();
  lte::setSleepObserver(nullptr);
  bc::set("sleep");
  Serial.printf("[SLEEP] enter reason=%s shutdown=%d\n", reason, (int)shutdown);
  Serial.flush();
  // Keep LIS latch untouched here. An event after this read remains LOW and
  // immediately wakes the CPU, instead of being erased in the entry race.
  if (digitalRead(PIN_LIS_INT) == LOW)
    return abortSleep("final_interrupt", true, true, true, shutdown);
  rtcLastSleepUpS_ = (millis() - bootMs_) / 1000;
  esp_deep_sleep_start();
  return true;
#endif
}

// -----------------------------------------------------------------
void begin(uint32_t bootMs) {
  bootMs_ = bootMs;
  esp_reset_reason_t     rr = esp_reset_reason();
  esp_sleep_wakeup_cause_t wc = esp_sleep_get_wakeup_cause();
  resetCause_ = resetReasonStr(rr);

  if (rr == ESP_RST_POWERON) { rtcBoot_ = 1; rtcWake_ = 0; rtcWakeMotion_ = 0; rtcBrown_ = 0; }
  else { rtcBoot_++; if (rr == ESP_RST_BROWNOUT) rtcBrown_++; }

  bool motionWake = false;
  if (wc == ESP_SLEEP_WAKEUP_GPIO) {
    rtcWake_++;
    uint64_t st = esp_sleep_get_gpio_wakeup_status();
    if (st & (1ULL << PIN_LIS_INT)) { wakeReason_ = "motion"; rtcWakeMotion_++; motionWake = true; }
    else wakeReason_ = "gpio";
  } else if (wc == ESP_SLEEP_WAKEUP_TIMER) {
    wakeReason_ = "timer";
#if !OBSERVE_MODE && !SLEEP_DISABLED
    timerWake_  = true;   // 관찰 모드에선 timer wake 를 normal 로 취급 (heartbeat 즉시 re-sleep 안 함)
#endif
  } else {
    if      (rr == ESP_RST_SW)                                                      wakeReason_ = "sw_reset";
    else if (rr == ESP_RST_BROWNOUT)                                                wakeReason_ = "brownout";
    else if (rr == ESP_RST_TASK_WDT || rr == ESP_RST_INT_WDT || rr == ESP_RST_PANIC) wakeReason_ = "crash";
    else                                                                            wakeReason_ = "boot";
  }
  // (2026-07-06) raw reset_cause 도 출력 — wake=boot 이 POWERON/USB/EXT/OTHER 를 뭉뚱그려
  //   USB CDC 재오픈(로거 재연결) 리셋 vs 진짜 전원끊김/브라운아웃/SW 를 구분 못 함. reset= 로 확정.
  Serial.printf("[SLEEP] wake=%s reset=%s boots=%lu wakes=%lu motion=%lu brown=%lu INT1=%d\n",
    wakeReason_, resetCause_, (unsigned long)rtcBoot_, (unsigned long)rtcWake_,
    (unsigned long)rtcWakeMotion_, (unsigned long)rtcBrown_, digitalRead(PIN_LIS_INT));

  // [2026-08-14 bounce 개편] 구 판정(INT LOW 비율>0.55 = 지속진동 → re-sleep)은 실주행 진동을
  //   가짜 wake 로 오판해 re-sleep → 즉시 모션 wake 재발 → sleep↔wake churn(레일 인러시 반복,
  //   추적 시작 지연) 위험. 신 판정 = "외로운 범프만 re-sleep": 관찰창 동안 ①INT 재어서트 없음
  //   ②raw |Δ| 최대 < 활동임계 둘 다 만족 시에만 re-sleep. 주행/애매하면 정상 기동해 추적.
  if (!SLEEP_DISABLED && motionWake && motion::ok()) {
    motion::clearLatch();
    uint32_t obs = millis();
    bool intReassert = false;
    int  maxD = -1, lastMag = -1;
    while (millis() - obs < WAKE_BOUNCE_OBSERVE_MS) {
      if (digitalRead(PIN_LIS_INT) == LOW) { intReassert = true; motion::clearLatch(); }
      int mag = motion::rawMagMg();
      if (mag >= 0) {
        if (lastMag >= 0) { int d = mag - lastMag; if (d < 0) d = -d; if (d > maxD) maxD = d; }
        lastMag = mag;
      }
      delay(20);
    }
    bool lonely = !intReassert && maxD >= 0 && maxD < MOTION_ACTIVITY_THS_MG;
    Serial.printf("[SLEEP] wake bounce: int_re=%d maxD=%dmg streak=%u → %s\n",
      (int)intReassert, maxD, (unsigned)rtcBounce_, lonely ? "lonely-bump" : "movement");
    if (lonely) {
#if OBSERVE_MODE
      Serial.println(F("[SLEEP] (observe) lonely bump — re-sleep 생략, 관찰 유지"));
#else
      if (rtcBounce_ >= WAKE_BOUNCE_MAX_STREAK) {
        rtcBounce_ = 0;
        Serial.println(F("[SLEEP] bounce streak 상한 — 오판 escape, 정상 기동"));
      } else {
        rtcBounce_++;
        const uint32_t previousMotionWakes = rtcWakeMotion_, previousWakes = rtcWake_;
        if (rtcWakeMotion_ > 0) rtcWakeMotion_--;
        if (rtcWake_ > 0) rtcWake_--;
        if (!enterDeepSleep("bounce_resleep")) {
          // This was a real wake after all. Keep counters and proceed with setup.
          rtcWakeMotion_ = previousMotionWakes;
          rtcWake_ = previousWakes;
          rtcBounce_ = 0;
        }
      }
#endif
    } else {
      rtcBounce_ = 0;   // 실제 이동 wake — streak 리셋
    }
  }
}

// -----------------------------------------------------------------
void checkStationary() {
#if SLEEP_DISABLED
  stayCause_ = "disabled";
  return;
#else
  if (inSleep_ || !motion::ok()) { stayCause_ = motion::ok() ? "sleeping" : "no_lis"; return; }
  uint32_t now = millis();
  if (now - bootMs_ < STATIONARY_BOOT_GRACE_MS) { stayCause_ = "boot_grace"; return; }

  // ── 이동 게이트 — 항상 평가 (LTE 상태와 무관하게 window 를 최신으로 유지) ──
  // (2026-07-08) 이벤트 quiet 대신 "활동량(activity)" 판정 — 단발 노이즈(정지 실내)는 sleep 허용,
  //   지속 진동(주행/터널)만 sleep 금지.
  if (motion::active()) { resetWindow("active", rstActive_); return; }

  // (P2 2026-07-03) GPS 로 "정지" 를 확신하려면 window 내 최소 fix 수(STATIONARY_MIN_FIXES) 필요.
  //   gpsConfident(=avail && n>=min) 일 때만 drift 로 판정. 부족하면 GPS 무근거 → 활동량 still
  //   지속(NO_GPS_SLEEP_GRACE)만으로 판단.
  bool gpsAvail = (gps::lastFixMs() != 0) && (now - gps::lastFixMs() < GPS_STALE_MS);
  float drift = 0; int n = 0;
  if (gpsAvail) n = gps::recentDrift(drift, STATIONARY_WINDOW_MS);
  lastDrift_ = drift; lastFixesN_ = n;
  bool gpsConfident = gpsAvail && (n >= STATIONARY_MIN_FIXES);
  lastGpsAvail_ = gpsConfident;

  if (gpsConfident) {
    if (drift > GPS_DRIFT_THRESHOLD_M) { resetWindow("drift", rstDrift_); return; }   // 이동 확인 → 리셋
  } else {
    if (motion::stillMs() < NO_GPS_SLEEP_GRACE_MS) { resetWindow("nogps_wait", rstNoGps_); return; }
  }

  if (stationarySince_ == 0) {
    stationarySince_ = now;
    stayCause_ = "window";
    Serial.printf("[SLEEP] stationary window 시작 (gps=%s drift=%.1fm fixes=%d)\n",
      gpsConfident ? "confident" : (gpsAvail ? "weak-fix" : "stale"), lastDrift_, lastFixesN_);
  } else if (now - stationarySince_ >= STATIONARY_WINDOW_MS) {
    // (P0 2026-07-02→[2026-08-14 개선]) LTE 미복구면 sleep 진입만 보류 (window 는 유지).
    //   기존엔 이 게이트가 window 자체를 매 tick 리셋 → ①복구 후 5분 추가 대기 ②LTE flap 이 잦은
    //   음영지역에선 window 가 영영 못 차서 sleep 미진입. 이제 cap(RECOVERY_STAY_AWAKE) 만료 즉시 sleep.
    if (!lte::ready()) {
      uint32_t sinceOk = recovery::lastSuccessMs() ? (now - recovery::lastSuccessMs()) : (now - bootMs_);
      if (sinceOk < RECOVERY_STAY_AWAKE_MS) { stayCause_ = "lte_recovery"; return; }
    }
    if (!enterDeepSleep(gpsConfident ? "stationary" : "stationary_lis_only")) {
      // abortSleep already reset the window; retain its specific diagnostic cause.
      rstActive_++;
    }
  } else {
    stayCause_ = "window";
  }
#endif
}

void timerWakeTick() {
  if (!timerWake_) return;
  // [2026-08-14] HB 중 이동 시작 → 정상 세션 승격 (re-sleep 안 함 — 모션 wake 재기동 한 번 절약)
  if (motion::active()) {
    Serial.println(F("[SLEEP] timer-wake 중 이동 감지 — 정상 세션 승격"));
    timerWake_ = false;
    return;
  }
  if (millis() - bootMs_ > TIMER_WAKE_MAX_MS) {
    Serial.println(F("[SLEEP] timer-wake 2분 guard → re-sleep"));
    timerWake_ = false;
    enterDeepSleep("timer_hb_fail");
  }
}

void onPostSuccess() {
  resumeReportPending_ = false; // clear only after the resume/wake POST succeeds
  if (timerWake_) {
    if (motion::active()) {   // [2026-08-14] POST 완료 시점에 이동중이면 승격 (즉시 re-sleep 안 함)
      Serial.println(F("[SLEEP] timer-wake POST ok + 이동중 — 정상 세션 승격"));
      timerWake_ = false;
      return;
    }
    Serial.println(F("[SLEEP] timer-wake heartbeat POST ok → 즉시 re-sleep"));
    timerWake_ = false;
    enterDeepSleep("timer_hb");
  }
}

// -----------------------------------------------------------------
bool timerWakeMode()      { return timerWake_; }
const char* wakeReason()  { return wakeReason_; }
const char* resetCause()  { return resetCause_; }
uint32_t sleepAborts() { return sleepAborts_; }
bool resumeReportPending() { return resumeReportPending_; }
uint32_t shutdownUnconfirmed() { return rtcShutdownUnconfirmed_; }
uint32_t lastSleepUptimeS() { return rtcLastSleepUpS_; }
bool     stationaryActive() { return stationarySince_ != 0; }
uint32_t stationaryHeldMs() { return stationarySince_ ? (millis() - stationarySince_) : 0; }
float    lastDriftM()       { return lastDrift_; }
int      stationaryFixes()     { return lastFixesN_; }
bool     stationaryGpsAvail()  { return lastGpsAvail_; }
const char* stayCause()        { return stayCause_; }
uint16_t resetsActive()        { return rstActive_; }
uint16_t resetsDrift()         { return rstDrift_; }
uint16_t resetsNoGps()         { return rstNoGps_; }
uint32_t bootCount()      { return rtcBoot_; }
uint32_t wakeCount()      { return rtcWake_; }
uint32_t wakeMotion()     { return rtcWakeMotion_; }
uint32_t brownoutCount()  { return rtcBrown_; }

} // namespace sleep_mgr
