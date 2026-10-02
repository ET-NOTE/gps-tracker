#pragma once
#include <Arduino.h>
#include <SoftwareSerial.h>
#include "ShieldParsing.h"

// Educational blocking driver: UNO R3 + tested SIM7080G shield pin mapping.
// No OLED, heap String, automatic power cycling, HTTP fallback or raw secret logs.
class ShieldModem {
public:
  ShieldModem(): uart(8,9) {}
  bool begin();
  bool command(const __FlashStringHelper *text,uint32_t timeout=3000);
  void bridge(); // Certificate installer / local AT console, never concurrent with sensor reads.
  void status();
  bool gnssPower(bool on);
  bool readFix(shield_example::Fix &fix);
  bool connectNetwork(const char *apn);
  uint32_t utcNow();
  // CA file must first be installed with tools/install_ca.py. Returns HTTP code or -1.
  int post(const char *host,const char *path,const char *key,const char *ca,const char *body);
  int signal=99,registration=-1;
private:
  SoftwareSerial uart;
  char line[224];
  uint8_t length=0,reply=0;
  bool overflow=false,restarted=false,sim=false,pdp=false,fixSeen=false;
  uint32_t received=0,clock=0;
  int ntp=-1,http=-1,state=-1;
  shield_example::Fix latest{};
  void drain(uint32_t ms);
  void receive();
  void parse();
  bool wait(uint32_t timeout);
  bool commandRam(const char *text,uint32_t timeout=3000);
  bool closeHttp();
  bool syncClock();
};
