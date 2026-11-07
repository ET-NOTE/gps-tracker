#include "collection_control.h"
#include "config.h"
#include "gps.h"
#include <Preferences.h>
#include <cJSON.h>
#include <cstring>
namespace collection_control {
static String sim_, epoch_;
static bool confirmed_=false, paused_=true;
static uint32_t since_=0;
static void close() { confirmed_=false; paused_=true; epoch_=""; gps::resetCollection(); }
void begin() { sim_="";close(); }
void syncSim(const char *sim) {
  if (sim_!=sim) {sim_=sim;close();}
}
bool allowed() {
#if KC_TEST_BUILD
  // The isolated, unauthenticated RF certification profile has no policy server.
  // This exception is not compiled into any operational or HTTPS profile.
  return true;
#else
  return confirmed_&&!paused_;
#endif
}
void applyAuthenticatedResponse(const char *body) {
  cJSON *root=cJSON_ParseWithOpts(body,nullptr,true);
  const cJSON *c=cJSON_GetObjectItemCaseSensitive(root,"collection");
  const cJSON *sim=cJSON_GetObjectItemCaseSensitive(c,"sim");
  const cJSON *epoch=cJSON_GetObjectItemCaseSensitive(c,"epoch");
  const cJSON *paused=cJSON_GetObjectItemCaseSensitive(c,"paused");
  const cJSON *version=cJSON_GetObjectItemCaseSensitive(c,"version");
  bool valid=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root,"ok"))&&cJSON_IsNumber(version)&&version->valuedouble==1
    &&cJSON_IsString(sim)&&sim_==sim->valuestring&&sim_.length()>=19
    &&cJSON_IsString(epoch)&&strlen(epoch->valuestring)==36&&cJSON_IsBool(paused);
  if(valid) for(size_t i=0;i<36;i++) valid=valid&&((i==8||i==13||i==18||i==23)?epoch->valuestring[i]=='-':isxdigit(static_cast<unsigned char>(epoch->valuestring[i])));
  if(!valid) {close();cJSON_Delete(root);return;}
  bool stopped=cJSON_IsTrue(paused);
  if(!confirmed_||epoch_!=epoch->valuestring||paused_!=stopped) {
    // Drop all pre-transition fixes, parser state and UART backlog before an ACK.
    close();
    char *record=cJSON_PrintUnformatted(c);
    Preferences p;
    bool saved=record&&p.begin("gps-collect",false);
    if(saved) {
      String previous=p.getString("policy","");
      saved=previous==record||(p.putString("policy",record)==strlen(record)&&p.getString("policy","")==record);
      p.end();
    }
    if(saved) {epoch_=epoch->valuestring;paused_=stopped;since_=millis();confirmed_=true;}
    Serial.printf("[COLLECTION] policy %s paused=%d; old fixes cleared\n",saved?"saved":"save-failed",int(paused_));
    cJSON_free(record);
  }
  cJSON_Delete(root);
}
void prepare(cJSON *payload) {
  const cJSON *sim=cJSON_GetObjectItemCaseSensitive(payload,"iccid");
  syncSim(cJSON_IsString(sim)?sim->valuestring:"");
  if(!allowed()) {
    cJSON *item=payload->child;
    while(item) {
      cJSON *next=item->next;
      const char *k=item->string;
      if(strcmp(k,"iccid")&&strcmp(k,"imei")&&strcmp(k,"imsi")&&strcmp(k,"device_uid")&&strcmp(k,"build_tag"))
        cJSON_DeleteItemFromObjectCaseSensitive(payload,k);
      item=next;
    }
  }
  cJSON_DeleteItemFromObjectCaseSensitive(payload,"collection");
  cJSON *c=cJSON_AddObjectToObject(payload,"collection");
  cJSON_AddNumberToObject(c,"version",1);
  cJSON_AddBoolToObject(c,"paused",paused_);
  cJSON_AddBoolToObject(c,"control_only",!allowed());
  if(confirmed_) cJSON_AddStringToObject(c,"epoch",epoch_.c_str());
  cJSON_AddNumberToObject(c,"since_ms",since_);
  cJSON_AddNumberToObject(c,"uptime_ms",millis());
  cJSON_AddNumberToObject(c,"fix_up_ms",gps::lastFixMs());
}
}
