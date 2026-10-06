#pragma once
#include "Arduino.h"
#include <deque>
#include <functional>
struct Wire {
  std::deque<unsigned char> rx;
  std::string pending, data;
  size_t remaining = 0;
  std::function<void(const std::string&)> command;
  std::function<void(const std::string&)> dataDone;
  void answer(const std::string &s) { for (unsigned char c : s) rx.push_back(c); }
  void send(unsigned char c) {
    if (remaining) {
      data += static_cast<char>(c);
      if (!--remaining) { auto copied = data; data.clear(); dataDone(copied); }
    } else if (c == '\r') { auto copied = pending; pending.clear(); command(copied); }
    else pending += static_cast<char>(c);
  }
};
extern Wire wire;
class SoftwareSerial {
public:
  SoftwareSerial(int, int) {}
  void begin(uint32_t) {}
  void end() {}
  int available() { return !wire.rx.empty(); }
  int read() { auto c=wire.rx.front(); wire.rx.pop_front(); return c; }
  void write(unsigned char c) { wire.send(c); }
  void print(char c) { write(c); }
  void print(const char *s) { while (*s) write(*s++); }
  void print(const __FlashStringHelper *s) { print(reinterpret_cast<const char *>(s)); }
  void print(size_t n) { print(std::to_string(n).c_str()); }
};
