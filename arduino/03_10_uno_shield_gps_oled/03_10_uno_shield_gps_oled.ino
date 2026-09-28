// GPS/OLED extension: default SSD1306 128x64; A4=SDA, A5=SCL.
// A0 senses PV, not BAT+. See README for battery estimation and calibration.
// Qualified GNSS fixes and periodic health reports use the existing test UID.
// =====================================================================
// 03_10_uno_shield_gps_oled — UNO R3 + SIM7080G 쉴드 검사 + GPS/OLED/배터리 표시
//   (03_8 기반 HW팀 확장판, 2026-09-23 feedback 흡수. PWRKEY 회로 정정:
//    D7→T2(NPN)→PWRKEY, idle LOW 필수 — HIGH 유지 시 12.6s 주기 강제 리셋)
//
// 배선: D8 <- 모뎀 TX, D9 -> 모뎀 RX, D6 -> DTR, D7 -> PWRKEY (레벨변환 필수)
// 전원: 모뎀은 반드시 별도 3.3~4.2V / 500mA 이상 + UNO 와 GND 공통
//       (UNO 3.3V 핀 분배 금지 — 한도 50mA 라 모뎀 송신 순간 전원 붕괴 실측됨)
// 모니터: 115200 baud
//
// 검사 흐름(자동): [1/5] 모뎀 통신 → [2/5] 초기 설정 → [3/5] 유심 →
//                 [4/5] 망 등록 → [5/5] 서버 전송(gps.serial.kr, HTTP 200 판정)
// 실패 시 해당 단계에서 점검 힌트를 출력하고 자동 재시도한다.
//
// ※ 서버 전송은 device_uid="uno-shield-test" 로만 보내고 유심 번호(ICCID)는
//   싣지 않는다 → 운영 단말 데이터와 절대 섞이지 않음.
// =====================================================================
#include <Arduino.h>
#include <SoftwareSerial.h>
#include <string.h>
#include <Wire.h>
#include <U8x8lib.h>
#include "shield_policy.h"

#ifndef SHIELD_DIAGNOSTICS
#define SHIELD_DIAGNOSTICS 0
#endif
#if SHIELD_DIAGNOSTICS != 0 && SHIELD_DIAGNOSTICS != 1
#error "SHIELD_DIAGNOSTICS must be 0 or 1."
#endif
#if SHIELD_DIAGNOSTICS
#define SHIELD_BUILD_TAG "shield-opt-20260928-v10-dbg"
#else
#define SHIELD_BUILD_TAG "shield-opt-20260928-v10"
#endif

#if !defined(ARDUINO_AVR_UNO)
#error "Select Arduino UNO (arduino:avr:uno)."
#endif

const uint8_t PIN_DTR = 6;
const uint8_t PIN_PWRKEY = 7;
// idf_caltest 신PCB 와 동일한 NPN 드라이버 기준. 직결(active-LOW) 쉴드는 false 로.
const bool PWRKEY_ACTIVE_HIGH = true;
// 확인한 회로: D7 -> SREG -> T2(NPN) -> SIM7080G PWRKEY.
// D7 LOW = PWRKEY 해제, HIGH = PWRKEY 누름. HIGH를 계속 유지하지 않는다.
// AT/통신 속도 탐색이 모두 실패했을 때만 기존 1.5초 펄스를 보낸다.
const bool PWRKEY_PULSE_ENABLED = true;
const uint32_t MODEM_BAUD = 9600;
SoftwareSerial modem(8, 9);  // (UNO RX, UNO TX)

char line[220]; // CGNSINF contains a long CSV response including empty fields.
uint8_t lineLength = 0;
bool discardLine = false;
uint8_t reply = 0;              // 0=대기, 1=OK, 2=ERROR
bool simReady = false, pdpActive = false;
uint32_t modemReboots = 0;
int rssi = 99, regStat = -1, httpStatus = -1;
uint8_t stage = 1;              // 1~5 진행, 6=주기 전송/재시도 대기
uint32_t lastPollMs = 0, lastNoteMs = 0, regStartMs = 0;
uint32_t lastPostMs = 0, postDelayMs = shield::POST_INTERVAL_MS;
uint8_t postFailures = 0;
uint32_t acquisitionMs = shield::GNSS_ACQUIRE_MS;
int8_t httpState = -1;          // -1=unknown, 0=confirmed closed, 1=open

// ===== User settings =====
// Default: SSD1306 128x64 I2C OLED. For SH1106 set OLED_SH1106 to 1.
#define OLED_SH1106 0
#if OLED_SH1106
U8X8_SH1106_128X64_NONAME_HW_I2C oled(U8X8_PIN_NONE);
#else
U8X8_SSD1306_128X64_NONAME_HW_I2C oled(U8X8_PIN_NONE);
#endif
// A0 = PV * R6/(R22+R6); schematic R22=100k, R6=100k, C6=1uF.
const uint16_t ADC_REFERENCE_MV = 5000; // Calibrate to measured UNO AVcc/5V.
const uint32_t R_TOP_OHM = 100000UL, R_BOTTOM_OHM = 100000UL;
// Enabled for the user-confirmed nominal 3.7V single-cell Li-ion battery, battery-only operation. // Requires PV supply through JP3,
// with USB/external PV supply disconnected. A0 does NOT directly sense BAT+.
const bool BATTERY_ONLY_1S_LIION = true;
// Existing test endpoint/APN/UID retained; never send ICCID or a fixture VBAT.
bool oledReady=false, gnssEnabled=false, gnssFix=false, gnssSeen=false;
bool restartPending=false;
#if SHIELD_DIAGNOSTICS
bool radioRestorePending=false; // Manual RF test: clear only after confirmed CFUN=1.
bool traceNetwork=false;
#endif
uint16_t pvMv=0;
int8_t satellitesView=-1;
int8_t gnssRawFix=-1;
shield::GnssState gnssState=shield::GNSS_NO_REPLY;
uint32_t gnssStamp=0, gnssPoll=0, uiStamp=0, batteryStamp=0;
uint32_t positionStamp=0;
char latitude[13]="", longitude[14]="", utc[19]="", hdop[7]="";
char lastPositionUtc[19]=""; // Preserve across empty/error replies; they cannot refresh old fixes.
static void receiveLines();
static uint8_t command(const __FlashStringHelper *cmd, uint32_t timeout);
static void serviceUi();
static void serviceGnss();
static void parseGnss(char *csv);
static void initDisplay();

