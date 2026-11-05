#include "report_config.h"
#include "config.h"
#include <Preferences.h>
#include <cJSON.h>
#include <cmath>
namespace report_config {
static uint32_t seconds_ = TIMER_WAKE_INTERVAL_S;
static bool persisted_ = false;
static bool valid(uint32_t s) { return s >= 60 && s <= 86400 && s % 60 == 0; }
void begin() {
  seconds_ = TIMER_WAKE_INTERVAL_S; persisted_ = false;
  Preferences p;
  if (p.begin("gps-report", true)) {
    const uint32_t stored = p.getUInt("seconds", 0); p.end();
    if (valid(stored)) { seconds_ = stored; persisted_ = true; }
  }
  Serial.printf("[CONFIG] sleep report interval=%lus persisted=%d\n", (unsigned long)seconds_, (int)persisted_);
#if GPS_HTTPS_SLEEP_TEST
  Serial.println("[SLEEP-TEST] effective timer=60s; stored/server interval remains unchanged");
#endif
}
uint32_t intervalS() { return GPS_HTTPS_SLEEP_TEST ? TIMER_WAKE_INTERVAL_S : seconds_; }
bool persisted() { return !GPS_HTTPS_SLEEP_TEST && persisted_; }
static bool save(uint32_t seconds) {
  if (GPS_HTTPS_SLEEP_TEST) return false; // Never persist a bench override or alter server settings.
  if (!valid(seconds)) return false;
  if (seconds_ == seconds && persisted_) return true; // No flash wear on every POST.
  Preferences p;
  if (!p.begin("gps-report", false)) return false;
  const bool ok = p.putUInt("seconds", seconds) == sizeof(uint32_t) && p.getUInt("seconds", 0) == seconds;
  p.end();
  if (!ok) { Serial.println("[CONFIG] Save failed; retaining previous report interval."); return false; }
  seconds_ = seconds; persisted_ = true;
  Serial.printf("[CONFIG] Saved sleep report interval=%lus; used at next sleep.\n", (unsigned long)seconds_);
  return true;
}
bool useDefault() { return save(TIMER_WAKE_INTERVAL_S); }
bool applyAuthenticatedResponse(const char *body) {
  cJSON *root = cJSON_ParseWithOpts(body, nullptr, true);
  if (!root) return false;
  const cJSON *cfg = cJSON_GetObjectItemCaseSensitive(root, "device_config");
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(cfg, "sleep_report_interval_s");
  bool ok = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "ok")) && cJSON_IsNumber(value);
  if (ok) {
    const double d = value->valuedouble;
    ok = std::isfinite(d) && d >= 60 && d <= 86400 && std::floor(d) == d;
    if (ok) ok = save(static_cast<uint32_t>(d));
  }
  cJSON_Delete(root);
  return ok;
}
}
