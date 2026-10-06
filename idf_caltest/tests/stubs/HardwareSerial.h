#pragma once
#include "Arduino.h"
class HardwareSerial {
 public:
  explicit HardwareSerial(int) {}
  void setRxBufferSize(int) {}
  void begin(int,int,int,int) {}
  int available();
  int read();
  void print(const char*);
  void write(const uint8_t*,size_t) {}
};
