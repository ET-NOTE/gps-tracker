#include <cassert>
#include <deque>
#include <string>
#include <vector>
#include "../main/modem_tcp.cpp"
SerialStub Serial;
static uint32_t clockMs;
static std::deque<unsigned char> rx;
static std::string input, sent, malformed;
static bool reverseOpen, failOpen;
uint32_t millis(){return clockMs;}
void delay(uint32_t n){clockMs+=n;}
static void reply(const std::string &s){ rx.insert(rx.end(),s.begin(),s.end()); }
int HardwareSerial::available(){return int(rx.size());}
int HardwareSerial::read(){ assert(!rx.empty()); int c=rx.front();rx.pop_front();return c; }
void HardwareSerial::write(const uint8_t *p,size_t n){sent.append(reinterpret_cast<const char*>(p),n);reply("\r\n+CADATAIND: 0\r\nOK\r\n");}
void HardwareSerial::print(const char *p){
  std::string cmd=p; if(cmd=="\r\n")return;
  if(cmd.find("AT+CAOPEN")==0){
    if(failOpen)reply("\r\nOK\r\n+CAOPEN: 0,23\r\n");
    else reply(reverseOpen?"\r\nOK\r\n+CAOPEN: 0,0\r\n":"\r\n+CAOPEN: 0,0\r\nOK\r\n");
  } else if(cmd.find("AT+CASEND")==0)reply("\r\n>");
  else if(cmd.find("AT+CARECV")==0){
    if(!malformed.empty()){reply(malformed);return;}
    unsigned n=0;assert(sscanf(p,"AT+CARECV=0,%u",&n)==1);n=std::min(n,unsigned(input.size()));
    reply("\r\n+CADATAIND: 0\r\n+CARECV: "+std::to_string(n)+","+input.substr(0,n)+"\r\nOK\r\n");input.erase(0,n);
  } else reply("\r\nOK\r\n");
}
int main(){
  HardwareSerial uart(1);ModemTcp tcp(uart);
  for(bool reverse:{false,true}){
    reverseOpen=reverse; assert(tcp.open("gps.serial.kr",443));
    input=std::string("\0\r\nERROR\r\nOK\r\n+CARECV: 0,",28)+std::string(2000,'\xff');
    std::string expected=input,got;unsigned char buf[4096];
    while(!input.empty()){int n=tcp.receive(buf,sizeof(buf));assert(n>0&&n<=768);got.append(reinterpret_cast<char*>(buf),n);}
    assert(got==expected);assert(tcp.receive(buf,sizeof(buf))==0);
    sent.clear();size_t pos=0;
    while(pos<got.size()){int n=tcp.send(reinterpret_cast<const unsigned char*>(got.data()+pos),got.size()-pos);assert(n>0&&n<=1024);pos+=n;}
    assert(sent==got);tcp.close();assert(tcp.receive(buf,sizeof(buf))<0);
  }
  for(const auto &bad:{"\r\n+CARECV: 769,", "\r\n+CARECV: 3\r\nOK\r\n", "\r\n+CARECV: 5,ab", "\r\nERROR\r\n", "\r\n+CARECV: 3,abc\r\nERROR\r\n"}){
    assert(tcp.open("gps.serial.kr",443));malformed=bad;unsigned char buf[768];assert(tcp.receive(buf,sizeof(buf))<0);malformed.clear();tcp.close();
  }
  failOpen=true;assert(!tcp.open("gps.serial.kr",443));
}
