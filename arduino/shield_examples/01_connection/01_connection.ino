// UNO R3 + SIM7080G: modem check, then transparent AT / certificate installer bridge.
#include "src/ShieldModem.h"
ShieldModem shield;
void setup() {
  Serial.begin(115200);
  if(!shield.begin()) { while(true) delay(1000); }
  shield.status();
  Serial.println(F("[READY] AT bridge: 115200 USB / 9600 modem. Select Both NL & CR."));
  Serial.println(F("CEREG 1/5=registered, CSQ 99=unknown. No HTTP request was sent."));
}
void loop() { shield.bridge(); }
