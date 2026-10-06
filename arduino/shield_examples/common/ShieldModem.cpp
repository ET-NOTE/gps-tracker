#include "ShieldModem.h"
#include <stdio.h>

void ShieldModem::parse() {
  int a,b;
  if(!strcmp(line,"OK")) reply=1;
  else if(!strcmp(line,"ERROR")||!strncmp(line,"+CME ERROR:",11)||!strncmp(line,"+CMS ERROR:",11)) reply=2;
  if(!strcmp(line,"RDY")) { restarted=true; clock=0;sim=pdp=false; }
  if(sscanf(line,"+CSQ: %d,%d",&a,&b)==2) signal=a;
  if(sscanf(line,"+CEREG: %d,%d",&a,&b)==2) registration=b;
  if(!strncmp(line,"+CPIN:",6)) { const char *s=line+6;while(*s==' ')++s;sim=!strcmp(s,"READY"); }
  if(sscanf(line,"+CNACT: %d,%d",&a,&b)==2&&a==0) pdp=b==1;
  if(sscanf(line,"+CNTP: %d",&a)==1) ntp=a;
  if(sscanf(line,"+SHSTATE: %d",&a)==1) state=a;
  if(!strncmp(line,"+SHREQ:",7)) { const char *p=strchr(line,','); if(p) http=atoi(p+1); }
  if(!strncmp(line,"+CCLK:",6)) {
    char *p=strchr(line,'"'); if(p) { char *q=strchr(++p,'"'); if(q) { *q=0;clock=shield_example::clockEpoch(p); } }
  }
  if(!strncmp(line,"+CGNSINF:",9)) fixSeen=shield_example::gnss(line+9,latest);
}
void ShieldModem::receive() {
  while(uart.available()) {
    char c=uart.read();++received;
    if(c=='\r'||c=='\n') { if(length&&!overflow) { line[length]=0;parse(); } length=0;overflow=false; }
    else if(!overflow) { if(length<sizeof(line)-1) line[length++]=c;else overflow=true; }
  }
}
void ShieldModem::drain(uint32_t ms) { const uint32_t start=millis();while(millis()-start<ms) receive(); }
bool ShieldModem::wait(uint32_t timeout) {
  const uint32_t start=millis();while(!reply&&!restarted&&millis()-start<timeout) receive();
  return reply==1&&!restarted;
}
bool ShieldModem::command(const __FlashStringHelper *text,uint32_t timeout) {
  drain(60);reply=0;length=0;overflow=false;uart.print(text);uart.print('\r');return wait(timeout);
}
bool ShieldModem::commandRam(const char *text,uint32_t timeout) {
  drain(60);reply=0;length=0;overflow=false;uart.print(text);uart.print('\r');return wait(timeout);
}
bool ShieldModem::begin() {
  digitalWrite(7,LOW);pinMode(7,OUTPUT);digitalWrite(6,HIGH);pinMode(6,OUTPUT);
  uart.begin(9600);drain(800);restarted=false;
  bool ready=false;
  const uint32_t rates[]={9600,115200,19200,38400,57600};
  for(uint8_t i=0;i<5&&!ready;i++) {
    uart.end();uart.begin(rates[i]);restarted=false;ready=command(F("AT"),1500);
    if(ready&&rates[i]!=9600) { command(F("AT+IPR=9600"));uart.end();uart.begin(9600);ready=command(F("AT")); }
  }
  // A single bounded pulse only when no UART activity was seen. Never hold PWRKEY high.
  if(!ready&&!received) {
    uart.end();uart.begin(9600);digitalWrite(7,HIGH);drain(1500);digitalWrite(7,LOW);drain(12000);
    restarted=false;ready=command(F("AT"));
  }
  if(!ready) { Serial.println(F("[STOP] AT failed. Check power/UART/baud, then reset UNO."));return false; }
  restarted=false;
  return command(F("ATE0"))&&command(F("AT+IFC=0,0"))&&command(F("AT+CMEE=2"))&&
         command(F("AT+CSCLK=0"))&&gnssPower(false);
}
void ShieldModem::bridge() {
  if(Serial.available()) uart.write(Serial.read());
  if(uart.available()) Serial.write(uart.read());
}
void ShieldModem::status() {
  sim=false;signal=99;registration=-1;
  command(F("AT+CPIN?"));command(F("AT+CSQ"));command(F("AT+CEREG?"));
  Serial.print(F("SIM="));Serial.print(sim?F("READY"):F("NOT READY"));
  Serial.print(F(" CSQ="));Serial.print(signal);Serial.print(F(" CEREG="));Serial.println(registration);
}
bool ShieldModem::closeHttp() {
  state=-1;
  if(!command(F("AT+SHSTATE?"))) return false;
  if(state==0) return true;
  command(F("AT+SHDISC"),10000);state=-1;
  return command(F("AT+SHSTATE?"))&&state==0;
}
bool ShieldModem::gnssPower(bool on) {
  if(on&&!closeHttp()) return false;
  return command(on?F("AT+CGNSPWR=1"):F("AT+CGNSPWR=0"));
}
bool ShieldModem::readFix(shield_example::Fix &fix) {
  fixSeen=false;
  if(!command(F("AT+CGNSINF"))||!fixSeen) return false;
  fix=latest;return true;
}
bool ShieldModem::connectNetwork(const char *apn) {
  if(!shield_example::safeToken(apn,63)||restarted||!gnssPower(false)||!closeHttp()) return false;
  sim=false;if(!command(F("AT+CPIN?"))||!sim) return false;
  const uint32_t start=millis();registration=-1;
  do { command(F("AT+CEREG?"));if(registration==1||registration==5)break;drain(2000); }
  while(!restarted&&millis()-start<90000UL);
  if(registration!=1&&registration!=5) return false;
  signal=99;command(F("AT+CSQ"));pdp=false;
  if(!command(F("AT+CNACT?")))return false;
  if(!pdp) {
    char cmd[100];snprintf_P(cmd,sizeof(cmd),PSTR("AT+CNCFG=0,1,\"%s\""),apn);
    if(!commandRam(cmd))return false;
    command(F("AT+CNACT=0,1"),20000);drain(1000);pdp=false;
    if(!command(F("AT+CNACT?"))||!pdp)return false;
  }
  return syncClock();
}
bool ShieldModem::syncClock() {
  ntp=-1;
  if(!command(F("AT+CNTPCID=0"))||!command(F("AT+CNTP=\"time.cloudflare.com\",0"))||
      !command(F("AT+CNTP"),5000))return false;
  const uint32_t start=millis();while(ntp<0&&!restarted&&millis()-start<45000UL)receive();
  return ntp==1&&utcNow()!=0;
}
uint32_t ShieldModem::utcNow() { clock=0;return command(F("AT+CCLK?"))?clock:0; }
int ShieldModem::post(const char *host,const char *path,const char *key,const char *ca,const char *body) {
  if(!shield_example::safeToken(host,95)||!shield_example::safeToken(ca,40)||
     !shield_example::hexKey(key)||strlen(path)>96||path[0]!='/'||strlen(body)>768||restarted) return -1;
  for(const char *p=path;*p;p++) if(!(isalnum(*p)||*p=='/'||*p=='-'||*p=='_'||*p=='.'))return -1;
  if(!gnssPower(false)||!closeHttp()||!utcNow())return -1;
  char cmd[144];int result=-1;
  // Secret headers/body are sent only after verified TLS connection succeeds.
  do {
    if(!command(F("AT+CSSLCFG=\"SSLVERSION\",1,3"))||!command(F("AT+CSSLCFG=\"IGNORERTCTIME\",1,0")))break;
    snprintf_P(cmd,sizeof(cmd),PSTR("AT+CSSLCFG=\"SNI\",1,\"%s\""),host);if(!commandRam(cmd))break;
    snprintf_P(cmd,sizeof(cmd),PSTR("AT+SHSSL=1,\"%s\""),ca);if(!commandRam(cmd))break;
    snprintf_P(cmd,sizeof(cmd),PSTR("AT+SHCONF=\"URL\",\"https://%s\""),host);if(!commandRam(cmd))break;
    if(!command(F("AT+SHCONF=\"BODYLEN\",768"))||!command(F("AT+SHCONF=\"HEADERLEN\",350"))||
       !command(F("AT+SHCONN"),60000))break;
    state=-1;if(!command(F("AT+SHSTATE?"))||state!=1)break;
    if(!command(F("AT+SHCHEAD"))||!command(F("AT+SHAHEAD=\"Content-Type\",\"application/json\"")))break;
    snprintf_P(cmd,sizeof(cmd),PSTR("AT+SHAHEAD=\"X-Device-Key\",\"%s\""),key);if(!commandRam(cmd))break;
    http=-1;reply=0;length=0;overflow=false;
    uart.print(F("AT+SHBOD="));uart.print(strlen(body));uart.print(F(",10000\r"));
    bool prompt=false;const uint32_t start=millis();
    while(millis()-start<3000UL) { if(uart.available()&&uart.read()=='>') { prompt=true;break; } }
    if(!prompt) { drain(11000);break; }
    reply=0;uart.print(body);if(!wait(10000))break;
    snprintf_P(cmd,sizeof(cmd),PSTR("AT+SHREQ=\"%s\",3"),path);if(!commandRam(cmd,15000))break;
    const uint32_t sent=millis();while(http<0&&!restarted&&millis()-sent<45000UL) receive();
    if(!restarted)result=http;
  } while(false);
  memset(cmd,0,sizeof(cmd));
  if(!closeHttp()) Serial.println(F("[HTTP] Close unconfirmed. Reset UNO before changing to GNSS."));
  return result;
}