// Splits CSV in place, preserving empty fields (strtok would lose them).
static void parseGnss(char *csv) {
  while (*csv==' ') ++csv;
  gnssFix=false; satellitesView=-1; gnssRawFix=-1;
  latitude[0]=longitude[0]=utc[0]=hdop[0]='\0';
  uint8_t index=0; bool running=false, fieldsValid=true;
  char *field=csv;
  for (;;) {
    char *comma=strchr(field, ',');
    if (comma) *comma='\0';
    if(index==0) { running=!strcmp(field,"1"); fieldsValid=running || !strcmp(field,"0"); }
    if(index==1) gnssRawFix=!strcmp(field,"1") ? 1 : (!strcmp(field,"0") ? 0 : -1);
    if(index==2) fieldsValid=shield::copyField(utc,sizeof(utc),field) && fieldsValid;
    if(index==3) fieldsValid=shield::copyField(latitude,sizeof(latitude),field) && fieldsValid;
    if(index==4) fieldsValid=shield::copyField(longitude,sizeof(longitude),field) && fieldsValid;
    if(index==10) fieldsValid=shield::copyField(hdop,sizeof(hdop),field) && fieldsValid;
    if(index==14) satellitesView=shield::satelliteCount(field);
    // CGNSINF field 15 (zero-based) is reserved, NOT satellites used.
    if(!comma) break;
    field=comma+1; ++index;
  }
  gnssEnabled=running;
  if(!fieldsValid || (running && index<14)) gnssState=shield::GNSS_BAD_FIELDS;
  else if(!running) gnssState=shield::GNSS_OFF;
  else if(gnssRawFix<0) gnssState=shield::GNSS_NO_FIX_STATUS;
  else if(!gnssRawFix) gnssState=shield::GNSS_NO_FIX;
  else if(!shield::decimalInRange(latitude,-90,90) || !shield::decimalInRange(longitude,-180,180)) gnssState=shield::GNSS_BAD_COORD;
  else if(!shield::validUtc(utc)) gnssState=shield::GNSS_BAD_UTC;
  else if(!shield::decimalInRange(hdop,0.1,5.0)) gnssState=shield::GNSS_BAD_HDOP;
  else if(satellitesView<4) gnssState=shield::GNSS_BAD_SV;
  else {
    if(strcmp(lastPositionUtc,utc)) { strcpy(lastPositionUtc,utc); positionStamp=millis(); }
    gnssState=shield::due(millis(),positionStamp,shield::FIX_FRESH_MS) ? shield::GNSS_STALE : shield::GNSS_READY;
  }
  gnssFix=gnssState==shield::GNSS_READY;
  gnssSeen=true; gnssStamp=millis();
}

#if SHIELD_DIAGNOSTICS
static const __FlashStringHelper *gnssReason() {
  switch(gnssState) {
    case shield::GNSS_OFF: return F("POWER_OFF");
    case shield::GNSS_NO_FIX: return F("NO_FIX");
    case shield::GNSS_NO_FIX_STATUS: return F("NO_FIX_STATUS");
    case shield::GNSS_BAD_FIELDS: return F("BAD_FIELDS");
    case shield::GNSS_BAD_COORD: return F("BAD_COORD");
    case shield::GNSS_BAD_UTC: return F("BAD_UTC");
    case shield::GNSS_BAD_HDOP: return F("BAD_HDOP");
    case shield::GNSS_BAD_SV: return F("BAD_SV");
    case shield::GNSS_STALE: return F("STALE_UTC");
    case shield::GNSS_READY: return F("READY");
    default: return F("NO_REPLY");
  }
}
#endif

