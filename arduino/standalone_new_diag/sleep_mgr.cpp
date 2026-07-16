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

static uint32_t bootMs_          = 0;
static const char *wakeReason_   = "boot";
static const char *resetCause_   = "?";
static bool     timerWake_       = false;
static bool     inSleep_         = false;

static uint32_t stationarySince_ = 0;
static float    lastDrift_       = 0;
static int      lastFixesN_      = 0;
static bool     lastGpsAvail_    = false;

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
void enterDeepSleep(const char *reason) {
  if (inSleep_) return;
  inSleep_ = true;
  bc::set("sleep");
  buzzer::beep(2, 150, 120); buzzer::flush();        // (2026-07-03) sleep 진입 청각 신호 2회 (wake 6회와 구분)
  rtcLastSleepUpS_ = (millis() - bootMs_) / 1000;   // 다음 세션 diag 용 (RTC 보존)
  Serial.printf("[SLEEP] deep sleep 진입 (reason=%s uptime=%lus)\n",
    reason, (unsigned long)((millis() - bootMs_) / 1000));

  // 서버 sleep_enter 이벤트 — LTE 살아있을 때, 전원 차단 전에 전송.
  if (lte::ready()) {
    static char sbody[640];
    telemetry::buildSleepPayload(sbody, sizeof(sbody), bootMs_, reason);
    int st = -1;
    lte::httpPost(sbody, &st);
    Serial.printf("[SLEEP] sleep_enter POST status=%d\n", st);
  } else {
    Serial.println(F("[SLEEP] LTE not ready — sleep_enter event 생략"));
  }

  hw_power::railOff();   // GPS+LTE 전원 차단 (LIS 는 항시전원 → wake 소스 유지)

  if (!motion::ok()) {   // wake 소스 없음 → sleep 하면 못 깸. 방어적 abort.
    Serial.println(F("[SLEEP] LIS 미검출 — wake 소스 없어 sleep 취소"));
    inSleep_ = false;
    return;
  }

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
  esp_sleep_enable_timer_wakeup(TIMER_WAKE_INTERVAL_US);
  Serial.flush();
  esp_deep_sleep_start();
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

  // 모션 wake bounce 필터 — 지속 진동이면 즉시 re-sleep (false wake 배터리 소모 방지)
  if (motionWake && motion::ok()) {
    uint32_t obs = millis(), low = 0, tot = 0;
    while (millis() - obs < WAKE_BOUNCE_OBSERVE_MS) {
      if (digitalRead(PIN_LIS_INT) == LOW) low++;
      tot++;
      delay(20);
      if (tot % 5 == 0) motion::clearLatch();
    }
    float ratio = tot ? (float)low / tot : 0;
    Serial.printf("[SLEEP] wake bounce ratio=%.2f\n", ratio);
    if (ratio > WAKE_BOUNCE_LOW_RATIO) {
#if OBSERVE_MODE
      Serial.println(F("[SLEEP] (observe) 지속 진동 감지 — re-sleep 생략, 관찰 유지"));
#else
      Serial.println(F("[SLEEP] 지속 진동 → re-sleep (가짜 wake)"));
      if (rtcWakeMotion_ > 0) rtcWakeMotion_--;
      if (rtcWake_ > 0) rtcWake_--;
      enterDeepSleep("bounce_resleep");
#endif
    }
  }
}

