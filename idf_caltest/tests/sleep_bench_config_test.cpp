#include <cassert>
#include "../main/report_config.cpp"
SerialStub Serial;
int main() {
  prefs_test::values["gps-report.seconds"] = 86400;
  prefs_test::values["gps-auth.counter"] = 12345;
  report_config::begin();
  assert(report_config::intervalS()==60 && !report_config::persisted());
  assert(!report_config::applyAuthenticatedResponse("{\"ok\":true,\"device_config\":{\"sleep_report_interval_s\":600}}"));
  assert(!report_config::useDefault());
  assert(prefs_test::writes==0 && prefs_test::values["gps-report.seconds"]==86400);
  assert(prefs_test::values["gps-auth.counter"]==12345);
  report_config::begin();
  assert(report_config::intervalS()==60);
  puts("PASS bench override survives restart without changing stored settings");
}
