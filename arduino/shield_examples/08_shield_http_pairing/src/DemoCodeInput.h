#pragma once
#include "ShieldHttp.h"

// Bounded serial line parser. Never logs or persists the classroom bearer code.
class DemoCodeInput {
public:
  // 0 = incomplete/empty line, 1 = accepted, -1 = rejected whole line.
  int feed(char c, char (&destination)[38]) {
    if (c == '\r' || c == '\n') {
      if (!length && !discard) return 0;
      int result = !discard && shield_http_example::validUid(line) ? 1 : -1;
      if (result == 1) memcpy(destination, line, sizeof(line));
      memset(line, 0, sizeof(line)); length = 0; discard = false;
      return result;
    }
    if (length >= sizeof(line) - 1 || c < 32 || c > 126) discard = true;
    if (!discard) { line[length++] = c; line[length] = 0; }
    return 0;
  }
private:
  char line[38] = {};
  uint8_t length = 0;
  bool discard = false;
};