// -----------------------------------------------------------------
void checkStationary() {
#if SLEEP_DISABLED
  return;
#else
  if (inSleep_ || !motion::ok()) return;   // wake 소스 없으면 sleep 안 함
  uint32_t now = millis();
  if (now - bootMs_ < STATIONARY_BOOT_GRACE_MS) return;

  // (P0 2026-07-02) LTE 미등록/recovery 중엔 sleep 보류 — 깨어서 bringup 재시도+에스컬레이션 지속.
  //   마지막 성공 POST 이후(없으면 부팅 이후) 경과가 상한 미만이면 계속 깨어있기.
  //   상한 초과 시엔 배터리 보호 위해 sleep 허용 (다음 wake 는 RTC 카운터로 에스컬레이션 이어감).
  if (!lte::ready()) {
    uint32_t sinceOk = recovery::lastSuccessMs() ? (now - recovery::lastSuccessMs()) : (now - bootMs_);
    if (sinceOk < RECOVERY_STAY_AWAKE_MS) { stationarySince_ = 0; return; }
  }

  // (2026-07-08) 이벤트 quiet 대신 "활동량(activity)" 판정 — 단발 노이즈(정지 실내)는 sleep 허용,
  //   지속 진동(주행/터널)만 sleep 금지. 실내 vs 터널을 활동량(지속 진동)으로 명확 분리.
  if (motion::active()) { stationarySince_ = 0; return; }   // 지속 활동=움직임(주행/터널) → sleep 금지

  // (P2 2026-07-03) GPS 로 "정지" 를 확신하려면 window 내 최소 fix 수(STATIONARY_MIN_FIXES) 필요.
  //   [버그] fix 0~2 개면 recentDrift n<3 → 이동체크(n>=3 && drift>th)가 거짓 → 이동해도 정지 오판.
  //   [수정] gpsConfident(=avail && n>=min) 일 때만 drift 로 판정. 부족하면 GPS 무근거 → 모션 quiet
  //          지속(NO_GPS_SLEEP_GRACE)만으로 판단. 모션 카운터 수정(HPM=00) 후 주행이면 위 quiet 서 이미 리셋.
  bool gpsAvail = (gps::lastFixMs() != 0) && (now - gps::lastFixMs() < GPS_STALE_MS);
  float drift = 0; int n = 0;
  if (gpsAvail) n = gps::recentDrift(drift, STATIONARY_WINDOW_MS);
  lastDrift_ = drift; lastFixesN_ = n;
  bool gpsConfident = gpsAvail && (n >= STATIONARY_MIN_FIXES);
  lastGpsAvail_ = gpsConfident;

  if (gpsConfident) {
    if (drift > GPS_DRIFT_THRESHOLD_M) { stationarySince_ = 0; return; }   // 이동 확인 → 리셋
  } else {
    // GPS 근거 부족(fix<min 또는 stale) → 활동량이 NO_GPS_SLEEP_GRACE 동안 임계아래(still)로 유지돼야 sleep.
    //   (2026-07-08) 단발 노이즈로 리셋되던 문제 해결: still 은 활동량(지속) 기반이라 노이즈 스파이크에 안 흔들림.
    if (motion::stillMs() < NO_GPS_SLEEP_GRACE_MS) { stationarySince_ = 0; return; }
  }

  if (stationarySince_ == 0) {
    stationarySince_ = now;
    Serial.printf("[SLEEP] stationary window 시작 (gps=%s drift=%.1fm fixes=%d)\n",
      gpsConfident ? "confident" : (gpsAvail ? "weak-fix" : "stale"), lastDrift_, lastFixesN_);
  } else if (now - stationarySince_ >= STATIONARY_WINDOW_MS) {
    enterDeepSleep(gpsConfident ? "stationary" : "stationary_lis_only");
  }
#endif
}

void timerWakeTick() {
  if (!timerWake_) return;
  if (millis() - bootMs_ > TIMER_WAKE_MAX_MS) {
    Serial.println(F("[SLEEP] timer-wake 2분 guard → re-sleep"));
    timerWake_ = false;
    enterDeepSleep("timer_hb_fail");
  }
}

void onPostSuccess() {
  if (timerWake_) {
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
uint32_t bootCount()      { return rtcBoot_; }
uint32_t wakeCount()      { return rtcWake_; }
uint32_t wakeMotion()     { return rtcWakeMotion_; }
uint32_t brownoutCount()  { return rtcBrown_; }

} // namespace sleep_mgr
