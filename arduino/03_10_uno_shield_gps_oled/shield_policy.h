#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

namespace shield {
const uint32_t POST_INTERVAL_MS = 60000UL;
// Give a cold/weak-signal acquisition an uninterrupted, bounded window.
const uint32_t GNSS_ACQUIRE_MS = 600000UL;
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

inline bool reportDue(uint32_t now, uint32_t lastPost, uint32_t delay,
                      uint8_t failures, bool gnssOn, bool freshFix) {
  if (!due(now, lastPost, delay)) return false;
  return failures || !gnssOn || freshFix || due(now, lastPost, GNSS_ACQUIRE_MS);
}

// Never accept a truncated coordinate or turn malformed/overflowing SV into a count.
inline bool copyField(char *dest, size_t capacity, const char *src) {
  if (strlen(src) >= capacity) { dest[0] = 0; return false; }
  strcpy(dest, src);
  return true;
}
inline int8_t satelliteCount(const char *text) {
  const size_t n = strlen(text);
  if (n < 1 || n > 2) return -1;
  int value = 0;
  for (size_t i = 0; i < n; ++i) {
    if (text[i] < '0' || text[i] > '9') return -1;
    value = value * 10 + text[i] - '0';
  }
  return (int8_t)value;
}

// Stable diagnostic codes carried as diag.gnss; no raw coordinates/identifiers.
enum GnssState : uint8_t {
  GNSS_NO_REPLY, GNSS_OFF, GNSS_NO_FIX, GNSS_NO_FIX_STATUS,
  GNSS_BAD_FIELDS, GNSS_BAD_COORD, GNSS_BAD_UTC, GNSS_BAD_HDOP,
  GNSS_BAD_SV, GNSS_STALE, GNSS_READY
};

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

} // namespace shield
