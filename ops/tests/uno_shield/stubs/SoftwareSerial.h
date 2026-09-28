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
  int status=200;
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
    if(cmd==rebootCommand) { queue("\r\nRDY\r\n"); return 1; }
    if(cmd==timeoutCommand) return 1;
    if(cmd==failCommand || (rejectGnssRestore && cmd=="AT+CGNSPWR=1")) { queue("\r\n+CME ERROR: operation not allowed\r\n");return 1; }
    if(cmd=="AT+SHSSL=0,\"\"") { queue("\r\n+CME ERROR: operation not allowed\r\n");return 1; }
    // This emulates the regression: SH* commands are rejected while GNSS is on.
    if(cmd.rfind("AT+SH",0)==0 && gnss) { queue("\r\nERROR\r\n");return 1; }
    if(cmd=="AT+CGNSPWR=0") gnss=false;
    if(cmd=="AT+CGNSPWR=1") gnss=true;
    if(cmd=="AT+CNACT=0,0") pdp=false;
    if(cmd=="AT+CNACT=0,1") pdp=true;
    if(cmd=="AT+CNACT?") queue(pdp?"\r\n+CNACT: 0,1,\"10.0.0.1\"\r\n":"\r\n+CNACT: 0,0,\"0.0.0.0\"\r\n");
    if(cmd=="AT+CEREG?") queue("\r\n+CEREG: 0,5\r\n");
    if(cmd=="AT+CSQ") queue("\r\n+CSQ: 20,0\r\n");
    if(cmd=="AT+CGNSINF" && !gnssReply.empty()) queue("\r\n+CGNSINF: "+gnssReply+"\r\n");
    if(cmd.rfind("AT+SHBOD=",0)==0) {
      remaining=(unsigned)std::stoul(cmd.substr(9));
      if(delayedPrompt) pendingPrompt=true;else queue("\r\n>");
      return 1;
    }
    queue("\r\nOK\r\n");
    if(cmd=="AT+SHREQ=\"/ingest\",3") queue("\r\n+SHREQ: \"POST\","+std::to_string(status)+",2\r\n");
    return 1;
  }
};
