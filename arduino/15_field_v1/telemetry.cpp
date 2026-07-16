#include "telemetry.h"
#include "config.h"
#include "gps.h"
#include "motion.h"
#include "lte.h"
#include "sleep_mgr.h"
#include "recovery.h"
#include "breadcrumb.h"
#include <WiFi.h>

namespace telemetry {

static char uid_[32] = "";

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
  uint8_t mac[6]; WiFi.macAddress(mac);
  snprintf(uid_, sizeof(uid_), "esp-%02x%02x%02x%02x%02x%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return uid_;
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
  p += snprintf(out + p, cap - p,
    "{\"device_uid\":\"%s\"%s,\"ts\":%lu,\"awake\":%u,\"csq\":%d,\"reg\":%d,\"vbat_mv\":%u,\"at_ms\":%lu,",
    deviceUid(), sim, (unsigned long)((now - bootMs) / 1000),
    (unsigned)lte::bringUpCount(), lte::csq(), lte::reg(), (unsigned)vbat,
    (unsigned long)lte::firstAtOkMs());

  // l80
  if (haveFix) {
    char headingFrag[24];
    if (f.hasCourse) snprintf(headingFrag, sizeof(headingFrag), ",\"heading\":%.1f", f.course);
    else             headingFrag[0] = 0;
    p += snprintf(out + p, cap - p,
      "\"l80\":{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat\":%d,\"hdop\":%.2f,\"ttff_s\":%lu%s},",
      f.lat, f.lng, f.sat, f.hdop, (unsigned long)ttff_s, headingFrag);
  } else {
    p += snprintf(out + p, cap - p,
      "\"l80\":{\"fix\":false,\"sat\":%d,\"hdop\":%.2f},", gps::satellites(), gps::hdop());
  }

  // motion
  p += snprintf(out + p, cap - p,
    "\"motion\":{\"total\":%lu,\"delta\":%lu,\"age_s\":%lu},",
    (unsigned long)motTotal, (unsigned long)motDelta, (unsigned long)motAge);

  // stationary
  {
    bool     active   = sleep_mgr::stationaryActive();
    uint32_t held_s   = sleep_mgr::stationaryHeldMs() / 1000;
    uint32_t window_s = STATIONARY_WINDOW_MS / 1000;
    uint32_t sleep_in = (held_s >= window_s) ? 0 : (window_s - held_s);
    p += snprintf(out + p, cap - p,
      "\"stationary\":{\"active\":%s,\"held_s\":%lu,\"window_s\":%lu,\"sleep_in_s\":%lu,"
      "\"drift_m\":%.1f,\"threshold_m\":%.1f,\"fixes\":%d,\"gps_avail\":%s,\"motion_age_s\":%lu,"
      "\"lis_ok\":%s,\"lis_reinits\":%lu},",
      active ? "true" : "false",
      (unsigned long)held_s, (unsigned long)window_s, (unsigned long)sleep_in,
      sleep_mgr::lastDriftM(), (double)GPS_DRIFT_THRESHOLD_M,
      sleep_mgr::stationaryFixes(), sleep_mgr::stationaryGpsAvail() ? "true" : "false",
      (unsigned long)motAge, motion::ok() ? "true" : "false",
      (unsigned long)motion::reinits());
  }

  // 식별/원인 (last_op = crash/stuck 위치 breadcrumb)
  p += snprintf(out + p, cap - p,
    "\"wake\":\"%s\",\"reset_cause\":\"%s\",\"last_op\":\"%s\",\"antenna\":\"%s\"",
    sleep_mgr::wakeReason(), sleep_mgr::resetCause(), bc::last(), gps::antennaStatus());

  // diag (wake 후 첫 POST 만)
  if (diagPending) {
    p += snprintf(out + p, cap - p,
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
    p += snprintf(out + p, cap - p, ",\"fixes\":[");
    // SHCONF BODYLEN 4096 안전 여유(3800). 초과 fix 는 batch 에 남아 다음 cycle 에 전송.
    for (uint8_t i = 0; i < avail && p < 3800; i++) {
      float lat, lng; int sat; uint32_t atMs;
      if (!gps::batchGet(i, lat, lng, sat, atMs)) break;
      p += snprintf(out + p, cap - p, "%s{\"lat\":%.6f,\"lng\":%.6f,\"sat\":%d,\"age_ms\":%lu}",
        (written == 0 ? "" : ","), (double)lat, (double)lng, sat, (unsigned long)(now - atMs));
      written++;
    }
    p += snprintf(out + p, cap - p, "]");
  }
  snprintf(out + p, cap - p, "}");
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
