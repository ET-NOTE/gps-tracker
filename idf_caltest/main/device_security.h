#pragma once
#include <Arduino.h>
namespace device_security {
void begin();
void poll();
bool enabled();
bool linkRequired();
bool prepare(const char *body, String &wireBody, uint64_t &counter, char signature[65]);
const char *uid();
bool response(const String &raw, uint64_t counter, String &decoded);
bool acceptCommand(const String &decoded);
}
