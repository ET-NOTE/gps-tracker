#pragma once
#include "Arduino.h"
class SoftwareSerial : public Print {
public:
  SoftwareSerial(int,int) {}
  std::deque<char> rx;
  std::vector<std::string> commands, bodies;
  std::string current, body, failCommand, timeoutCommand, rebootCommand, gnssReply;
  unsigned remaining=0;
  bool gnss=true, pdp=true, rejectGnssRestore=false, delayedPrompt=false, pendingPrompt=false;
  bool http=false;
  int status=200;
  int ntpCode=1;
  bool rtcValid=true;
  void queue(const std::string &s) { for(char c:s) rx.push_back(c); }
  void end() {}
  int available() { if(pendingPrompt) { pendingPrompt=false;queue(">"); } return (int)rx.size(); }
  int peek() { return rx.empty() ? -1 : rx.front(); }
  int read() { if(rx.empty())return -1; char c=rx.front();rx.pop_front();return (unsigned char)c; }
  size_t write(uint8_t c) override {
    if(remaining) {
      body.push_back((char)c);
      if(--remaining==0) { bodies.push_back(body);body.clear();queue("\r\nOK\r\n"); }
      return 1;
    }
    if(c!='\r') { current.push_back((char)c);return 1; }
    const std::string cmd=current;current.clear();commands.push_back(cmd);
    if(cmd==rebootCommand) { http=false; queue("\r\nRDY\r\n"); return 1; }
    if(cmd==timeoutCommand) {
      if(cmd=="AT+SHCONN") http=true; // Applied command, lost reply.
      if(cmd=="AT+SHDISC") http=false;
      return 1;
    }
    if(cmd==failCommand || (rejectGnssRestore && cmd=="AT+CGNSPWR=1")) { queue("\r\n+CME ERROR: operation not allowed\r\n");return 1; }
    if(cmd=="AT+SHSSL=0,\"\"") { queue("\r\n+CME ERROR: operation not allowed\r\n");return 1; }
    // This emulates the regression: SH* commands are rejected while GNSS is on.
    if(cmd.rfind("AT+SH",0)==0 && gnss) { queue("\r\nERROR\r\n");return 1; }
    if(cmd=="AT+SHSTATE?") queue(http?"\r\n+SHSTATE: 1\r\n":"\r\n+SHSTATE: 0\r\n");
    if(cmd=="AT+SHCONN") http=true;
    if(cmd=="AT+SHDISC") {
      if(!http) { queue("\r\nERROR\r\n");return 1; }
      http=false;
    }
    if(cmd=="AT+CGNSPWR=0") gnss=false;
    if(cmd=="AT+CGNSPWR=1") gnss=true;
    if(cmd=="AT+CNACT=0,0") pdp=false;
    if(cmd=="AT+CNACT=0,1") pdp=true;
    if(cmd=="AT+CNACT?") queue(pdp?"\r\n+CNACT: 0,1,\"10.0.0.1\"\r\n":"\r\n+CNACT: 0,0,\"0.0.0.0\"\r\n");
    if(cmd=="AT+CEREG?") queue("\r\n+CEREG: 0,5\r\n");
    if(cmd=="AT+CSQ") queue("\r\n+CSQ: 20,0\r\n");
    if(cmd=="AT+CCLK?") queue(rtcValid?"\r\n+CCLK: \"26/09/28,09:00:00+00\"\r\n":"\r\n+CCLK: \"80/01/01,00:00:00+00\"\r\n");
    if(cmd=="AT+CGNSINF" && !gnssReply.empty()) queue("\r\n+CGNSINF: "+gnssReply+"\r\n");
    if(cmd.rfind("AT+SHBOD=",0)==0) {
      remaining=(unsigned)std::stoul(cmd.substr(9));
      if(delayedPrompt) pendingPrompt=true;else queue("\r\n>");
      return 1;
    }
    queue("\r\nOK\r\n");
    if(cmd=="AT+CNTP") queue("\r\n+CNTP: "+std::to_string(ntpCode)+"\r\n");
    if(cmd=="AT+SHREQ=\"/ingest/shield\",3") queue("\r\n+SHREQ: \"POST\","+std::to_string(status)+",2\r\n");
    return 1;
  }
};
