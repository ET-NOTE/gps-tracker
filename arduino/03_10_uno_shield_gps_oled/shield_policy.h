#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

namespace shield {
const uint32_t POST_INTERVAL_MS = 60000UL;
const uint32_t FIX_FRESH_MS = 15000UL;
const uint32_t MAX_SEND_AGE_MS = 60000UL;

inline bool due(uint32_t now, uint32_t since, uint32_t interval) {
  return (uint32_t)(now - since) >= interval;
}

inline uint32_t retryDelay(uint8_t failures) {
  if (failures < 2) return 15000UL;
  if (failures == 2) return 30000UL;
  if (failures == 3) return 60000UL;
  return 120000UL;
}

// Only JSON-compatible decimal numbers: no NaN, exponent, trailing junk or +.
inline bool decimalInRange(const char *text, double lo, double hi) {
  const char *p = text;
  if (*p == '-') ++p;
  if (*p < '0' || *p > '9') return false;
  if (*p == '0' && p[1] >= '0' && p[1] <= '9') return false;
  while (*p >= '0' && *p <= '9') ++p;
  if (*p == '.') {
    ++p;
    if (*p < '0' || *p > '9') return false;
    while (*p >= '0' && *p <= '9') ++p;
  }
  if (*p) return false;
  const double value = atof(text);
  return value >= lo && value <= hi;
}

inline unsigned twoDigits(const char *p) {
  return (unsigned)(p[0] - '0') * 10U + (unsigned)(p[1] - '0');
}

inline bool validUtc(const char *utc) {
  const size_t n = strlen(utc);
  if (n != 14 && n != 18) return false;
  for (size_t i = 0; i < n; ++i) {
    if (i == 14) { if (utc[i] != '.') return false; }
    else if (utc[i] < '0' || utc[i] > '9') return false;
  }
  const unsigned year = twoDigits(utc) * 100U + twoDigits(utc + 2);
  const unsigned month = twoDigits(utc + 4), day = twoDigits(utc + 6);
  if (year < 2020 || month < 1 || month > 12 || day < 1 ||
      twoDigits(utc + 8) > 23 || twoDigits(utc + 10) > 59 ||
      twoDigits(utc + 12) > 60) return false;
  const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  const unsigned days = month == 2 ? (leap ? 29 : 28) :
      (month == 4 || month == 6 || month == 9 || month == 11 ? 30 : 31);
  return day <= days;
}

inline bool usableFix(const char *lat, const char *lng, const char *utc,
                      const char *hdop, int satellitesView) {
  return decimalInRange(lat, -90.0, 90.0) &&
      decimalInRange(lng, -180.0, 180.0) && validUtc(utc) &&
      decimalInRange(hdop, 0.1, 5.0) && satellitesView >= 4;
}
} // namespace shield
