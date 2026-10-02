#include "src/ShieldModem.h"
ShieldModem shield;
uint32_t previousUtc=0;
void setup() {
  Serial.begin(115200);
  if(!shield.begin()||!shield.gnssPower(true)) {
    Serial.println(F("[STOP] GNSS start failed. Check power, then reset UNO."));while(true)delay(1000);
  }
  Serial.println(F("[GNSS] Keep GNSS antenna facing open sky. First fix can take several minutes."));
}
void loop() {
  shield_example::Fix fix;
  if(shield.readFix(fix)&&fix.at>previousUtc) {
    previousUtc=fix.at;
    Serial.print(F("UTC seconds="));Serial.print(fix.at);
    Serial.print(F(" lat="));Serial.print(fix.lat);Serial.print(F(" lng="));Serial.print(fix.lng);
    Serial.print(F(" satellites_in_view="));Serial.println(fix.satellites);
  } else Serial.println(F("[GNSS] No new qualified fix (fix/UTC/HDOP/satellites). Keep antenna still."));
  delay(5000); // Local GNSS demonstration; does not send coordinates to any server.
}