// Rough open-circuit voltage estimate, NOT measured capacity or a fuel gauge.
static int batteryPercent() {
  if(!BATTERY_ONLY_1S_LIION || pvMv<2800 || pvMv>4250) return -1;
  const uint16_t mv[]={3300,3500,3650,3700,3750,3800,3870,3950,4050,4150,4200};
  if(pvMv<=mv[0]) return 0;
  for(uint8_t i=1;i<11;++i) if(pvMv<mv[i])
    return (i-1)*10+(uint32_t)(pvMv-mv[i-1])*10/(mv[i]-mv[i-1]);
  return 100;
}
static void readBattery() {
  uint32_t sum=0;
  analogRead(A0); // discard first reading after mux change
  for(uint8_t i=0;i<16;++i) sum+=analogRead(A0);
  uint32_t pinMv=(sum*ADC_REFERENCE_MV+8184UL)/(16UL*1023UL);
  pvMv=pinMv*(R_TOP_OHM+R_BOTTOM_OHM)/R_BOTTOM_OHM;
}
static void initDisplay() {
  Wire.begin();
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(25000,true);
#endif
  uint8_t address=0;
  for(uint8_t a=0x3C;a<=0x3D;++a) {
    Wire.beginTransmission(a);
    if(Wire.endTransmission()==0) { address=a; break; }
  }
  if(!address) { Serial.println(F("[OLED] 0x3C/0x3D not found; continuing without display.")); return; }
  oled.setI2CAddress(address<<1);
  oled.begin(); oled.setBusClock(100000UL);
  oled.setFont(u8x8_font_chroma48medium8_r); oled.clear();
  oledReady=true;
  Serial.print(F("[OLED] I2C address 0x")); Serial.println(address,HEX);
}
// One 16-character row at a time; no 1024-byte framebuffer on UNO.
static void serviceUi() {
  uint32_t now=millis();
  if(now-batteryStamp>=1000 || batteryStamp==0) { batteryStamp=now; readBattery(); }
  if(!oledReady || now-uiStamp<100 || modem.available() || lineLength) return;
  uiStamp=now; static uint8_t row=0;
  char buf[26]; buf[0]=0;
  bool fresh=gnssSeen && now-gnssStamp<15000UL;
  bool fix=fresh && gnssFix;
  switch(row) {
    case 0: snprintf_P(buf,sizeof(buf),PSTR("SIM7080 S%u R%lu"),stage,(unsigned long)modemReboots); break;
    case 1: snprintf_P(buf,sizeof(buf),PSTR("PV %u.%02uV"),pvMv/1000,(pvMv%1000)/10); break;
    case 2: { int pct=batteryPercent();
      if(pct<0) strcpy_P(buf,PSTR("BAT -- (PV only)"));
      else snprintf_P(buf,sizeof(buf),PSTR("BAT ~%d%% 1S Li"),pct);
      break; }
    case 3: snprintf_P(buf,sizeof(buf),PSTR("NET %d CSQ %d"),regStat,rssi); break;
    case 4:
      if(!gnssEnabled) strcpy_P(buf,PSTR("GPS OFF/ERROR"));
      else if(!fresh) strcpy_P(buf,PSTR("GPS WAIT/STALE"));
      else snprintf_P(buf,sizeof(buf),PSTR("GPS %s SV:%d"),fix?"FIX":"WAIT",satellitesView);
      break;
    case 5: if(fix) snprintf_P(buf,sizeof(buf),PSTR("La:%s"),latitude); else strcpy_P(buf,PSTR("La:--")); break;
    case 6: if(fix) snprintf_P(buf,sizeof(buf),PSTR("Lo:%s"),longitude); else strcpy_P(buf,PSTR("Lo:--")); break;
    case 7:
      if(fix && ((now/4000UL)%2==0)) snprintf_P(buf,sizeof(buf),PSTR("UTC %.2s:%.2s:%.2s"),utc+8,utc+10,utc+12);
      else snprintf_P(buf,sizeof(buf),PSTR("HTTP %d"),httpStatus);
      break;
  }
  uint8_t n=strlen(buf); if(n>16)n=16;
  while(n<16) buf[n++]=' ';
  buf[16]=0;
  oled.drawString(0,row,buf); row=(row+1)%8;
}
static void serviceGnss() {
  if(stage!=6 || restartPending || postFailures || millis()-gnssPoll<5000UL) return;
  gnssPoll=millis();
  if(!gnssEnabled) {
    gnssEnabled=(command(F("AT+CGNSPWR=1"),2000)==1);
    if(!gnssEnabled) { gnssState=shield::GNSS_OFF; Serial.println(F("[GPS] GNSS power command failed; retrying.")); return; }
  }
  gnssSeen=false; gnssFix=false;
  if(command(F("AT+CGNSINF"),2000)!=1 || !gnssSeen) {
    gnssSeen=false; gnssFix=false; gnssState=shield::GNSS_NO_REPLY;
    Serial.println(F("[GPS] No valid CGNSINF reply.")); return;
  }
#if SHIELD_DIAGNOSTICS
  Serial.print(gnssFix?F("[GPS] FIX "):F("[GPS] WAIT "));
  Serial.print(F("reason=")); Serial.print(gnssReason());
  Serial.print(F(" raw_fix=")); Serial.print(gnssRawFix);
  Serial.print(F(" window_s=")); Serial.print((millis()-lastPostMs)/1000UL); Serial.print(' ');
  Serial.print(F("SV=")); Serial.print(satellitesView);
  Serial.print(F(" HDOP=")); Serial.print(hdop[0] ? hdop : "?");
  if(gnssFix) {
    Serial.print(F(" lat=")); Serial.print(latitude);
    Serial.print(F(" lon=")); Serial.print(longitude);
    Serial.print(F(" UTC=")); Serial.print(utc);
  }
  Serial.print(F(" PV=")); Serial.print(pvMv); Serial.println(F("mV"));
#endif
}

