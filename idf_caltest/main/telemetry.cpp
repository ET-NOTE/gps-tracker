#include "telemetry.h"
#include "config.h"
#include "gps.h"
#include "motion.h"
#include "lte.h"
#include "sleep_mgr.h"
#include "recovery.h"
#include "breadcrumb.h"
#include <WiFi.h>
#include <stdarg.h>

namespace telemetry {

static char uid_[32] = "";

// [2026-08-14] snprintf 누적 헬퍼 — truncation 시 p 가 cap 을 넘으면 이후 (cap - p) 가 음수→huge size_t
//   로 버퍼 밖을 치는 고전 UB 차단. 현재 payload 크기상 실제 발생은 없지만 하드닝.
static int appendf(char *out, size_t cap, int p, const char *fmt, ...) {
  if (p < 0 || (size_t)p >= cap) return (int)cap - 1;
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(out + p, cap - p, fmt, ap);
  va_end(ap);
  if (n < 0) return p;
  p += n;
  if ((size_t)p >= cap) p = (int)cap - 1;   // truncated — clamp
  return p;
}

// 세션 누적 (부팅 시 0 — static). delta/cyc 카운터.
static uint32_t lastPostEvents_ = 0;
static uint32_t cyc_fix_        = 0;
static uint32_t cyc_no_fix_     = 0;

static uint16_t readVbatMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(PIN_BAT);
  return (uint16_t)((sum / 16) * BAT_DIV_RATIO);
}

