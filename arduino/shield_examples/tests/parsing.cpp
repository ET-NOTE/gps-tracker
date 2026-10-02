#include "../common/ShieldParsing.h"
#include <assert.h>
#include <stdio.h>
int main() {
  using namespace shield_example;
  assert(epoch(2026,10,2,0,0,0)==1790899200UL);
  assert(clockEpoch("26/10/02,09:00:00+36")==1790899200UL);
  assert(clockEpoch("26/10/01,19:00:00-20")==1790899200UL);
  assert(!clockEpoch("26/10/02,09:00:00+99"));
  assert(!clockEpoch("26/02/29,09:00:00+36"));
  assert(epoch(2024,2,29,0,0,0));assert(!epoch(2026,4,31,0,0,0));
  assert(!epoch(2026,10,2,0,0,60));assert(!clockEpoch("26/10/02"));
  assert(safeToken("my-shield-01",40));assert(!safeToken("YOUR_DEVICE_ID",40));
  assert(!safeToken("uid\"\rAT",40));assert(!hexKey("YOUR_KEY"));
  assert(hexKey("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  assert(!decimal("NaN",-90,90));assert(!decimal("+37",-90,90));
  assert(!decimal("91",-90,90));assert(decimal("-37.123456",-90,90));
  Fix fix{};
  char good[]="1,1,20261002000000.000,37.123456,127.123456,0,0,0,1,,1.2,1,1,,8,99";
  assert(gnss(good,fix));assert(fix.at==1790899200UL&&fix.satellites==8);
  assert(!strcmp(fix.lat,"37.123456"));
  char nofix[]="1,0,20261002000000.000,37,127,0,0,0,1,,1.2,1,1,,8";
  char sparse[]="1,1,20261002000000.000,37,127,0,0,0,1,,1.2,1,1,,3,99";
  char badhdop[]="1,1,20261002000000.000,37,127,0,0,0,1,,9.0,1,1,,8";
  char truncated[]="1,1,20261002000000.000,37,127";
  char badutc[]="1,1,20260230000000.000,37,127,0,0,0,1,,1.0,1,1,,8";
  assert(!gnss(nofix,fix));assert(!gnss(sparse,fix));assert(!gnss(badhdop,fix));
  assert(!gnss(truncated,fix));assert(!gnss(badutc,fix));
  puts("UTC / timezone / GNSS / placeholder validation passed");
}
