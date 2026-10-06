#pragma once
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <string>
#define PROGMEM
#define F(s) reinterpret_cast<const __FlashStringHelper *>(s)
#define PSTR(s) s
#define LOW 0
#define HIGH 1
#define OUTPUT 1
#define snprintf_P snprintf
inline unsigned char pgm_read_byte(const void *p) { return *static_cast<const unsigned char *>(p); }
struct __FlashStringHelper;
extern uint32_t fakeMillis;
inline uint32_t millis() { return fakeMillis++; }
inline void delay(uint32_t ms) { fakeMillis += ms; }
inline void digitalWrite(int, int) {}
inline void pinMode(int, int) {}
struct Console {
  std::string text;
  void begin(unsigned long) {}
  void print(const __FlashStringHelper *s) { text += reinterpret_cast<const char *>(s); }
  void print(const char *s) { text += s; }
  void print(int n) { text += std::to_string(n); }
  template<class T> void println(T value) { print(value); text += '\n'; }
};
extern Console Serial;
