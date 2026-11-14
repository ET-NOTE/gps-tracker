#pragma once
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <cstdarg>
#include <cstdlib>
#include <string>
#include <algorithm>
#define RTC_DATA_ATTR
#define ESP_IDF_VERSION_MAJOR 5
#define HIGH 1
#define LOW 0
#define OUTPUT 1
#define SERIAL_8N1 0
#define F(x) x
using esp_err_t = int;
constexpr int ESP_OK = 0, ESP_ERR_INVALID_STATE = -1;
uint32_t millis();
void delay(uint32_t);
int digitalRead(int);
void digitalWrite(int, int);
void pinMode(int, int);
int analogReadMilliVolts(int);
struct SerialStub {
  template<typename... T> void printf(const char*, T...) {}
  template<typename T> void println(T) {}
  template<typename T> void print(T) {}
  void flush();
};
extern SerialStub Serial;

// Small Arduino String adapter used only when compiling the actual LTE module.
class String : public std::string {
 public:
  using std::string::string;
  String(const std::string& s) : std::string(s) {}
  int indexOf(const char* s, size_t from=0) const { auto p=find(s,from); return p==npos ? -1 : int(p); }
  int indexOf(char c, size_t from=0) const { auto p=find(c,from); return p==npos ? -1 : int(p); }
  int lastIndexOf(char c) const { auto p=rfind(c); return p==npos ? -1 : int(p); }
  String substring(size_t from, size_t to=npos) const {
    if(from>size()) return "";
    return substr(from,to==npos ? npos : to-from);
  }
  void remove(size_t from,size_t n=npos) { erase(from,n); }
  void replace(const char* before,const char* after) {
    size_t p=0; while((p=find(before,p))!=npos) { std::string::replace(p,strlen(before),after); p+=strlen(after); }
  }
  void trim() {
    auto p=find_first_not_of(" \r\n\t"); if(p==npos) { clear(); return; }
    erase(0,p); erase(find_last_not_of(" \r\n\t")+1);
  }
  long toInt() const { return strtol(c_str(),nullptr,10); }
  float toFloat() const { return strtof(c_str(),nullptr); }
  void toCharArray(char* p,size_t n) const { snprintf(p,n,"%s",c_str()); }
};