// ── 수신/파싱 (화면 출력 없음 — 판정에 필요한 값만 뽑는다) ───────────────
static void receiveLines() {
  while (modem.available()) {
    const char c = (char)modem.read();
    if (c == '\r' || c == '\n') {
      if (!discardLine && lineLength) {
        line[lineLength] = '\0';
#if SHIELD_DIAGNOSTICS
        if(traceNetwork) { Serial.print(F("[NET RX] ")); Serial.println(line); }
#endif
        int a, b;
        if (sscanf(line, "+SHSTATE: %d", &a)==1 && (a==0 || a==1)) httpState=a;
        if (!strncmp(line, "+CGNSINF:", 9)) { parseGnss(line+9); lineLength=0; discardLine=false; continue; }
        if (sscanf(line, "+CNACT: %d,%d", &a, &b)==2 && a==0) {
          const char *ip=strchr(line, '"');
          pdpActive=(b==1 && ip && ip[1] && ip[1]!='"' && strncmp(ip+1,"0.0.0.0\"",8));
        }
        if (sscanf(line, "+CSQ: %d,%d", &a, &b) == 2) rssi = a;
        if (sscanf(line, "+CEREG: %d,%d", &a, &b) == 2) regStat = b;
        if (!strncmp(line, "+SHREQ:", 7)) {
          const char *comma = strchr(line, ',');
          if (comma) httpStatus = atoi(comma + 1);
        }
        if (!strcmp(line, "+APP PDP: 0,DEACTIVE")) pdpActive = false;
        if (!strncmp(line, "+CPIN:", 6)) {
          const char *v = line + 6;
          while (*v == ' ') ++v;
          simReady = !strcmp(v, "READY");
        }
        if (!strcmp(line, "OK")) reply = 1;
        else if (!strcmp(line, "ERROR") || !strncmp(line, "+CME ERROR:", 11) ||
                 !strncmp(line, "+CMS ERROR:", 11)) {
          reply = 2;
          Serial.print(F("[AT ERROR] ")); Serial.println(line);
        }
        if (!strcmp(line, "RDY")) {   // 시작 알림 수신. 이 알림만으로 재시작 원인을 판단할 수 없다.
          simReady = false; pdpActive = false;
          ++modemReboots;
          restartPending=true; gnssEnabled=false; gnssSeen=false; gnssFix=false;
          httpState=-1; acquisitionMs=shield::GNSS_ACQUIRE_MS;
          regStat=-1; httpStatus=-1;
          // RDY 반복 수신 시 화면 도배 방지: 경고는 3초당 1회만
          static uint32_t lastWarnMs = 0;
          if (millis() - lastWarnMs < 3000) { lineLength = 0; discardLine = false; continue; }
          lastWarnMs = millis();
          Serial.print(F("[알림] 모뎀 시작 알림 RDY 수신 (누적 "));
          Serial.print(modemReboots);
          Serial.print(F("회, UNO 가동 "));
          Serial.print(millis() / 1000UL);
          Serial.println(F("초) — 반복되면 PWRKEY와 VBAT 확인. RDY만으로 원인 확정 불가"));
        }
      }
      lineLength = 0; discardLine = false;
    } else if (!discardLine) {
      if (lineLength < sizeof(line) - 1) line[lineLength++] = c;
      else discardLine = true;
    }
  }
}

static void listenFor(uint32_t duration) {
  const uint32_t start = millis();
  while (millis() - start < duration) { receiveLines(); serviceUi(); }
}

// AT 명령 전송(화면 출력 없음). 반환 1=OK, 2=ERROR, 0=무응답
static uint8_t command(const __FlashStringHelper *cmd, uint32_t timeout) {
  if(restartPending) return 0;
  listenFor(80);
  if(restartPending) return 0;
  lineLength = 0; discardLine = false; reply = 0;
  modem.print(cmd);
  modem.print('\r');
  const uint32_t start = millis();
  while (millis() - start < timeout) {
    receiveLines();
    if(restartPending) return 0;
    if (reply) {
      if (reply != 1) { Serial.print(F("[AT FAIL] ")); Serial.println(cmd); }
      return reply;
    }
  }
  Serial.print(F("[AT TIMEOUT] ")); Serial.println(cmd);
  listenFor(300);   // 지연 응답 격리 — 다음 명령의 OK 로 오인 방지
  return 0;
}

// ── [1/5] 모뎀 통신 확보 ─────────────────────────────────────────────
static bool tryBaud(uint32_t rate) {
  modem.end(); modem.begin(rate);
  if (command(F("AT"), 1200) != 1) return false;
  if (rate == MODEM_BAUD) return true;
  command(F("AT+IPR=9600"), 1200);
  modem.end(); modem.begin(MODEM_BAUD);
  return command(F("AT"), 1500) == 1;
}

static bool stageModem() {
  Serial.println(F("[1/5] 모뎀 통신 확인 중…"));
  for (uint8_t i = 0; i < 4; ++i) if (command(F("AT"), 900) == 1) {
    Serial.println(F("[1/5] 모뎀 통신: 정상"));
    return true;
  }
  Serial.println(F("[1/5] 응답 없음 — 통신 속도 자동 탐색"));
  const uint32_t rates[] = {9600, 115200, 19200, 38400, 57600};
  for (uint8_t i = 0; i < 5; ++i) if (tryBaud(rates[i])) {
    Serial.println(F("[1/5] 모뎀 통신: 정상 (속도 동기화됨)"));
    return true;
  }
  if (restartPending) return false; // RDY already arrived: do not press PWRKEY again.
  if (!PWRKEY_PULSE_ENABLED) {
    Serial.println(F("[1/5] 여전히 무응답 (설정에 따라 전원 펄스 생략) — 10초 후 재시도"));
    Serial.println(F("[1/5] 점검: ① 모뎀 전원/LED ② 배선(D8<-모뎀TX, D9->모뎀RX) ③ GND 공통"));
    return false;
  }
  Serial.println(F("[1/5] 여전히 무응답 — 전원 스위치(PWRKEY) 신호로 켜는 중… (약 14초)"));
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? LOW : HIGH);
  listenFor(100);
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? HIGH : LOW);
  listenFor(1500);
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? LOW : HIGH);
  const uint32_t start = millis();
  while (millis() - start < 12000UL) {
    receiveLines();
    if (command(F("AT"), 900) == 1) {
      Serial.println(F("[1/5] 모뎀 통신: 정상 (전원 켜짐)"));
      return true;
    }
  }
  for (uint8_t i = 0; i < 5; ++i) if (tryBaud(rates[i])) {
    Serial.println(F("[1/5] 모뎀 통신: 정상 (전원 켜짐 + 속도 동기화)"));
    return true;
  }
  Serial.println(F("[1/5] 실패: 모뎀 무응답 — 점검: ① 모뎀 전원(별도 3.3~4.2V/500mA, GND 공통) ② 배선(D8<-모뎀TX, D9->모뎀RX) ③ 레벨변환 회로. 10초 후 재시도"));
  return false;
}

