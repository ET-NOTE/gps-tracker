#include <cassert>
#include <string>
#include "../main/report_config.cpp"
SerialStub Serial;
int main() {
 using namespace report_config;
 prefs_test::values["gps-auth.counter"]=12345;
 begin();assert(intervalS()==86400&&!persisted());
 for(const char *json:{"{}","{\"ok\":false,\"device_config\":{\"sleep_report_interval_s\":600}}","{\"ok\":true,\"device_config\":{\"sleep_report_interval_s\":\"600\"}}","{\"ok\":true,\"device_config\":{\"sleep_report_interval_s\":true}}","{\"ok\":true,\"device_config\":{\"sleep_report_interval_s\":600}}junk"})assert(!applyAuthenticatedResponse(json));
 for(const char *n:{"0","-1","59","61","600.5","86401","1e20","null"}) {
   const std::string body=std::string("{\"ok\":true,\"device_config\":{\"sleep_report_interval_s\":")+n+"}}";
   assert(!applyAuthenticatedResponse(body.c_str()));
 }
 assert(prefs_test::writes==0&&intervalS()==86400);
 assert(applyAuthenticatedResponse("{\"ok\":true,\"device_config\":{\"sleep_report_interval_s\":600},\"command_id\":\"duplicate-command\"}"));
 assert(intervalS()==600&&persisted()&&prefs_test::writes==1);
 assert(applyAuthenticatedResponse("{\"ok\":true,\"device_config\":{\"sleep_report_interval_s\":600}}"));assert(prefs_test::writes==1);
 seconds_=86400;persisted_=false;begin();assert(intervalS()==600&&persisted());
 prefs_test::failWrite=true;assert(!applyAuthenticatedResponse("{\"ok\":true,\"device_config\":{\"sleep_report_interval_s\":3600}}"));assert(intervalS()==600);
 prefs_test::failWrite=false;prefs_test::failOpen=true;assert(!useDefault());assert(intervalS()==600);
 prefs_test::failOpen=false;assert(useDefault());assert(intervalS()==86400&&persisted());
 assert(applyAuthenticatedResponse("{\"ok\":true,\"device_config\":{\"sleep_report_interval_s\":60}}"));assert(intervalS()==60);
 prefs_test::values["gps-report.seconds"]=86401;begin();assert(intervalS()==86400&&!persisted());
 assert(prefs_test::values["gps-auth.counter"]==12345);
 puts("PASS remote report bounds, NVS persistence, failed save rollback, default and no repeated writes");
}
