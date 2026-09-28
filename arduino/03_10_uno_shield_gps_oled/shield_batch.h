#pragma once
#include "shield_policy.h"

namespace shield {
// Fixed-point coordinates avoid AVR float precision loss and JSON float printing.
inline int32_t coordinateE6(const char *text) {
  const bool negative = *text == '-';
  if (negative) ++text;
  int32_t value = 0;
  while (*text && *text != '.') value = value * 10 + (*text++ - '0');
  if (*text == '.') ++text;
  for (uint8_t i = 0; i < 6; ++i) {
    value *= 10;
    if (*text) value += *text++ - '0';
  }
  return negative ? -value : value;
}

// Called only after validUtc. Seconds are GNSS measurement time, not POST time.
inline uint32_t utcSeconds(const char *text) {
  const uint16_t year = twoDigits(text) * 100U + twoDigits(text + 2);
  if (year < 2020 || year > 2099 || twoDigits(text + 12) > 59) return 0;
  uint32_t days = 0;
  for (uint16_t y = 1970; y < year; ++y)
    days += (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)) ? 366 : 365;
  const uint8_t month = twoDigits(text + 4);
  for (uint8_t m = 1; m < month; ++m)
    days += m == 2 ? (year % 4 == 0 ? 29 : 28) :
      (m == 4 || m == 6 || m == 9 || m == 11 ? 30 : 31);
  days += twoDigits(text + 6) - 1;
  return ((days * 24 + twoDigits(text + 8)) * 60 + twoDigits(text + 10)) * 60 + twoDigits(text + 12);
}

struct BatchPoint {
  uint32_t utc_s, captured_ms;
  int32_t lat_e6, lng_e6;
  uint8_t sat_view;
};

class Batch {
 public:
  static const uint8_t CAPACITY = 8;
  BatchPoint points[CAPACITY];
  uint8_t count = 0;
  uint32_t lastSampleUtc = 0;

  void prune(uint32_t now) {
    uint8_t kept = 0;
    for (uint8_t i = 0; i < count; ++i)
      if (!due(now, points[i].captured_ms, 600000UL)) points[kept++] = points[i];
    count = kept;
  }
  bool add(const char *lat, const char *lng, const char *utc, uint8_t sat, uint32_t now) {
    const uint32_t seconds = utcSeconds(utc);
    if (!seconds || seconds <= lastSampleUtc || seconds - lastSampleUtc < 10) return false;
    prune(now);
    if (count == CAPACITY) {
      for (uint8_t i = 1; i < count; ++i) points[i - 1] = points[i];
      --count;
    }
    points[count++] = {seconds, now, coordinateE6(lat), coordinateE6(lng), sat};
    lastSampleUtc = seconds;
    return true;
  }
  // A failed/uncertain POST keeps the same UTC keys for server-side deduplication.
  void acknowledge() { count = 0; }
};
} // namespace shield