// ── [2/5] 초기 설정 ─────────────────────────────────────────────────
static void stageConfig() {
  Serial.println(F("[2/5] 모뎀 초기 설정 중…"));
  uint8_t fail = 0;
  if (command(F("ATE0"), 2000) != 1) ++fail;
  if (command(F("AT+IFC=0,0"), 2000) != 1) ++fail;
  if (command(F("AT+IPR=9600"), 2000) != 1) ++fail;
  if (command(F("AT+CMEE=2"), 2000) != 1) ++fail;
  if (command(F("AT+CSCLK=0"), 2000) != 1) ++fail;
  // Register LTE first; do not run GNSS while recovering the radio connection.
  if(command(F("AT+CGNSPWR=0"),3000)==1) gnssEnabled=false;
  // Read configuration only: CGNSMOD writes persist and reboot the module.
#if SHIELD_DIAGNOSTICS
  traceNetwork=true;
  command(F("AT+CGMR"),2000);
  command(F("AT+CGNSMOD?"),2000);
  traceNetwork=false;
#endif
  if (fail == 0) Serial.println(F("[2/5] 초기 설정: 완료"));
  else {
    Serial.print(F("[2/5] 초기 설정: 일부 실패("));
    Serial.print(fail);
    Serial.println(F("건) — 계속 진행. 반복되면 모뎀 재부팅(전원) 여부 확인"));
  }
}

// ── [3/5] 유심 확인 ─────────────────────────────────────────────────
static bool stageSim() {
  if(gnssEnabled) {
    if(command(F("AT+CGNSPWR=0"),3000)!=1) return false;
    gnssEnabled=false; gnssSeen=false; gnssFix=false;
  }
  Serial.println(F("[3/5] 유심(SIM) 확인 중…"));
  simReady = false;
  command(F("AT+CPIN?"), 5000);
  if (!simReady) {
    Serial.println(F("[3/5] 실패: 유심 인식 안 됨 — 점검: ① 유심 장착 방향/접점 ② 모뎀 재부팅 직후면 5초 뒤 재시도됨"));
    return false;
  }
  Serial.println(F("[3/5] 유심 인식: 정상 (PIN 잠금 없음)"));
#if SHIELD_DIAGNOSTICS
  if (command(F("AT+CCID"), 3000) == 1) Serial.println(F("[3/5] 유심 카드번호 조회: 성공"));
  else Serial.println(F("[3/5] 유심 카드번호 조회: 실패 (인식은 정상 — 참고용)"));
#endif
  return true;
}

// ── [4/5] 망 등록 (진입 시 1회 안내, 이후 폴링은 loop 에서) ──────────────
static void pollNetwork() {
  regStat=-1; rssi=99; // Do not keep a stale registration after a failed query.
  command(F("AT+CSQ"), 2000);
  command(F("AT+CEREG?"), 2000);
}

#if SHIELD_DIAGNOSTICS
static void networkDiagnostics() {
  traceNetwork=true;
  Serial.println(F("[NET] registration/attach/GNSS diagnostics"));
  command(F("AT+CGNSPWR?"),2000);
  command(F("AT+CFUN?"),2000);
  command(F("AT+CNMP?"),2000);
  command(F("AT+CMNB?"),2000);
  command(F("AT+COPS?"),2000);
  command(F("AT+CEREG=?"),2000);
  command(F("AT+CEREG?"),2000);
  command(F("AT+CGATT?"),2000);
  command(F("AT+CNACT?"),2000);
  command(F("AT+CEER"),2000);
  traceNetwork=false;
}

static void gnssDiagnostics() {
  traceNetwork=true;
  command(F("AT+CGMR"),2000);
  command(F("AT+CGNSMOD?"),2000);
  command(F("AT+CFUN?"),2000);
  command(F("AT+CGNSPWR?"),2000);
  command(F("AT+CGNSINF"),2000);
  traceNetwork=false;
}

static bool restoreRadio() {
  if(command(F("AT+CGNSPWR=0"),3000)!=1) return false;
  gnssEnabled=false; gnssSeen=false; gnssFix=false;
  if(command(F("AT+CFUN=1"),10000)!=1) return false;
  radioRestorePending=false;
  return true;
}

