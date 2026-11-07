#pragma once
#include <HardwareSerial.h>
#include <stdint.h>
// SIM7080 manual receive mode. Binary payload length is authoritative; never
// search TLS record bytes for AT tokens or feed them through String/drain().
class ModemTcp {
 public:
  explicit ModemTcp(HardwareSerial &serial) : serial_(serial) {}
  bool open(const char *host,unsigned port);
  void close();
  int send(const unsigned char*,size_t);
  int receive(unsigned char*,size_t);
 private:
  int byte(uint32_t start,uint32_t timeout);
  bool line(char*,size_t,uint32_t,uint32_t);
  bool ok(uint32_t,uint32_t);
  bool command(const char*);
  HardwareSerial &serial_;
  bool opened_=false;
};