const char* deviceUid() {
  if (uid_[0]) return uid_;
  const char *ic = lte::iccid();
  size_t n = strlen(ic);
  if (n >= 8) { snprintf(uid_, sizeof(uid_), "sim-%s", ic + (n - 8)); return uid_; }
  // [2026-08-14] MAC 폴백은 캐시하지 않음 — 첫 POST 시점에 ICCID 파싱이 늦으면 esp- identity 로
  //   세션 내내 굳어져 같은 단말이 서버에 두 device 로 갈라지던 것 방지. ICCID 확보 즉시 sim- 로 수렴.
  static char tmp[32];
  uint8_t mac[6]; WiFi.macAddress(mac);
  snprintf(tmp, sizeof(tmp), "esp-%02x%02x%02x%02x%02x%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return tmp;
}

uint8_t buildPayload(char *out, size_t cap, uint32_t bootMs, bool diagPending) {
  uint32_t now  = millis();
  uint16_t vbat = readVbatMv();
  gps::Fix f;
  bool haveFix = gps::getFix(f);

  // per-cycle fix 카운트 (원본 countFixForCycle)
  if (haveFix) cyc_fix_++;
  else if (lte::csq() > 0) cyc_no_fix_++;

  uint32_t motTotal = motion::events();
  uint32_t motDelta = motTotal - lastPostEvents_;
  lastPostEvents_ = motTotal;
  uint32_t motAge  = motion::lastMs() ? (now - motion::lastMs()) / 1000 : 0;
  uint32_t ttff_s  = gps::firstFixMs() ? (gps::firstFixMs() - bootMs) / 1000 : 0;

  char sim[96];
  if (lte::iccid()[0] || lte::imei()[0])
    snprintf(sim, sizeof(sim), ",\"iccid\":\"%s\",\"imei\":\"%s\",\"imsi\":\"%s\"",
             lte::iccid(), lte::imei(), lte::imsi());
  else sim[0] = 0;

  int p = 0;
  p = appendf(out, cap, p,
    "{\"device_uid\":\"%s\"%s,\"ts\":%lu,\"awake\":%u,\"csq\":%d,\"reg\":%d,\"vbat_mv\":%u,\"cbc_mv\":%d,\"at_ms\":%lu,",
    deviceUid(), sim, (unsigned long)((now - bootMs) / 1000),
    (unsigned)lte::bringUpCount(), lte::csq(), lte::reg(), (unsigned)vbat,
    lte::modemVbatMv(), (unsigned long)lte::firstAtOkMs());

  // l80
  if (haveFix) {
    char headingFrag[24];
    if (f.hasCourse) snprintf(headingFrag, sizeof(headingFrag), ",\"heading\":%.1f", f.course);
    else             headingFrag[0] = 0;
    p = appendf(out, cap, p,
      "\"l80\":{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat\":%d,\"hdop\":%.2f,\"ttff_s\":%lu%s},",
      f.lat, f.lng, f.sat, f.hdop, (unsigned long)ttff_s, headingFrag);
  } else {
    p = appendf(out, cap, p,
      "\"l80\":{\"fix\":false,\"sat\":%d,\"hdop\":%.2f},", gps::satellites(), gps::hdop());
  }

  // motion
  p = appendf(out, cap, p,
    "\"motion\":{\"total\":%lu,\"delta\":%lu,\"age_s\":%lu},",
    (unsigned long)motTotal, (unsigned long)motDelta, (unsigned long)motAge);

  // stationary
  {
    bool     active   = sleep_mgr::stationaryActive();
    uint32_t held_s   = sleep_mgr::stationaryHeldMs() / 1000;
    uint32_t window_s = STATIONARY_WINDOW_MS / 1000;
    uint32_t sleep_in = (held_s >= window_s) ? 0 : (window_s - held_s);
    // [2026-08-14] sleep 미진입 원격진단 필드 추가 — stay(현재 블로킹 게이트)/act_mg(활동량 EMA)/
    //   rst_*(window 리셋 원인별 누적). 서버 데이터만으로 "왜 안 자는지" 특정 가능.
    p = appendf(out, cap, p,
      "\"stationary\":{\"active\":%s,\"held_s\":%lu,\"window_s\":%lu,\"sleep_in_s\":%lu,"
      "\"drift_m\":%.1f,\"threshold_m\":%.1f,\"fixes\":%d,\"gps_avail\":%s,\"motion_age_s\":%lu,"
      "\"lis_ok\":%s,\"lis_reinits\":%lu,"
      "\"stay\":\"%s\",\"act_mg\":%lu,\"rst_act\":%u,\"rst_drift\":%u,\"rst_nogps\":%u},",
      active ? "true" : "false",
      (unsigned long)held_s, (unsigned long)window_s, (unsigned long)sleep_in,
      sleep_mgr::lastDriftM(), (double)GPS_DRIFT_THRESHOLD_M,
      sleep_mgr::stationaryFixes(), sleep_mgr::stationaryGpsAvail() ? "true" : "false",
      (unsigned long)motAge, motion::ok() ? "true" : "false",
      (unsigned long)motion::reinits(),
      sleep_mgr::stayCause(), (unsigned long)motion::activityMg(),
      (unsigned)sleep_mgr::resetsActive(), (unsigned)sleep_mgr::resetsDrift(),
      (unsigned)sleep_mgr::resetsNoGps());
  }

  // 식별/원인 (last_op = crash/stuck 위치 breadcrumb)
  p = appendf(out, cap, p,
    "\"wake\":\"%s\",\"reset_cause\":\"%s\",\"last_op\":\"%s\",\"antenna\":\"%s\"",
    sleep_mgr::wakeReason(), sleep_mgr::resetCause(), bc::last(), gps::antennaStatus());

  // diag (wake 후 첫 POST 만)
  if (diagPending) {
    p = appendf(out, cap, p,
      ",\"event\":\"wake\",\"diag\":{\"boots\":%lu,\"wakes\":%lu,\"motion_wakes\":%lu,\"brownouts\":%lu,"
      "\"post_ok\":%lu,\"post_fail\":%lu,\"cyc_fix\":%lu,\"cyc_no_fix\":%lu,\"last_sleep_uptime_s\":%lu}",
      (unsigned long)sleep_mgr::bootCount(), (unsigned long)sleep_mgr::wakeCount(),
      (unsigned long)sleep_mgr::wakeMotion(), (unsigned long)sleep_mgr::brownoutCount(),
      (unsigned long)recovery::postOks(), (unsigned long)recovery::postFails(),
      (unsigned long)cyc_fix_, (unsigned long)cyc_no_fix_,
      (unsigned long)sleep_mgr::lastSleepUptimeS());
  }

  // batch fixes
  uint8_t avail = gps::batchCount();
  uint8_t written = 0;
  if (avail > 0) {
    p = appendf(out, cap, p, ",\"fixes\":[");
    // SHCONF BODYLEN 4096 안전 여유(3800). 초과 fix 는 batch 에 남아 다음 cycle 에 전송.
    for (uint8_t i = 0; i < avail && p < 3800; i++) {
      float lat, lng; int sat; uint32_t atMs;
      if (!gps::batchGet(i, lat, lng, sat, atMs)) break;
      p = appendf(out, cap, p, "%s{\"lat\":%.6f,\"lng\":%.6f,\"sat\":%d,\"age_ms\":%lu}",
        (written == 0 ? "" : ","), (double)lat, (double)lng, sat, (unsigned long)(now - atMs));
      written++;
    }
    p = appendf(out, cap, p, "]");
  }
  appendf(out, cap, p, "}");
  return written;
}

void buildSleepPayload(char *out, size_t cap, uint32_t bootMs, const char *reason) {
  uint16_t vbat = readVbatMv();
  uint32_t now  = millis();
  uint32_t motAge = motion::lastMs() ? (now - motion::lastMs()) / 1000 : 0;

  char sim[96];
  if (lte::iccid()[0] || lte::imei()[0])
    snprintf(sim, sizeof(sim), ",\"iccid\":\"%s\",\"imei\":\"%s\",\"imsi\":\"%s\"",
             lte::iccid(), lte::imei(), lte::imsi());
  else sim[0] = 0;

  snprintf(out, cap,
    "{\"device_uid\":\"%s\"%s,\"ts\":%lu,\"csq\":%d,\"reg\":%d,\"vbat_mv\":%u,"
    "\"event\":\"sleep_enter\",\"sleep_reason\":\"%s\",\"stopped_offset_s\":%lu,"
    "\"reset_cause\":\"%s\",\"last_op\":\"%s\",\"antenna\":\"%s\","
    "\"diag\":{\"boots\":%lu,\"wakes\":%lu,\"motion_wakes\":%lu,\"brownouts\":%lu,"
    "\"post_ok\":%lu,\"post_fail\":%lu}}",
    deviceUid(), sim, (unsigned long)((now - bootMs) / 1000),
    lte::csq(), lte::reg(), (unsigned)vbat,
    reason, (unsigned long)motAge,
    sleep_mgr::resetCause(), bc::last(), gps::antennaStatus(),
    (unsigned long)sleep_mgr::bootCount(), (unsigned long)sleep_mgr::wakeCount(),
    (unsigned long)sleep_mgr::wakeMotion(), (unsigned long)sleep_mgr::brownoutCount(),
    (unsigned long)recovery::postOks(), (unsigned long)recovery::postFails());
}

} // namespace telemetry