// Explicit diagnostic key only. No recurring RF resets in the normal scheduler.
static void isolatedGnssTest() {
  if(stage!=6 || restartPending) return;
  Serial.println(F("[GPS TEST] LTE off, GNSS only: up to 180s; LTE restores automatically."));
  if(command(F("AT+CGNSPWR=0"),3000)!=1) return;
  gnssEnabled=false; gnssSeen=false; gnssFix=false;
  radioRestorePending=true; // A timeout may still have disabled RF.
  if(command(F("AT+CFUN=0"),10000)==1 && !restartPending) {
    pdpActive=false; regStat=-1;
    gnssEnabled=command(F("AT+CGNSPWR=1"),3000)==1;
    if(gnssEnabled) {
      postFailures=0; lastPostMs=millis(); gnssPoll=lastPostMs-5000UL;
      gnssDiagnostics();
      const uint32_t start=millis();
      while(!restartPending && !shield::due(millis(),start,180000UL)) {
        receiveLines(); serviceUi(); serviceGnss();
        if(gnssFix && gnssSeen) break;
      }
      Serial.println(gnssFix ? F("[GPS TEST] FIX obtained with LTE off.") : F("[GPS TEST] No qualified fix within 180s."));
    }
  }
  if(!restoreRadio()) Serial.println(F("[GPS TEST] LTE restore pending; automatic retry."));
  stage=1;
}
#endif

// ── [5/5] 서버 전송 시험 ──────────────────────────────────────────────
static bool waitPrompt(uint32_t timeout) {   // AT+SHBOD 의 '>' 프롬프트(개행 없이 도착)
  lineLength=0; discardLine=false; reply=0;
  const uint32_t start = millis();
  while (millis() - start < timeout) {
    // Inspect the byte actually read: it can arrive between peek() and available().
    if (modem.available()) {
      const char c=(char)modem.read();
      if(c=='>') return true;
      if (c=='\r' || c=='\n') {
        line[lineLength]=0;
        if (!strcmp(line,"ERROR") || !strncmp(line,"+CME ERROR:",11) || !strcmp(line,"RDY")) {
          Serial.print(F("[BODY ERROR] ")); Serial.println(line);
          if (!strcmp(line,"RDY")) { restartPending=true; httpState=-1; acquisitionMs=shield::GNSS_ACQUIRE_MS; }
          lineLength=0; return false;
        }
        lineLength=0;
      } else if (lineLength<sizeof(line)-1) line[lineLength++]=c;
    }
  }
  Serial.println(F("[BODY TIMEOUT] SHBOD prompt"));
  return false;
}
static uint8_t waitReply(uint32_t timeout) {
  lineLength = 0; discardLine = false; reply = 0;
  const uint32_t start = millis();
  while (millis() - start < timeout) { receiveLines(); if (restartPending) return 0; if (reply) return reply; }
  return 0;
}
static int buildPayload(char *body, size_t capacity, bool withFix) {
  int n=snprintf_P(body,capacity,PSTR("{\"device_uid\":\"uno-shield-test\",\"build_tag\":\"" SHIELD_BUILD_TAG "\",\"ts\":%lu,\"csq\":%d,\"reg\":%d,\"diag\":{\"pv_mv\":%u,\"gnss\":%u}"),
      (unsigned long)(millis()/1000UL),rssi,regStat,pvMv,(unsigned)gnssState);
  if(n<0 || (size_t)n>=capacity) return -1;
  int tail;
  if(withFix) {
    // Use the LTE source for the modem's internal GNSS (CGNSINF has no used count).
    tail=snprintf_P(body+n,capacity-n,PSTR(",\"lte\":{\"fix\":true,\"lat\":%s,\"lng\":%s,\"sat_view\":%d}}"),latitude,longitude,satellitesView);
  } else tail=snprintf_P(body+n,capacity-n,PSTR(",\"lte\":{\"fix\":false}}"));
  return tail<0 || (size_t)tail>=capacity-n ? -1 : n+tail;
}

// Query only when the modem state is uncertain (boot, timeout, reboot).
// Never resume GNSS or configure a new session until closure is confirmed.
static bool closeHttp() {
  if(httpState<0 && (command(F("AT+SHSTATE?"),2000)!=1 || httpState<0)) return false;
  if(httpState==0) return true;
  httpState=-1; // A timeout may still have closed it; check on the next retry.
  if(command(F("AT+SHDISC"),3000)!=1) return false;
  httpState=0;
  return true;
}

