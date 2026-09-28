#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include <deque>
#include <vector>

#define ARDUINO_AVR_UNO 1
#define HIGH 1
#define LOW 0
#define OUTPUT 1
#define A0 0
#define HEX 16
#define PSTR(x) x
#define snprintf_P snprintf
#define strcpy_P strcpy
struct __FlashStringHelper {};
#define F(x) reinterpret_cast<const __FlashStringHelper *>(x)
inline uint32_t fakeMillis=10000;
inline uint32_t millis() { fakeMillis+=5; return fakeMillis; }
inline void pinMode(int,int) {}
inline void digitalWrite(int,int) {}
inline int analogRead(int) { return 429; }

class Print {
public:
  std::string output;
  std::deque<char> input;
  virtual ~Print() = default;
  virtual size_t write(uint8_t c) { output.push_back((char)c); return 1; }
  void print(const char *s) { while(*s) write((uint8_t)*s++); }
  void print(char *s) { print((const char *)s); }
  void print(const __FlashStringHelper *s) { print(reinterpret_cast<const char *>(s)); }
  void print(char c) { write((uint8_t)c); }
  template<typename T> void print(T n) { print(std::to_string(n).c_str()); }
  void println() { print('\n'); }
  template<typename T> void println(T value) { print(value); println(); }
  template<typename T> void println(T value,int) { println(value); }
  void begin(unsigned long) {}
  int available() { return (int)input.size(); }
  int read() { if(input.empty()) return -1; const char c=input.front(); input.pop_front(); return c; }
};
inline Print Serial;
