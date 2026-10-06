#pragma once
#include <array>
#include <stdexcept>
struct FakeEEPROM {
  std::array<unsigned char, 1024> bytes;
  int writes = 0, failAfter = -1;
  FakeEEPROM() { bytes.fill(0xff); }
  unsigned char read(int address) { return bytes.at(address); }
  void update(int address, unsigned char value) {
    if (failAfter >= 0 && writes++ == failAfter) throw std::runtime_error("power loss");
    bytes.at(address) = value;
  }
  template<class T> void get(int address, T &value) { memcpy(&value, bytes.data() + address, sizeof(T)); }
  template<class T> void put(int address, const T &value) {
    const unsigned char *p = reinterpret_cast<const unsigned char *>(&value);
    for (size_t i = 0; i < sizeof(T); ++i) update(address + i, p[i]);
  }
};
extern FakeEEPROM EEPROM;