// Called only with GNSS stopped. Every exit is cleaned up by stageServer().
static bool postReport(bool &withFix) {
  Serial.println(F("[5/5] 데이터망 연결 확인"));
  pollNetwork(); // LTE queries/recovery belong to the GNSS-off phase.
  if(regStat!=1 && regStat!=5) return false;
  if(!closeHttp()) return false;
  pdpActive = false;
  command(F("AT+CNACT?"), 3000);
  if (!pdpActive) {
    command(F("AT+CNACT=0,0"), 5000);
    if(command(F("AT+CNCFG=0,1,\"iot.1nce.net\""),3000)!=1) return false;
    command(F("AT+CNACT=0,1"),20000);
    listenFor(1000);
    pdpActive=false;
    command(F("AT+CNACT?"),3000);
    if(!pdpActive) { Serial.println(F("[5/5] PDP 연결 실패")); return false; }
  }
  Serial.println(F("[5/5] 데이터망 연결: 성공"));
  if(command(F("AT+SHCONF=\"URL\",\"http://gps.serial.kr\""),3000)!=1 ||
     command(F("AT+SHCONF=\"BODYLEN\",1024"),2000)!=1 ||
     command(F("AT+SHCONF=\"HEADERLEN\",350"),2000)!=1 ||
     command(F("AT+SHSSL=0"),2000)!=1) return false; // Index 0 accepts no certificate argument.
  Serial.println(F("[5/5] 서버 연결 중…"));
  httpState=-1; // SHCONN may take effect even if its reply times out.
  if(command(F("AT+SHCONN"),30000)!=1) {
#if SHIELD_DIAGNOSTICS
    if(postFailures==0) {
    traceNetwork=true;
    command(F("AT+CGNSPWR?"),2000);
    command(F("AT+CGATT?"),2000);
    command(F("AT+CEREG?"),2000);
    command(F("AT+CNACT?"),2000);
    command(F("AT+SHSTATE?"),2000);
    command(F("AT+CDNSPDPID=0"),2000);
    command(F("AT+CDNSGIP=\"gps.serial.kr\",1,2000"),3000);
    listenFor(5000);
    traceNetwork=false;
    }
#endif
    return false;
  }
  httpState=1;
  if(command(F("AT+SHCHEAD"),2000)!=1 ||
     command(F("AT+SHAHEAD=\"Content-Type\",\"application/json\""),2000)!=1) return false;
  if(restartPending) return false;
  if(withFix && shield::due(millis(),positionStamp,shield::MAX_SEND_AGE_MS)) {
    withFix=false; gnssState=shield::GNSS_STALE;
  }
  char body[256];
  readBattery();
  const int length=buildPayload(body,sizeof(body),withFix);
  if(length<0) { Serial.println(F("[5/5] 본문 크기 초과")); return false; }
#if SHIELD_DIAGNOSTICS && defined(__AVR__)
  extern char __heap_start, *__brkval;
  Serial.print(F("[MEM] HTTP free SRAM="));
  Serial.println((int)(SP-(uintptr_t)(__brkval ? __brkval : &__heap_start)));
#endif
  Serial.println(withFix ? F("[5/5] 위치+상태 전송") : F("[5/5] 상태 전송 (유효한 GPS 없음)"));
  modem.print(F("AT+SHBOD=")); modem.print(length); modem.print(F(",10000\r"));
  if(!waitPrompt(3000)) { listenFor(10500); return false; } // Let data-entry timeout expire.
  modem.print(body);
  if(waitReply(10000)!=1) { Serial.println(F("[5/5] 본문 접수 실패")); return false; }
  if(command(F("AT+SHREQ=\"/ingest\",3"),12000)!=1) return false;
  const uint32_t start=millis();
  while(httpStatus<0 && !restartPending && millis()-start<30000UL) { receiveLines(); serviceUi(); }
  return !restartPending && httpStatus==200;
}

static void stageServer() {
  Serial.println(F("[5/5] 서버 전송 시작 (gps.serial.kr)"));
  httpStatus=-1;
  bool withFix=gnssFix && gnssSeen && !shield::due(millis(),positionStamp,shield::FIX_FRESH_MS);
  // SIM7080G SH* must not run while the internal GNSS owns its resources.
  const bool stopped=command(F("AT+CGNSPWR=0"),3000)==1;
  if(stopped) { gnssEnabled=false; listenFor(300); }
  bool success=stopped && !restartPending && postReport(withFix);
  if(!restartPending) {
    if(stopped) {
      if(!closeHttp()) success=false;
      // A failed connection may leave a stale bearer. Recover before GNSS resumes.
      if(!success) command(F("AT+CNACT=0,0"),5000);
    }
    // Recover failed HTTP while GNSS is off; short retry loops must not chop acquisition.
    if(success) {
      gnssEnabled=command(F("AT+CGNSPWR=1"),3000)==1;
      if(!gnssEnabled) Serial.println(F("[GPS] GNSS 복구 실패; 5초 후 재시도"));
    }
  }
  gnssSeen=false; gnssFix=false; gnssPoll=millis();
  lastPostMs=millis();
  acquisitionMs=success && withFix ? shield::GNSS_REACQUIRE_MS : shield::GNSS_ACQUIRE_MS;
  if(success) {
    postFailures=0; postDelayMs=shield::POST_INTERVAL_MS;
    Serial.print(F("[5/5] 성공: HTTP 200 — GPS 대기 최대 "));
    Serial.print(acquisitionMs/1000UL); Serial.println(F("초, FIX 있으면 60초 주기"));
    Serial.print(F("[GPS] state=")); Serial.print((unsigned)gnssState);
    Serial.print(F(" SV=")); Serial.print(satellitesView);
    Serial.print(F(" PV=")); Serial.print(pvMv); Serial.println(F("mV"));
  } else {
    if(postFailures<4) ++postFailures;
    postDelayMs=shield::retryDelay(postFailures);
    Serial.print(F("[5/5] 실패: HTTP=")); Serial.print(httpStatus);
    Serial.print(F(", 재시도 ")); Serial.print(postDelayMs/1000UL); Serial.println(F("초 후"));
  }
}

// ── 진입점 ───────────────────────────────────────────────────────────
void setup() {
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, HIGH);   // ★HIGH 기본 — LOW 는 모뎀 전원붕괴 순간 UNO 까지 멈춤(실측)
  // 출력 전환 전에 비활성 레벨을 준비한다. 이 보드의 NPN 드라이버에서는 LOW.
  // PWRKEY를 계속 누르면 약 12.6초 후 모뎀이 리셋되므로 평소에는 반드시 해제한다.
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? LOW : HIGH);
  pinMode(PIN_PWRKEY, OUTPUT);
  Serial.begin(115200);
  modem.begin(MODEM_BAUD);
  initDisplay(); readBattery();
  Serial.println();
  Serial.println(F("===== SIM7080G 쉴드 검사 (UNO) — 한글 안내판 ====="));
  Serial.println(F("[BUILD] " SHIELD_BUILD_TAG));
  Serial.println(F("[안내] 자동 순서: 1.모뎀통신 2.초기설정 3.유심 4.망등록 5.서버전송"));
