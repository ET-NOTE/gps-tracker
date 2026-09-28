#include <algorithm>
#include <cassert>
#include <iostream>
#include "../../../arduino/03_10_uno_shield_gps_oled/03_10_uno_shield_gps_oled.ino"

static void reset() {
  modem=SoftwareSerial(8,9);Serial.output.clear();fakeMillis=10000;
  restartPending=false;radioRestorePending=false;gnssEnabled=true;gnssFix=false;gnssSeen=false;
  oledReady=false;lineLength=0;discardLine=false;reply=0;stage=6;
  postFailures=0;postDelayMs=shield::POST_INTERVAL_MS;positionStamp=0;
  gnssState=shield::GNSS_NO_REPLY;gnssRawFix=-1;satellitesView=-1;
  lastPostMs=fakeMillis;lastPollMs=fakeMillis;gnssPoll=fakeMillis;
  regStat=5;rssi=20;httpStatus=-1;latitude[0]=longitude[0]=utc[0]=hdop[0]=0;
  lastPositionUtc[0]=0;
}
static void fix(const char *value="1,1,20260928090000.000,37.500000,127.000000,10,0,0,1,,1.2,1,1,,8,,2,2") {
  char csv[220];strcpy(csv,value);parseGnss(csv);
}
static size_t indexOf(const char *cmd) {
  auto p=std::find(modem.commands.begin(),modem.commands.end(),cmd);
  return (size_t)(p-modem.commands.begin());
}
int main() {
  reset();fix();assert(gnssFix && satellitesView==8);
  fakeMillis+=16000;fix();assert(!gnssFix); // Unchanged UTC cannot remain fresh forever.
  fix("1,,,0.000000,0.000000,-18.000,,,1,,0.1,0.1,0.1,,,,9999000.0,6144.0");
  fix();assert(!gnssFix && gnssState==shield::GNSS_STALE); // Empty replies cannot revive old UTC.
  reset();fix("1,1,20260928090000.000,37.5,127.0,0,0,0,1,,500.0,0,0,,2,,0,0");assert(!gnssFix);
  reset();fix("1,1,20260928090000.000,NaN,127.0,0,0,0,1,,1.2,0,0,,8,,0,0");assert(!gnssFix);
  assert(gnssState==shield::GNSS_BAD_COORD);
  reset();fix("1,,,0.000000,0.000000,-18.000,,,1,,0.1,0.1,0.1,,,,9999000.0,6144.0");
  assert(!gnssFix && gnssState==shield::GNSS_NO_FIX_STATUS && gnssRawFix==-1);
  reset();fix("1,0,20260928090000.000,37.5,127.0,0,0,0,1,,1.2,0,0,,8,,0,0");
  assert(!gnssFix && gnssState==shield::GNSS_NO_FIX);
  reset();fix("1,1x,20260928090000.000,37.5,127.0,0,0,0,1,,1.2,0,0,,8,,0,0");assert(!gnssFix);
  reset();fix("1,1,20260928090000.000,37.500000000000bad,127.0,0,0,0,1,,1.2,0,0,,8,,0,0");
  assert(!gnssFix && gnssState==shield::GNSS_BAD_FIELDS);
  for(const char *sv : {"260","8x","-1","","128","99999"}) {
    const std::string value=std::string("1,1,20260928090000.000,37.5,127.0,0,0,0,1,,1.2,0,0,,")+sv+",,0,0";
    reset();fix(value.c_str());assert(!gnssFix && satellitesView==-1 && gnssState==shield::GNSS_BAD_SV);
  }
  reset();fix("1,1,20260928090000.000,37.5,127.0");assert(!gnssFix && gnssState==shield::GNSS_BAD_FIELDS);
  assert(!shield::validUtc("20260230090000.000"));assert(shield::validUtc("20280229090000.000"));
  assert(!shield::decimalInRange("1e2",-180,180));assert(!shield::decimalInRange("+1",-180,180));
  assert(!shield::decimalInRange("91",-90,90));assert(!shield::decimalInRange("01.2",-90,90));
  assert(shield::due(10,UINT32_MAX-10,20));assert(!shield::due(10,UINT32_MAX-10,22));
  assert(shield::retryDelay(1)==15000 && shield::retryDelay(2)==30000 && shield::retryDelay(3)==60000 && shield::retryDelay(255)==120000);

  reset();fix();stageServer();assert(httpStatus==200 && postFailures==0 && modem.gnss);
  assert(indexOf("AT+CGNSPWR=0")<indexOf("AT+SHCONN"));
  assert(indexOf("AT+SHSSL=0")<indexOf("AT+SHCONN"));
  assert(indexOf("AT+SHREQ=\"/ingest\",3")<indexOf("AT+CGNSPWR=1"));
  assert(modem.bodies.size()==1 && modem.bodies[0].find("\"fix\":true")!=std::string::npos);
  assert(modem.bodies[0].find("vbat_mv")==std::string::npos);
  std::cout<<modem.bodies[0]<<"\n";

  reset();stageServer();assert(httpStatus==200);
  assert(modem.bodies[0].find("\"fix\":false")!=std::string::npos && modem.bodies[0].find("\"lat\"")==std::string::npos);
  std::cout<<modem.bodies[0]<<"\n";
  char tiny[10];assert(buildPayload(tiny,sizeof(tiny),true)==-1);
  strcpy(latitude,"-90.000000");strcpy(longitude,"-180.000000");satellitesView=99;fakeMillis=UINT32_MAX-100;
  char maximum[256];assert(buildPayload(maximum,sizeof(maximum),true)>0);
  reset();stage=3;gnssPoll=0;serviceGnss();assert(modem.commands.empty());
  stage=4;serviceGnss();assert(modem.commands.empty()); // Do not start GNSS during LTE registration.

  for(const char *failure : {"AT+SHCONN","AT+SHCONF=\"BODYLEN\",1024","AT+SHCHEAD","AT+SHREQ=\"/ingest\",3"}) {
    reset();modem.failCommand=failure;stageServer();
    assert(postFailures==1 && postDelayMs==15000 && !modem.gnss && !modem.pdp);
    assert(Serial.output.find("[AT FAIL]")!=std::string::npos);
  }
  reset();modem.failCommand="AT+CGNSPWR=0";stageServer();assert(indexOf("AT+SHCONN")==modem.commands.size() && postFailures==1);
  reset();modem.timeoutCommand="AT+SHCONN";stageServer();assert(!modem.gnss && postFailures==1);
  reset();modem.rebootCommand="AT+SHCONN";stageServer();assert(restartPending && postFailures==1);
  assert(indexOf("AT+CGNSPWR=1")==modem.commands.size()); // Do not command a rebooting modem.
  reset();modem.status=503;stageServer();assert(postFailures==1 && !modem.gnss);
  reset();modem.delayedPrompt=true;stageServer();assert(httpStatus==200 && postFailures==0);
  reset();modem.rejectGnssRestore=true;stageServer();assert(httpStatus==200 && !gnssEnabled);

  reset();modem.failCommand="AT+SHCONN";stageServer();assert(postFailures==1);
  modem.failCommand.clear();fakeMillis+=15000;gnssPoll=fakeMillis;lastPollMs=fakeMillis;
  loop();assert(httpStatus==200 && postFailures==0); // Failed posts recover automatically.
  const auto sent=modem.bodies.size();fakeMillis+=60000;gnssPoll=fakeMillis;lastPollMs=fakeMillis;
  loop();assert(modem.bodies.size()==sent); // Missing fix gets more than sixty seconds.
  fakeMillis=lastPostMs+shield::GNSS_ACQUIRE_MS;gnssPoll=fakeMillis;
  loop();assert(modem.bodies.size()==sent+1); // Bounded no-fix heartbeat.
  reset();fakeMillis+=60000;gnssPoll=fakeMillis;fix();loop();assert(modem.bodies.size()==1);
  reset();modem.timeoutCommand="AT+CEREG?";fakeMillis+=15000;gnssPoll=fakeMillis;
  loop();assert(stage==6 && modem.commands.empty()); // Network recovery cannot chop GNSS.
  gnssEnabled=false;modem.gnss=false;postFailures=1;fakeMillis+=15000;gnssPoll=fakeMillis;
  loop();assert(stage==3 && regStat==-1); // A stale success cannot mask registration loss.
  reset();postFailures=1;gnssEnabled=false;gnssPoll=0;serviceGnss();assert(modem.commands.empty());
  reset();modem.rejectGnssRestore=true;stageServer();fakeMillis+=60000;gnssPoll=fakeMillis;
  loop();assert(modem.bodies.size()==2); // Broken GNSS power command cannot starve reports.
  assert(!shield::reportDue(60000,0,60000,0,true,false));
  assert(shield::reportDue(600000,0,60000,0,true,false));
  assert(shield::reportDue(60000,0,60000,0,true,true));
  assert(shield::reportDue(15000,0,15000,1,false,false));
  assert(shield::reportDue(599989,UINT32_MAX-10,60000,0,true,false));
  reset();isolatedGnssTest();assert(stage==1 && !radioRestorePending && !gnssEnabled);
  assert(indexOf("AT+CFUN=0")<indexOf("AT+CGNSPWR=1"));
  assert(indexOf("AT+CGNSPWR=1")<indexOf("AT+CFUN=1"));
  assert(modem.bodies.empty() && Serial.output.find("No qualified fix")!=std::string::npos);
  reset();modem.gnssReply="1,1,20260928090000.000,37.5,127.0,0,0,0,1,,1.2,0,0,,8,,0,0";
  isolatedGnssTest();assert(!radioRestorePending && Serial.output.find("FIX obtained")!=std::string::npos);
  assert(fakeMillis<30000); // A real fix can finish the isolated test early.
  reset();modem.timeoutCommand="AT+CFUN=0";isolatedGnssTest();assert(!radioRestorePending);
  assert(indexOf("AT+CFUN=1")<modem.commands.size()); // Restore even after ambiguous disable.
  reset();modem.failCommand="AT+CFUN=1";isolatedGnssTest();assert(radioRestorePending);
  modem.failCommand.clear();loop();assert(!radioRestorePending && stage==1);
  reset();modem.rebootCommand="AT+CGNSINF";isolatedGnssTest();assert(restartPending && radioRestorePending);
  modem.rebootCommand.clear();loop();assert(!radioRestorePending && !restartPending && stage==1);
  std::cerr<<"UNO shield host tests passed\n";
}
