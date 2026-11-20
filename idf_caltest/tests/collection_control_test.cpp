#include <cassert>
#include "../main/collection_control.cpp"
SerialStub Serial;
static uint32_t clockMs=100;
static int clears=0;
uint32_t millis() {return clockMs;}
namespace gps {void resetCollection() {clears++;} uint32_t lastFixMs() {return 150;} }
static const char *sim="8988228066614752011";
static std::string policy(bool paused,const char *epoch="11111111-1111-4111-8111-111111111111",const char *s=sim) {
  return std::string("{\"ok\":true,\"collection\":{\"version\":1,\"sim\":\"")+s+"\",\"epoch\":\""+epoch+"\",\"paused\":"+(paused?"true":"false")+"}}";
}
int main() {
  using namespace collection_control;
#if KC_TEST_BUILD
  begin();syncSim(sim);assert(allowed());
  puts("isolated KC profile retains GNSS without a policy server");
  return 0;
#endif
  begin();syncSim(sim);assert(!allowed());
  auto *p=cJSON_Parse((std::string("{\"iccid\":\"")+sim+"\",\"l80\":{\"lat\":37},\"fixes\":[{}],\"stationary\":{\"drift_m\":2},\"diag\":{}} ").c_str());
  prepare(p);assert(!cJSON_GetObjectItem(p,"l80")&&!cJSON_GetObjectItem(p,"fixes")&&!cJSON_GetObjectItem(p,"stationary"));
  assert(cJSON_IsTrue(cJSON_GetObjectItem(cJSON_GetObjectItem(p,"collection"),"control_only")));cJSON_Delete(p);
  applyAuthenticatedResponse(policy(false).c_str());assert(allowed());int saved=prefs_test::writes;
  applyAuthenticatedResponse(policy(false).c_str());assert(allowed()&&prefs_test::writes==saved);
  clockMs=200;applyAuthenticatedResponse(policy(true,"22222222-2222-4222-8222-222222222222").c_str());assert(!allowed());
  begin();syncSim(sim);assert(!allowed()); // NVS never grants collection before a boot handshake.
  prefs_test::failWrite=true;applyAuthenticatedResponse(policy(false,"33333333-3333-4333-8333-333333333333").c_str());assert(!allowed());
  prefs_test::failWrite=false;applyAuthenticatedResponse(policy(false,"33333333-3333-4333-8333-333333333333").c_str());assert(allowed());
  syncSim("8988228066614773490");assert(!allowed());
  applyAuthenticatedResponse(policy(false).c_str());assert(!allowed()); // Other SIM response rejected.
  syncSim(sim);applyAuthenticatedResponse(policy(false).c_str());assert(allowed());
  applyAuthenticatedResponse("{\"ok\":true}");assert(!allowed()); // Old/invalid server fails closed.
  assert(clears>=8);
  puts("collection policy: boot, SIM change, pause, resume, stale response, NVS failure, payload scrub passed");
}