#if SHIELD_DIAGNOSTICS
  Serial.println(F("[안내] 키: r=처음부터 다시, s=유심/망 재확인, p=서버 재시험, g=GPS 조회, 1/0=DTR HIGH/LOW"));
  Serial.println(F("[안내] d=통신 진단, n=무선 기능 재등록 1회"));
  Serial.println(F("[안내] g=GNSS 상세 조회, i=LTE 끄고 GNSS 180초 시험 후 자동 복구"));
#else
  Serial.println(F("[안내] 일반 빌드: 자동 운용, 수동 진단 키 비활성"));
#endif
  Serial.println(F("[안내] 모뎀 전원은 별도 3.3~4.2V 500mA 이상 + GND 공통이어야 함"));
  listenFor(300);
}

void loop() {
  receiveLines();
  if(restartPending) {
    restartPending=false; stage=1; gnssPoll=0;
    httpState=-1; acquisitionMs=shield::GNSS_ACQUIRE_MS;
    Serial.println(F("[RECOVERY] RDY received: restarting modem checks."));
  }
#if SHIELD_DIAGNOSTICS
  if(radioRestorePending) {
    if(restoreRadio()) stage=1;
    else listenFor(10000);
    return;
  }
#endif
  serviceUi();
#if SHIELD_DIAGNOSTICS
  if (Serial.available()) {
    const char key = (char)Serial.read();
    if (key == 'r') { stage = 1; Serial.println(F("[안내] 처음부터 다시 검사")); }
    else if (key == 's') { stage = 3; Serial.println(F("[안내] 유심/망 재확인")); }
    else if (key == 'p') { if(stage>=5) { stageServer(); stage=6; } }
    else if (key == 'g') { gnssDiagnostics(); gnssPoll=millis()-5000UL; }
    else if (key == 'i') { isolatedGnssTest(); }
    else if (key == 'd') { networkDiagnostics(); }
    else if (key == 'n') {
      Serial.println(F("[NET] 무선 기능 재등록 (수동 요청 1회)"));
      if(command(F("AT+CGNSPWR=0"),3000)==1) {
        gnssEnabled=false; gnssSeen=false; gnssFix=false;
        radioRestorePending=true;
        command(F("AT+CFUN=0"),10000);
        listenFor(1000);
        restoreRadio();
        httpState=-1;
        stage=1;
      }
    }
    else if (key == '1' || key == '0') {
      digitalWrite(PIN_DTR, key == '1' ? HIGH : LOW);
      Serial.print(F("[안내] DTR(D6)="));
      Serial.println(key == '1' ? F("HIGH") : F("LOW (주의: 모뎀 전원붕괴 시 UNO 도 멈출 수 있음)"));
    }
  }
  if(radioRestorePending) return;
#endif
  serviceGnss();
  if(restartPending) return;
  const uint32_t now = millis();

  if (stage == 1) {
    if (stageModem()) { stage = 2; }
    else { listenFor(10000); }
    return;
  }
  if (stage == 2) { stageConfig(); stage = 3; return; }
  if (stage == 3) {
    if (stageSim()) {
      stage = 4;
      regStat = -1; rssi = 99;
      regStartMs = now; lastPollMs = 0; lastNoteMs = 0;
      Serial.println(F("[4/5] 망 등록 대기 시작 (5초 간격 확인, 상태는 15초마다 표시)"));
    } else listenFor(5000);
    return;
  }
  if (stage == 4) {
    if (now - lastPollMs >= 5000) { lastPollMs = now; pollNetwork(); }
    if (regStat == 1 || regStat == 5) {
      Serial.print(F("[4/5] 망 등록: 성공"));
      Serial.println(regStat == 5 ? F(" (로밍)") : F(" (홈망)"));
      stage = 5;
      return;
    }
    if (now - lastNoteMs >= 15000) {
      lastNoteMs = now;
      Serial.print(F("[4/5] 망 등록 대기 중… (신호 CSQ="));
      Serial.print(rssi);
      Serial.print(rssi == 99 ? F("=미검출") : F(""));
      Serial.print(F(", 경과 "));
      Serial.print((now - regStartMs) / 1000UL);
      Serial.println(F("초)"));
      if (regStat == 3) Serial.println(F("[4/5] 등록 거절 응답 — 점검: 유심 개통 상태/로밍 허용"));
      if (rssi == 99 && now - regStartMs > 60000UL)
        Serial.println(F("[4/5] 신호가 계속 미검출 — 점검: ① 안테나 장착 ② 모뎀 전원(재부팅 경고 여부) ③ 실내 음영"));
    }
    return;
  }
  if (stage == 5) { stageServer(); stage = 6; return; }

  // SIM7080G shares LTE/GNSS RF resources. Do not interrupt acquisition to re-register.
  if (!gnssEnabled && shield::due(now,lastPollMs,15000UL)) {
    lastPollMs=now;
    pollNetwork();
    if (regStat!=1 && regStat!=5) {
      Serial.println(F("[감시] 망 등록 재확인 → 자동 복구"));
      stage=3; return;
    }
  }
  const bool freshFix=gnssFix && gnssSeen && !shield::due(millis(),positionStamp,shield::FIX_FRESH_MS);
  if(shield::reportDue(millis(),lastPostMs,postDelayMs,postFailures,gnssEnabled,freshFix,acquisitionMs)) { stageServer(); stage=6; }
}
