#pragma once
#include <Arduino.h>
#include <EEPROM.h>
#include "ShieldParsing.h"

// UNO EEPROM 768..896 only. Re-uploading the sketch preserves these bytes.
// This storage is not encrypted: do not share EEPROM dumps or a registered board.
struct Enrollment {
  char uid[44], key[65], code[17];
  static const int address = 768;

  bool valid() const {
    if (uid[43] || key[64] || code[16] || strncmp(uid, "uno-shield-", 11)) return false;
    for (uint8_t i = 11; i < 43; ++i) if (!hex(uid[i])) return false;
    for (uint8_t i = 0; i < 16; ++i) if (!hex(code[i])) return false;
    return shield_example::hexKey(key);
  }
  static bool hex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }
  uint16_t checksum() const {
    uint16_t crc = 0xffff;
    const uint8_t *bytes = reinterpret_cast<const uint8_t *>(this);
    for (uint8_t i = 0; i < sizeof(Enrollment); ++i) {
      crc ^= bytes[i];
      for (uint8_t bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ ((crc & 1) ? 0xa001 : 0);
    }
    return crc;
  }
  bool load() {
    if (EEPROM.read(address) != 0xa7) return false;
    EEPROM.get(address + 1, *this);
    uint16_t stored; EEPROM.get(address + 1 + sizeof(Enrollment), stored);
    return valid() && checksum() == stored;
  }
  void clear() { EEPROM.update(address, 0); memset(this, 0, sizeof(*this)); }
  bool saveResponse(const char *body) {
    if (strlen(body) != 126 || body[43] != '\n' || body[108] != '\n' || body[125] != '\n') return false;
    memcpy(uid, body, 43); uid[43] = 0;
    memcpy(key, body + 44, 64); key[64] = 0;
    memcpy(code, body + 109, 16); code[16] = 0;
    if (!valid()) { memset(this, 0, sizeof(*this)); return false; }
    EEPROM.update(address, 0); // Invalidate before writing; validity marker is last.
    EEPROM.put(address + 1, *this);
    uint16_t crc = checksum(); EEPROM.put(address + 1 + sizeof(Enrollment), crc);
    EEPROM.update(address, 0xa7);
    return true;
  }
};
static_assert(sizeof(Enrollment) == 126, "Enrollment wire/storage layout changed");
