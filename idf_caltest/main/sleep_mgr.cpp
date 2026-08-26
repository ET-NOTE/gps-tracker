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
static bool     inSleep_         = false;

static uint32_t stationarySince_ = 0;
static float    lastDrift_       = 0;
static int      lastFixesN_      = 0;
static bool     lastGpsAvail_    = false;

// [2026-08-14] "sleep 미진입" 진단 — 현재 블로킹 게이트 + window 리셋 원인별 카운트 (telemetry 로 노출)
static const char *stayCause_    = "boot";
static uint16_t rstActive_ = 0, rstDrift_ = 0, rstNoGps_ = 0;

// window 리셋 헬퍼 — 진행중이던 window 가 죽은 경우만 카운트 (게이트가 0 을 유지하는 tick 은 비카운트)
static void resetWindow(const char *cause, uint16_t &cnt) {
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
  if (inSleep_) return false;
  // [2026-07-14 fix#2] wake 소스(LIS) 없으면 아무것도 teardown 하기 전에 abort.
  //   (기존엔 sleep_enter POST + pulsePwrKey + railOff 뒤에 체크 → LIS 미검출 시 모뎀·레일 죽인 채
  //    sleep 취소하고 정상복귀 → LTE/GPS 먹통으로 영구히 돎. checkStationary 도 !ok() 로 재진입 차단.)
  if (!motion::ok()) {
    Serial.println(F("[SLEEP] LIS 미검출 — wake 소스 없어 sleep 취소 (teardown 전)"));
    return false;
  }
  // [2026-08-14] teardown 前 진동 settle 게이트 — INT 가 300ms 연속 HIGH 로 안정돼야 진입.
  //   기존엔 teardown(모뎀킬+railOff) 후 10s 대기 → 타임아웃이면 INT LOW 인 채 sleep
  //   → GPIO-LOW wake 라 즉시 재기동 = sleep↔wake churn(레일 인러시 반복). 진동 지속 = 아직
  //   움직임이므로 취소가 정답. 취소 시 아무것도 teardown 안 한 상태라 그대로 정상 동작.
  {
    motion::clearLatch();
    uint32_t s = millis(), highSince = 0;
    bool settled = false;
    while (millis() - s < SLEEP_PRE_SETTLE_MAX_MS) {
      lwdt::feed();
      motion::clearLatch();
      delay(20);
      if (digitalRead(PIN_LIS_INT) == HIGH) {
        if (highSince == 0) highSince = millis();
        if (millis() - highSince >= 300) { settled = true; break; }
      } else highSince = 0;
    }
    if (!settled) {
      Serial.printf("[SLEEP] 진동 지속 (INT 미안정 %lums) — sleep 취소 (reason=%s)\n",
        (unsigned long)SLEEP_PRE_SETTLE_MAX_MS, reason);
      return false;
    }
  }
  inSleep_ = true;
  bc::set("sleep");
  buzzer::beep(2, 150, 120); buzzer::flush();        // (2026-07-03) sleep 진입 청각 신호 2회 (wake 6회와 구분)
  rtcLastSleepUpS_ = (millis() - bootMs_) / 1000;   // 다음 세션 diag 용 (RTC 보존)
  Serial.printf("[SLEEP] deep sleep 진입 (reason=%s uptime=%lus)\n",
    reason, (unsigned long)((millis() - bootMs_) / 1000));

  // 서버 sleep_enter 이벤트 — LTE 살아있을 때, 전원 차단 전에 전송.
  if (lte::ready()) {
    // [2026-08-14] 미전송 batch flush — deep sleep = 재부팅이라 batch(최대 120 fix)가 소실됨.
    //   LTE stuck 후 RECOVERY_STAY_AWAKE 초과로 sleep 하는 경로에선 마지막 주행 꼬리가 통째로
    //   날아가던 것. ready 일 때 1회만 시도, 실패는 감수(다음 세션은 어차피 새 batch).
    if (gps::batchCount() > 0) {
      static char fbody[8192];
      uint8_t posted = telemetry::buildPayload(fbody, sizeof(fbody), bootMs_, false);
      int fst = -1;
      lte::httpPost(fbody, &fst);
      if (fst == 200 && posted > 0) gps::batchDrop(posted);
      Serial.printf("[SLEEP] batch flush: %u fix, status=%d\n", posted, fst);
    }
    static char sbody[640];
    telemetry::buildSleepPayload(sbody, sizeof(sbody), bootMs_, reason);
    int st = -1;
    lte::httpPost(sbody, &st);
    Serial.printf("[SLEEP] sleep_enter POST status=%d\n", st);
  } else {
    Serial.println(F("[SLEEP] LTE not ready — sleep_enter event 생략"));
  }

  // ★[2026-07-13] 절전 진입 모뎀 킬 펄스 — PWR_EN 차단만으론 SIM7080 VBAT 벌크캡 잔류로 완전 off 안 됨.
  //   레일 차단 전(모뎀 살아있을 때) PWRKEY 펄스로 능동 파워다운 → 그 뒤 railOff 로 레일 차단.
  hw_power::pulsePwrKey();   // 켜진 SIM7080 PWRKEY 토글 = power-down 신호
  hw_power::railOff();   // GPS+LTE 전원 차단 (LIS 는 항시전원 → wake 소스 유지)
  // (wake 소스 체크는 함수 최상단으로 이동 — fix#2)

  // LIS latch clear + INT idle(HIGH) 안정 대기 → 자가-wake 방지 (max 10s)
  motion::clearLatch();
  uint32_t s = millis(), highSince = 0;
  while (millis() - s < 10000) {
    lwdt::feed();   // LIS settle 대기는 hang 아님
    motion::clearLatch();
    delay(20);
    if (digitalRead(PIN_LIS_INT) == HIGH) {
      if (highSince == 0) highSince = millis();
      if (millis() - highSince >= 300) break;
    } else highSince = 0;
  }
  Serial.printf("[SLEEP] LIS settled in %lums\n", (unsigned long)(millis() - s));

  // 능동 부저: deep sleep 중 GPIO1 floating→HIGH 로 울리는 것 방지 — LOW 로 래치.
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  gpio_hold_en((gpio_num_t)PIN_BUZZER);
  gpio_deep_sleep_hold_en();

  esp_deep_sleep_enable_gpio_wakeup(1ULL << PIN_LIS_INT, ESP_GPIO_WAKEUP_GPIO_LOW);
#if TIMER_WAKE_ENABLED
  esp_sleep_enable_timer_wakeup(TIMER_WAKE_INTERVAL_US);   // 0이면 모션 wake only (timer HB 없음)
#endif
  Serial.flush();
  esp_deep_sleep_start();
  return true;   // unreachable — deep sleep 은 리부팅으로만 복귀
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
#if !OBSERVE_MODE
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
  if (motionWake && motion::ok()) {
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
        if (rtcWakeMotion_ > 0) rtcWakeMotion_--;
        if (rtcWake_ > 0) rtcWake_--;
        enterDeepSleep("bounce_resleep");
        // ↑ 취소(진동 재감지)로 돌아오면 그대로 정상 기동 (teardown 전이라 무해)
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
      // 진입 취소(pre-settle 진동 감지) = 아직 움직임 → window 리셋하고 재관찰
      resetWindow("settle_abort", rstActive_);
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
