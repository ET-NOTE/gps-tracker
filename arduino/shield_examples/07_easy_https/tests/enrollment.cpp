#include "Enrollment.h"
#include <cassert>
#include <iostream>
FakeEEPROM EEPROM;
const std::string response = "uno-shield-" + std::string(32, 'a') + "\n" + std::string(64, 'b') + "\n" + std::string(16, 'c') + "\n";
int main() {
  Enrollment e{}; assert(!e.load());
  assert(e.saveResponse(response.c_str()));
  Enrollment restart{}; assert(restart.load() && !strcmp(restart.uid, e.uid));
  for (int i = 0; i < 1024; ++i) if (i < 768 || i > 896) assert(EEPROM.bytes[i] == 0xff);
  for (int cut = 0; cut < 130; ++cut) {
    EEPROM = FakeEEPROM{}; EEPROM.failAfter = cut;
    try { e.saveResponse(response.c_str()); } catch (const std::runtime_error &) {}
    Enrollment after{};
    assert(after.load() == (cut >= 130));
  }
  EEPROM = FakeEEPROM{}; assert(e.saveResponse(response.c_str()));
  auto saved = EEPROM.bytes;
  for (int i = 769; i <= 896; ++i) {
    EEPROM.bytes = saved; EEPROM.bytes[i] ^= 1;
    Enrollment damaged{}; assert(!damaged.load());
  }
  EEPROM.bytes = saved; e.clear(); assert(!restart.load());
  assert(!e.saveResponse("short"));
  std::string bad = response; bad[44] = 'X'; assert(!e.saveResponse(bad.c_str()));
  std::cout << "EEPROM: persistence, 130 interrupted writes, 128 corruptions, format and bounded erase passed.\n";
}
