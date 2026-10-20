#include "device_security.h"
#include "config.h"
#include <Preferences.h>
#include <esp_system.h>
#include <mbedtls/md.h>
#include <mbedtls/base64.h>
#include <cJSON.h>
#include <inttypes.h>

namespace device_security {
static char identity[65] = "";
static unsigned char key[32];
static char pairingHash[65] = "";
static String ack, input;
static String lastSim;
static bool ready = false;
static uint64_t nextCounter = 0, reservedEnd = 0;
static constexpr uint64_t BLOCK = 4096, MAX_COUNTER = 9007199254740991ULL;

static void hex(const unsigned char *bytes, size_t n, char *out) {
  static const char digits[]="0123456789abcdef";
  for(size_t i=0;i<n;i++){out[i*2]=digits[bytes[i]>>4];out[i*2+1]=digits[bytes[i]&15];}out[n*2]=0;
}
static bool sha(const void *data, size_t n, unsigned char out[32]) {
  return mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
    static_cast<const unsigned char *>(data),n,out)==0;
}
static bool mac(const String &data, char out[65]) {
  unsigned char bytes[32];
  if(mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),key,sizeof(key),
      reinterpret_cast<const unsigned char *>(data.c_str()),data.length(),bytes)!=0)return false;
  hex(bytes,sizeof(bytes),out);return true;
}
static bool reserve() {
  Preferences p;if(!p.begin("gps-auth",false))return false;
  uint64_t previous=p.getULong64("counter",0);
  bool ok=previous<=MAX_COUNTER-BLOCK && p.putULong64("counter",previous+BLOCK)==sizeof(uint64_t);
  p.end();if(!ok)return false;nextCounter=previous+1;reservedEnd=previous+BLOCK;return true;
}
static void newRegistration() {
  unsigned char bytes[10], hash[32];char code[21];
  esp_fill_random(bytes,sizeof(bytes));hex(bytes,sizeof(bytes),code);
  if(!sha(code,20,hash))return;
  hex(hash,32,pairingHash);
  Serial.printf("[REGISTER] %.4s-%.4s-%.4s-%.4s-%.4s\n",code,code+4,code+8,code+12,code+16);
  Serial.println("[REGISTER] Upload must succeed before this one-time number can be used on the website.");
}
static bool load() {
  Preferences p;if(!p.begin("gps-auth",true))return false;
  String id=p.getString("uid",""), secret=p.getString("secret","");ack=p.getString("ack","");p.end();
  if(id.length()==0||id.length()>64||secret.length()!=64)return false;
  for(unsigned int i=0;i<id.length();i++)if(!isalnum(static_cast<unsigned char>(id[i]))&&id[i]!='-'&&id[i]!='_')return false;
  for(unsigned int i=0;i<secret.length();i++)if(!isxdigit(static_cast<unsigned char>(secret[i])))return false;
  if(!sha(secret.c_str(),secret.length(),key))return false;
  id.toCharArray(identity,sizeof(identity));return reserve();
}
void poll() {
  while(Serial.available()) {
    char ch=static_cast<char>(Serial.read());
    if(ch=='\r')continue;
    if(ch!='\n'){if(input.length()<160)input+=ch;else input="";continue;}
    input.trim();
    if(input=="REGISTER" && ready)newRegistration();
    else if(input.startsWith("AUTH ")) {
      int split=input.indexOf(' ',5);
      String id=split>5?input.substring(5,split):"", secret=split>5?input.substring(split+1):"";
      bool valid=id.length()>0&&id.length()<=64&&secret.length()==64;
      for(unsigned int i=0;i<id.length();i++)valid=valid&&(isalnum(static_cast<unsigned char>(id[i]))||id[i]=='-'||id[i]=='_');
      for(unsigned int i=0;i<secret.length();i++)valid=valid&&isxdigit(static_cast<unsigned char>(secret[i]));
      if(valid) {
        Preferences p;valid=p.begin("gps-auth",false);
        if(valid){valid=p.putString("uid",id)==id.length()&&p.putString("secret",secret)==secret.length();
          p.remove("ack");valid=valid&&p.putULong64("counter",0)==sizeof(uint64_t);p.end();}
        if(valid){Serial.println("[AUTH] Provisioned. Restarting; secret is never printed.");delay(100);esp_restart();}
      }
      if(!valid)Serial.println("[AUTH] Invalid provisioning data.");
    }
    input="";
  }
}
void begin() {
  ready=load();
#if KC_TEST_BUILD
  if(!ready){Serial.println("[AUTH] KC-only legacy transport; requires isolated KC server setting.");return;}
#endif
  uint32_t notice=millis()-5000;
  while(!ready){poll();if(millis()-notice>=5000){Serial.println("[AUTH] Device credential required. Run the USB provisioning tool.");notice=millis();}delay(10);}
  Serial.printf("[AUTH] Signed ingest ready: %s\n",identity);newRegistration();
}
bool enabled(){return ready;}
const char *uid(){return identity;}
bool prepare(const char *body, String &wireBody, uint64_t &counter, char signature[65]) {
  if(!ready){wireBody=body;counter=0;signature[0]=0;return KC_TEST_BUILD;}
  if(nextCounter>reservedEnd&&!reserve())return false;
  cJSON *json=cJSON_Parse(body);if(!json)return false;
  const cJSON *sim=cJSON_GetObjectItemCaseSensitive(json,"iccid");
  if(!cJSON_IsString(sim)){cJSON_Delete(json);Serial.println("[AUTH] Waiting for SIM identity.");return false;}
  String currentSim=sim->valuestring;
  if(currentSim.length()!=19&&currentSim.length()!=20){cJSON_Delete(json);return false;}
  for(unsigned int i=0;i<currentSim.length();i++)if(!isdigit(static_cast<unsigned char>(currentSim[i]))){cJSON_Delete(json);return false;}
  if(lastSim.length()&&lastSim!=currentSim){newRegistration();ack="";}
  lastSim=currentSim;
  // device_uid and ICCID describe the current SIM; identity is only the hardware signer.
  cJSON_AddStringToObject(json,"pairing_hash",pairingHash);
  if(ack.length())cJSON_AddStringToObject(json,"command_ack",ack.c_str());
  char *encoded=cJSON_PrintUnformatted(json);cJSON_Delete(json);if(!encoded)return false;
  wireBody=encoded;cJSON_free(encoded);if(wireBody.length()>4096)return false;
  counter=nextCounter++;char value[24];snprintf(value,sizeof(value),"%" PRIu64,counter);
  return mac(String(identity)+"\n"+value+"\n"+wireBody,signature);
}
bool response(const String &raw,uint64_t counter,String &decoded) {
  if(!ready){decoded=raw;return KC_TEST_BUILD;}
  int start=raw.indexOf('{');if(start<0)return false;
  cJSON *json=cJSON_Parse(raw.c_str()+start);if(!json)return false;
  const cJSON *payload=cJSON_GetObjectItemCaseSensitive(json,"payload"), *sig=cJSON_GetObjectItemCaseSensitive(json,"signature"),
    *number=cJSON_GetObjectItemCaseSensitive(json,"counter");
  bool valid=cJSON_IsString(payload)&&cJSON_IsString(sig)&&cJSON_IsNumber(number)
    &&number->valuedouble==static_cast<double>(counter)&&strlen(sig->valuestring)==64;
  char expected[65], value[24];snprintf(value,sizeof(value),"%" PRIu64,counter);
  if(valid)valid=mac(String("response\n")+identity+"\n"+value+"\n"+payload->valuestring,expected);
  if(valid){volatile unsigned char difference=0;for(size_t i=0;i<64;i++)difference|=static_cast<unsigned char>(expected[i]^sig->valuestring[i]);valid=difference==0;}
  if(valid){unsigned char bytes[2048];size_t length=0;
    valid=mbedtls_base64_decode(bytes,sizeof(bytes)-1,&length,
      reinterpret_cast<const unsigned char *>(payload->valuestring),strlen(payload->valuestring))==0;
    if(valid){bytes[length]=0;decoded=reinterpret_cast<const char *>(bytes);
      cJSON *inner=cJSON_Parse(decoded.c_str());
      if(inner&&cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(inner,"sim_link_required"))){
        Serial.println("[PAIR] Enter this SIM number and the REGISTER confirmation number on the website.");valid=false;
      }
      cJSON_Delete(inner);
    }}
  cJSON_Delete(json);return valid;
}
bool acceptCommand(const String &decoded) {
  cJSON *json=cJSON_Parse(decoded.c_str());if(!json)return false;
  const cJSON *id=cJSON_GetObjectItemCaseSensitive(json,"command_id");
  if(!cJSON_IsString(id)){cJSON_Delete(json);return true;}
  String current=id->valuestring;cJSON_Delete(json);
  if(current.length()!=36||current==ack)return false;
  for(unsigned int i=0;i<current.length();i++)if(!isxdigit(static_cast<unsigned char>(current[i]))&&current[i]!='-')return false;
  Preferences p;if(!p.begin("gps-auth",false))return false;
  bool saved=p.putString("ack",current)==current.length();p.end();
  if(saved)ack=current;
  return saved;
}
}
