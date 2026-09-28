#include <algorithm>
#include <cassert>
#include <iostream>
#include "../../../arduino/03_10_uno_shield_gps_oled/03_10_uno_shield_gps_oled.ino"

static void reset() {
  modem=SoftwareSerial(8,9);Serial.output.clear();Serial.input.clear();fakeMillis=10000;
  restartPending=false;gnssEnabled=true;gnssFix=false;gnssSeen=false;
#if SHIELD_DIAGNOSTICS
  radioRestorePending=false;traceNetwork=false;
#endif
  oledReady=false;lineLength=0;discardLine=false;reply=0;stage=6;
  postFailures=0;postDelayMs=shield::POST_INTERVAL_MS;positionStamp=0;
  gnssState=shield::GNSS_NO_REPLY;gnssRawFix=-1;satellitesView=-1;
  lastPostMs=fakeMillis;lastPollMs=fakeMillis;gnssPoll=fakeMillis;
  regStat=5;rssi=20;httpStatus=-1;latitude[0]=longitude[0]=utc[0]=hdop[0]=0;
  lastPositionUtc[0]=0;pendingFixes=shield::Batch();
  httpState=-1;acquisitionMs=shield::GNSS_ACQUIRE_MS;
#if SHIELD_PLATFORM_TARGET
  tlsTimeReady=false;clockValid=false;ntpResult=-1;
#endif
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
#if SHIELD_PLATFORM_TARGET
  assert(indexOf("AT+SHSSL=1,\"shield-ca.pem\"")<indexOf("AT+SHCONN"));
  assert(indexOf("AT+CSSLCFG=\"IGNORERTCTIME\",1,0")<indexOf("AT+SHCONN"));
  assert(indexOf("AT+CNTP")<indexOf("AT+SHCONN"));
#else
  assert(indexOf("AT+SHSSL=0")<indexOf("AT+SHCONN"));
#endif
  assert(indexOf("AT+SHREQ=\"/ingest/shield\",3")<indexOf("AT+CGNSPWR=1"));
  assert(modem.bodies.size()==1 && modem.bodies[0].find("\"points\":[[")!=std::string::npos);
  assert(modem.bodies[0].find("vbat_mv")==std::string::npos);
  assert(acquisitionMs==shield::GNSS_REACQUIRE_MS);
  assert(std::count(modem.commands.begin(),modem.commands.end(),"AT+SHDISC")==1);
  assert(Serial.output.find("[AT ERROR]")==std::string::npos);
  std::cout<<modem.bodies[0]<<"\n";
  modem.commands.clear();fix();stageServer();
  assert(std::count(modem.commands.begin(),modem.commands.end(),"AT+SHDISC")==1);
  assert(indexOf("AT+SHSTATE?")==modem.commands.size()); // Known closed needs no extra query.
#if SHIELD_PLATFORM_TARGET
  assert(indexOf("AT+CNTP")==modem.commands.size()); // No repeated NTP each upload.
  for(const char *failure : {"AT+CSSLCFG=\"IGNORERTCTIME\",1,0","AT+SHSSL=1,\"shield-ca.pem\"","AT+SHCONN"}) {
    reset();modem.failCommand=failure;stageServer();
    assert(postFailures==1 && modem.bodies.empty());
    assert(indexOf("AT+SHAHEAD=\"X-Device-Key\",\"" SHIELD_DEVICE_KEY "\"")==modem.commands.size());
  }
  reset();modem.ntpCode=65;stageServer();assert(modem.bodies.empty() && !tlsTimeReady);
  reset();modem.rtcValid=false;stageServer();assert(modem.bodies.empty() && !tlsTimeReady);
  reset();modem.failCommand="AT+SHAHEAD=\"X-Device-Key\",\"" SHIELD_DEVICE_KEY "\"";stageServer();
  assert(modem.bodies.empty() && Serial.output.find(SHIELD_DEVICE_KEY)==std::string::npos);
  reset();modem.timeoutCommand="AT+SHAHEAD=\"X-Device-Key\",\"" SHIELD_DEVICE_KEY "\"";stageServer();
  assert(modem.bodies.empty() && Serial.output.find(SHIELD_DEVICE_KEY)==std::string::npos);
  reset();tlsTimeReady=true;modem.queue("RDY\r\n");receiveLines();assert(!tlsTimeReady);
  reset();tlsTimeReady=true;restartPending=true;loop();assert(!tlsTimeReady); // waitPrompt's reset path.
  reset();modem.queue("AT+SHAHEAD=\"X-Device-Key\",\"" SHIELD_DEVICE_KEY "\"\r\n");
#if SHIELD_DIAGNOSTICS
  traceNetwork=true;
#endif
  receiveLines();assert(Serial.output.find(SHIELD_DEVICE_KEY)==std::string::npos);
#endif

  reset();modem.http=true;stageServer(); // UNO reset with modem still connected.
  assert(postFailures==0 && !modem.http && httpState==0);
  assert(indexOf("AT+SHDISC")<indexOf("AT+SHCONN"));
  reset();httpState=0;modem.failCommand="AT+SHDISC";stageServer();
  assert(httpStatus==200 && postFailures==1 && !gnssEnabled && httpState==-1);
  modem.failCommand.clear();stageServer();assert(postFailures==0 && !modem.http && gnssEnabled);
  reset();modem.timeoutCommand="AT+SHDISC";stageServer();assert(postFailures==1 && !gnssEnabled);
  modem.timeoutCommand.clear();stageServer();assert(postFailures==0 && gnssEnabled);
  reset();modem.failCommand="AT+SHSTATE?";stageServer();
  assert(postFailures==1 && indexOf("AT+SHCONN")==modem.commands.size());

  reset();stageServer();assert(httpStatus==200);
  assert(acquisitionMs==shield::GNSS_ACQUIRE_MS);
  assert(modem.bodies[0].find("\"points\":[]")!=std::string::npos && modem.bodies[0].find("\"lat\"")==std::string::npos);
  std::cout<<modem.bodies[0]<<"\n";
  assert(shield::coordinateE6("-90.000001")==-90000001);
  assert(shield::coordinateE6("127.123456789")==127123456);
  assert(shield::coordinateE6("-0.000001")==-1);
  assert(shield::utcSeconds("20260928090000.000")==1790586000UL);
  assert(shield::utcSeconds("20280229000000.000")==1835395200UL);
  assert(shield::utcSeconds("21000101000000.000")==0);
  reset();
  for(unsigned i=0;i<10;++i) {
    char stamp[19];snprintf(stamp,sizeof(stamp),"2026092809%02u%02u.000",i/6,(i%6)*10);
    assert(pendingFixes.add("-90.000000","-180.000000",stamp,99,fakeMillis+i*10000));
  }
  assert(pendingFixes.count==8);
  assert(pendingFixes.points[0].utc_s==1790586020UL);
  assert(!pendingFixes.add("0","0","20260928090130.000",8,fakeMillis));
  const int maxLength=writePayload(false,UINT32_MAX/1000);assert(maxLength>400 && maxLength<=1024);
  fakeMillis+=90000;modem.gnss=false;bool fresh=false;assert(postReport(fresh));
  assert(pendingFixes.count==0 && modem.bodies[0].size()<=1024);
  std::cout<<modem.bodies[0]<<"\n";
  reset();fix();modem.status=503;stageServer();assert(pendingFixes.count==1);
  const auto before=pendingFixes.points[0].utc_s;modem.status=200;stageServer();
  assert(pendingFixes.count==0 && modem.bodies[0].find(std::to_string(before))!=std::string::npos);
  assert(modem.bodies[1].find(std::to_string(before))!=std::string::npos);
  reset();fix();fakeMillis+=600000;pendingFixes.prune(fakeMillis);assert(pendingFixes.count==0);
  reset();fakeMillis=UINT32_MAX-1000;fix();pendingFixes.prune(10000);assert(pendingFixes.count==1);
  pendingFixes.prune(600000);assert(pendingFixes.count==0);
  reset();fix();fakeMillis+=shield::MAX_SEND_AGE_MS;modem.gnss=false;gnssEnabled=false;
  bool expiredFix=true;assert(postReport(expiredFix));
  assert(!expiredFix && gnssState==shield::GNSS_STALE);
  assert(modem.bodies[0].find("\"points\":[[")!=std::string::npos); // Old but retained samples keep their original UTC.
  reset();stage=3;gnssPoll=0;serviceGnss();assert(modem.commands.empty());
  stage=4;serviceGnss();assert(modem.commands.empty()); // Do not start GNSS during LTE registration.

  for(const char *failure : {"AT+SHCONN","AT+SHCONF=\"BODYLEN\",1024","AT+SHCHEAD","AT+SHREQ=\"/ingest/shield\",3"}) {
    reset();modem.failCommand=failure;stageServer();
    assert(postFailures==1 && postDelayMs==15000 && !modem.gnss && !modem.pdp);
    assert(Serial.output.find("[AT FAIL]")!=std::string::npos);
  }
  reset();modem.failCommand="AT+CGNSPWR=0";stageServer();assert(indexOf("AT+SHCONN")==modem.commands.size() && postFailures==1);
  reset();modem.timeoutCommand="AT+SHCONN";stageServer();assert(!modem.gnss && postFailures==1 && !modem.http);
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
  assert(!shield::reportDue(60000,0,60000,0,true,false,shield::GNSS_ACQUIRE_MS));
  assert(shield::reportDue(600000,0,60000,0,true,false,shield::GNSS_ACQUIRE_MS));
  assert(shield::reportDue(60000,0,60000,0,true,true,shield::GNSS_ACQUIRE_MS));
  assert(shield::reportDue(15000,0,15000,1,false,false,shield::GNSS_ACQUIRE_MS));
  assert(shield::reportDue(599989,UINT32_MAX-10,60000,0,true,false,shield::GNSS_ACQUIRE_MS));
  assert(!shield::reportDue(119999,0,60000,0,true,false,shield::GNSS_REACQUIRE_MS));
  assert(shield::reportDue(120000,0,60000,0,true,false,shield::GNSS_REACQUIRE_MS));
  assert(shield::reportDue(119989,UINT32_MAX-10,60000,0,true,false,shield::GNSS_REACQUIRE_MS));
  reset();fix();stageServer(); // A successful fix starts a warm window.
  fakeMillis=lastPostMs+shield::GNSS_REACQUIRE_MS-1000;gnssPoll=fakeMillis;
  loop();assert(modem.bodies.size()==1);
  fakeMillis=lastPostMs+shield::GNSS_REACQUIRE_MS;gnssPoll=fakeMillis;
  loop();assert(modem.bodies.size()==2 && acquisitionMs==shield::GNSS_ACQUIRE_MS);
  fakeMillis=lastPostMs+shield::GNSS_REACQUIRE_MS;gnssPoll=fakeMillis;
  loop();assert(modem.bodies.size()==2); // Persistent loss gets a full acquisition window.
  fakeMillis=lastPostMs+shield::GNSS_ACQUIRE_MS;gnssPoll=fakeMillis;
  loop();assert(modem.bodies.size()==3);
  fakeMillis=lastPostMs+shield::POST_INTERVAL_MS;gnssPoll=fakeMillis;
  fix("1,1,20260928093000.000,37.5,127.0,0,0,0,1,,1.2,0,0,,8,,0,0");
  loop();assert(modem.bodies.size()==4 && acquisitionMs==shield::GNSS_REACQUIRE_MS);

#if SHIELD_DIAGNOSTICS
  reset();modem.failCommand="AT+SHCONN";stageServer();
  assert(indexOf("AT+CDNSPDPID=0")<modem.commands.size());
  modem.commands.clear();stageServer();assert(indexOf("AT+CDNSPDPID=0")==modem.commands.size());
  reset();modem.failCommand="AT+CFUN=1";Serial.input.push_back('n');loop();
  assert(radioRestorePending && !gnssEnabled);
  modem.failCommand.clear();loop();assert(!radioRestorePending && stage==1);
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
#else
  for(char key:std::string("rspgidn10")) {
    reset();Serial.input.push_back(key);loop();assert(modem.commands.empty() && stage==6);
  }
  reset();stageConfig();stageSim();modem.failCommand="AT+SHCONN";stageServer();
  for(const auto &cmd:modem.commands) {
    assert(cmd.find("CFUN")==std::string::npos && cmd.find("CDNS")==std::string::npos);
    assert(cmd!="AT+CGMR" && cmd!="AT+CGNSMOD?" && cmd!="AT+CCID");
  }
  reset();modem.gnssReply="1,1,20260928090000.000,37.5,127.0,0,0,0,1,,1.2,0,0,,8,,0,0";
  fakeMillis+=5000;serviceGnss();assert(gnssFix);
  assert(Serial.output.find("lat=")==std::string::npos && Serial.output.find("[NET RX]")==std::string::npos);
#endif
  std::cerr<<"UNO shield host tests passed\n";
}
