// Factory provisioning only. Restore the application after CA/HTTPS validation.
// PC 115200 -> SIM7080G 9600; the PC must pace transmitted bytes at >=2 ms.
#include <Arduino.h>
#include <SoftwareSerial.h>
SoftwareSerial modem(8, 9);
void setup() {
  digitalWrite(7, LOW); pinMode(7, OUTPUT); // release NPN PWRKEY; never pulse it
  digitalWrite(6, HIGH); pinMode(6, OUTPUT);
  Serial.begin(115200); modem.begin(9600);
  Serial.println(F("SHIELD_TLS_PROVISION_BRIDGE_V1"));
}
void loop() {
  if(modem.available()) Serial.write(modem.read());
  if(Serial.available()) modem.write(Serial.read());
}
