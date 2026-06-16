// 13_motion_aware_tracker — 12_ 기반 + LIS3DH 모션 감지 + 스위치 롱프레스 sleep
//
// 동작:
//   - 부팅/wake → 12_와 동일하게 awake 모드 (LTE bring-up, GPS, 15초 POST)
//   - 매 POST에 모션 이벤트 카운트 포함 (운반/이동 vs 정지 판정 보조)
//   - 스위치 롱프레스 (≥2s) → 안전 종료 후 deep sleep 진입
//   - Deep sleep에서 wake 트리거 = 스위치 누름 OR LIS3DH 모션
//     (둘 다 LOW 레벨로 통일 — ESP32-C3는 deep sleep wake GPIO가 단일 레벨)
//
// 핀 (12_와 동일 + LIS3DH INT 추가):
//   I2C  SDA=GPIO8, SCL=GPIO9 (OLED + LIS3DH 0x19 공유)
//   GPS  ESP RX=GPIO20, TX=GPIO21, 9600
//   LTE  ESP RX=GPIO4, TX=GPIO2, PWRKEY=GPIO7, DTR=GPIO10, PWR_EN=GPIO6
//   ADC  GPIO3 (배터리)
//   SW   GPIO1 (INPUT_PULLUP, GND-to-press)
//   LIS  INT1=GPIO5  ← 추가. active LOW 설정 (idle HIGH)
//
// 두 wake 핀 모두 LOW 트리거로 통일하기 위해:
//   - 스위치: 표준 active-low (PULLUP, press=GND)
//   - LIS3DH: CTRL_REG6 H_LACTIVE=1 → 정지 HIGH, 모션 LOW

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TinyGPSPlus.h>
#include <HardwareSerial.h>
#include <WiFi.h>
#include <esp_sleep.h>
#include <esp_system.h>

// =================================================================
// 핀 정의
// =================================================================
#define PIN_SDA        8
#define PIN_SCL        9
#define OLED_ADDR      0x3C

#define PIN_PWR_EN     6
#define PIN_PWRKEY     7
#define PIN_DTR        10
#define PIN_BAT        3
#define PIN_SWITCH     1
#define PIN_LIS_INT    5

#define PIN_GPS_RX     20
#define PIN_GPS_TX     21
#define GPS_BAUD       9600

#define PIN_LTE_RX     4
#define PIN_LTE_TX     2
#define LTE_BAUD       115200

// =================================================================
// 동작 파라미터
// =================================================================
#define APN_NAME            "iot.1nce.net"
// 전용 도메인. SIM7080G 는 SHSSL=0 plain HTTP — 서버측 nginx 가
// /ingest 만큼은 redirect 없이 평문 통과시키도록 설정되어 있음.
#define POST_URL_HOST       "http://gps.serial.kr"
#define POST_PATH           "/ingest"
#define POST_INTERVAL_MS    15000UL
#define BAT_DIV_RATIO       2.0f

#define BRINGUP_RETRY_MS              30000UL
#define POST_FAIL_STREAK_REINIT       2
#define BRINGUP_FAIL_HARD_RESET       3
#define HARD_RESET_LIMIT              2

// SIM7080G가 UNDER-VOLTAGE로 죽었을 때 다음 시도까지 cooldown.
// 전원 회복 + capacitor 재충전 시간 줘야 ping-pong 방지.
#define UNDER_VOLT_COOLDOWN_MS        60000UL

// 스위치 한 번 클릭 후 sleep 진입까지 대기 시간 (ms) — 실수 방지용 grace.
#define SLEEP_CLICK_GRACE_MS  3000UL

// ──────────────────────────────────────────────────────────────────
// 모션 타임아웃 기반 자동 sleep — 일정 시간 동안 모션 없으면 자동으로 deep sleep 진입.
// 디바이스 전원이 불안정하거나 검증 부족이면 0 으로 OFF 두고, 안정 확인 후 1 로 켜기.
// 동시에 stopped_offset_s 페이로드도 이 플래그가 ON 일 때만 의미가 큼 (스위치-즉시 sleep 은 offset≈0).
#define MOTION_AUTO_SLEEP_ENABLED  0          // 0=OFF (현재 모듈 안정성 미확보), 1=ON
#define MOTION_IDLE_TIMEOUT_MS     (5UL * 60UL * 1000UL)   // 5분 무동작 → 자동 sleep
// ──────────────────────────────────────────────────────────────────

// LIS3DH 주소 / 레지스터
#define LIS_ADDR        0x19
#define LIS_WHO_AM_I    0x0F
#define LIS_CTRL_REG1   0x20
#define LIS_CTRL_REG2   0x21
#define LIS_CTRL_REG3   0x22
#define LIS_CTRL_REG4   0x23
#define LIS_CTRL_REG5   0x24
#define LIS_CTRL_REG6   0x25
#define LIS_REFERENCE   0x26
#define LIS_OUT_X_L     0x28
#define LIS_INT1_CFG    0x30
#define LIS_INT1_SRC    0x31
#define LIS_INT1_THS    0x32
#define LIS_INT1_DUR    0x33

// 1 LSB = 16mg @ ±2g HR. 0x10 ≈ 256mg (스위치 클릭 진동에 둔감, 차량 가속엔 충분히 반응).
#define LIS_MOT_THS     0x10
// 50Hz ODR 기준 1 LSB = 1/50초 = 20ms. 0x06 = 6 샘플 = 120ms 지속 모션 필요
// (스위치 누르는 일시 충격은 무시).
#define LIS_MOT_DUR     0x06

// ISR edge filter — 빠른 연속 트리거 무시 (스위치 디바운스와 동일 패턴)
#define LIS_EDGE_FILTER_MS  100UL
// Wake 후 bounce 검사 — 지속 LOW 면 진짜 모션 아닌 진동 잔여로 보고 다시 sleep
#define WAKE_BOUNCE_OBSERVE_MS  1000UL
#define WAKE_BOUNCE_LOW_RATIO    0.55f   // 위 시간 동안 INT 가 55% 이상 LOW 면 bounce

#define DBG  1
#define DBGLN(...)  do { if (DBG) Serial.println(__VA_ARGS__); } while (0)
#define DBGP(...)   do { if (DBG) Serial.print(__VA_ARGS__); } while (0)

// =================================================================
// RTC slow-memory 카운터 — deep sleep 동안 보존, POWERON 시 초기화.
// 누적 wake/sleep 사이클 + 비정상 패턴 카운터 (지하 추정, brownout 등).
// =================================================================
RTC_DATA_ATTR uint32_t rtc_boot_count        = 0;   // POWERON 이후 모든 (부팅+wake) 사이클
RTC_DATA_ATTR uint32_t rtc_wake_count        = 0;   // deep sleep 으로부터 wake 횟수
RTC_DATA_ATTR uint32_t rtc_wake_motion       = 0;   // LIS3DH 모션이 깨운 횟수
RTC_DATA_ATTR uint32_t rtc_wake_switch       = 0;   // 스위치가 깨운 횟수
RTC_DATA_ATTR uint32_t rtc_no_fix_cycles     = 0;   // 모뎀 OK 인데 GPS fix 0회로 끝난 awake 사이클
RTC_DATA_ATTR uint32_t rtc_modem_fail_cycles = 0;   // bring-up 끝까지 실패한 awake 사이클
RTC_DATA_ATTR uint32_t rtc_brownout_count    = 0;   // BROWNOUT reset 누적
RTC_DATA_ATTR uint32_t rtc_last_sleep_uptime = 0;   // 마지막 sleep 진입 시점의 uptime(s)
RTC_DATA_ATTR uint32_t rtc_last_sleep_unix   = 0;   // (선택) 마지막 sleep 시 epoch — LTE에서 받으면 채움

// 이번 awake 사이클의 동적 진단 카운터 (RAM, sleep 시 sleep payload 에 포함)
static uint32_t cyc_fix_count        = 0;   // 이번 사이클 fix=true 횟수
static uint32_t cyc_no_fix_count     = 0;   // 이번 사이클 fix=false 횟수 (모뎀 OK 일 때만)
static uint32_t cyc_post_ok          = 0;
static uint32_t cyc_post_fail        = 0;
static bool     wake_diag_pending    = true;   // 이번 awake 의 첫 POST 에 wake diag 첨부할지

// =================================================================
// 객체 / 상태
// =================================================================
Adafruit_SSD1306 display(128, 64, &Wire, -1);
TinyGPSPlus      gps;
HardwareSerial   gpsSerial(0);
HardwareSerial   lteSerial(1);

String   lastResp;
uint32_t bootMs   = 0;
uint32_t ttAtOkMs = 0;
uint32_t ttL80GnssMs = 0;
uint32_t lastFixMs   = 0;

char deviceUid[32] = "esp-unknown";
const char *wakeReasonStr = "boot";

// SIM 식별자 — LTE bring-up 후 1회 가져옴. 비어있으면 "" 으로 페이로드에서 생략.
char simIccid[24] = "";
char simImei[20]  = "";
char simImsi[20]  = "";

struct NetStats {
  bool     lteReady       = false;
  int      csq            = -1;
  int      reg            = -1;
  char     ip[24]         = "-";
  uint32_t postTries      = 0;
  uint32_t postOks        = 0;
  int      lastStatus     = -1;
  uint32_t nextPostAt     = 0;
  uint8_t  failStreak     = 0;
  uint32_t nextBringUpAt  = 0;
  uint8_t  bringUpFails   = 0;
  uint8_t  hardResets     = 0;
  uint16_t bringUpCount   = 0;
} S;

// LIS3DH / motion 상태
volatile uint32_t motionEvents      = 0;       // ISR fall edge (active-low: HIGH→LOW)
volatile uint32_t lastMotionMs      = 0;
uint32_t          motionEventsAtLastPost = 0;  // 직전 POST 시점 누적값
bool              lisOk             = false;

// forward declaration — enterDeepSleep는 파일 아래쪽에 정의됨
static void enterDeepSleep();

// sleep 진입 절차 중에는 long-press 재검출 차단 (재귀 방지)
static volatile bool inSleepProcedure = false;

// 스위치 상태 (ISR 캡처) — loop이 블록되어도 누름/클릭 시각이 정확히 잡힘
volatile uint32_t swPressedSinceMs   = 0;   // 0=미눌림, >0=누른 시각
volatile uint32_t swLastReleaseMs    = 0;
volatile uint32_t swLastDurationMs   = 0;
volatile uint32_t swEdgeFilterMs     = 0;
volatile uint32_t sleepRequestedAtMs = 0;   // >0이면 release 시각, 3초 후 sleep

static void IRAM_ATTR onSwitchChange() {
  uint32_t now = millis();
  if (now - swEdgeFilterMs < 20) return;   // 20ms chatter 필터
  swEdgeFilterMs = now;

  if (digitalRead(PIN_SWITCH) == LOW) {
    if (swPressedSinceMs == 0) swPressedSinceMs = now;
  } else {
    if (swPressedSinceMs > 0) {
      swLastDurationMs = now - swPressedSinceMs;
      swLastReleaseMs  = now;
      // release 시각 기록 → 3초 후 sleep 진입.
      // 그 동안 또 누르면 갱신되어 카운트 리셋(연타 시 sleep 안 들어감 = 버그/실수 방지).
      sleepRequestedAtMs = now;
    }
    swPressedSinceMs = 0;
  }
}

// 마지막 sleep 발동 사유 — buildSleepPayload 가 읽음. 진입 직전에 채워둠.
static const char* pendingSleepReason = "switch";

// 어디서든 호출 가능 — sleep request 후 3초 경과 시 즉시 sleep 진입.
// AT 명령 대기 루프 안에서도 호출되어 모듈이 죽어도 사용자가 sleep 진입 가능.
static void checkSleepRequest() {
  if (inSleepProcedure) return;
  uint32_t at = sleepRequestedAtMs;
  if (at == 0) return;
  if (millis() - at < SLEEP_CLICK_GRACE_MS) return;
  DBGLN(F("[SW] grace elapsed → sleep"));
  pendingSleepReason = "switch";
  enterDeepSleep();
}

// 모션 타임아웃 자동 sleep — MOTION_AUTO_SLEEP_ENABLED 일 때만 동작.
// lastMotionMs 가 0 (한 번도 모션 없음) 이면 무시 — 차량 시동 직후 등.
// 부팅 직후 grace (e.g. 30s) — 아직 모션 인터럽트 안 발생한 정상 상황 보호.
static void checkMotionIdleSleep() {
#if MOTION_AUTO_SLEEP_ENABLED
  if (inSleepProcedure) return;
  if (lastMotionMs == 0) {
    // 부팅 후 30초 grace 줬는데도 모션 안 잡혔으면 idle 로 카운트 시작.
    if (millis() - bootMs < 30000UL) return;
    // 그 이후엔 bootMs 기준으로 idle 시작 시각 잡음.
    if (millis() - bootMs > MOTION_IDLE_TIMEOUT_MS) {
      DBGLN(F("[SLEEP] motion idle from boot → auto sleep"));
      pendingSleepReason = "motion_idle";
      enterDeepSleep();
    }
    return;
  }
  uint32_t idleMs = millis() - lastMotionMs;
  if (idleMs > MOTION_IDLE_TIMEOUT_MS) {
    DBGP(F("[SLEEP] motion idle ")); DBGP(idleMs / 1000); DBGLN(F("s → auto sleep"));
    pendingSleepReason = "motion_idle";
    enterDeepSleep();
  }
#endif
}

// =================================================================
// LIS3DH I2C helpers
// =================================================================
static void lisWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(LIS_ADDR);
  Wire.write(reg); Wire.write(val);
  Wire.endTransmission();
}
static uint8_t lisRead(uint8_t reg) {
  Wire.beginTransmission(LIS_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((int)LIS_ADDR, 1);
  return Wire.available() ? Wire.read() : 0xFF;
}

static bool lisInit() {
  uint8_t who = lisRead(LIS_WHO_AM_I);
  if (who != 0x33) {
    DBGP(F("[LIS] WHO=0x")); DBGP(who); DBGLN(F(" — not LIS3DH"));
    return false;
  }
  // ODR=50Hz, X/Y/Z, normal/HR
  lisWrite(LIS_CTRL_REG1, 0x47);
  // HPM=11 autoreset, FDS=0 (out raw), HPIS1=1 (HPF→AOI1)
  lisWrite(LIS_CTRL_REG2, 0xC1);
  // INT1 := AOI1
  lisWrite(LIS_CTRL_REG3, 0x40);
  // BDU + ±2g + HR
  lisWrite(LIS_CTRL_REG4, 0x88);
  // LIR_INT1 (latch)
  lisWrite(LIS_CTRL_REG5, 0x08);
  // CTRL_REG6 bit1 H_LACTIVE=1 → INT pin active LOW (정지 HIGH, 모션 LOW)
  lisWrite(LIS_CTRL_REG6, 0x02);
  (void)lisRead(LIS_REFERENCE);
  lisWrite(LIS_INT1_THS, LIS_MOT_THS);
  lisWrite(LIS_INT1_DUR, LIS_MOT_DUR);
  lisWrite(LIS_INT1_CFG, 0x2A);
  (void)lisRead(LIS_INT1_SRC);
  return true;
}

// active LOW: 모션 = HIGH→LOW. 정지로 복귀 = LOW→HIGH (latch 해제 시).
// 우린 "fall edge"를 모션 이벤트로 카운트. 100ms edge filter 로 진동 잔재 제거.
static volatile uint32_t lisEdgeFilterMs = 0;
static void IRAM_ATTR onLisInt() {
  uint32_t now = millis();
  if (now - lisEdgeFilterMs < LIS_EDGE_FILTER_MS) return;   // 디바운스
  lisEdgeFilterMs = now;
  if (digitalRead(PIN_LIS_INT) == LOW) {
    motionEvents++;
    lastMotionMs = now;
  }
}

// =================================================================
// utils (12_와 동일)
// =================================================================
static uint16_t readVbatMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(PIN_BAT);
  return (uint16_t)((sum / 16) * BAT_DIV_RATIO);
}

static void fmtUptime(char *out, size_t n, uint32_t ms) {
  uint32_t s  = ms / 1000;
  uint32_t h  = s / 3600;
  uint32_t m  = (s % 3600) / 60;
  uint32_t ss = s % 60;
  if (h > 0)        snprintf(out, n, "%luh%02lum", (unsigned long)h, (unsigned long)m);
  else if (m > 0)   snprintf(out, n, "%lum%02lus", (unsigned long)m, (unsigned long)ss);
  else              snprintf(out, n, "%lus", (unsigned long)s);
}

static void fmtAge(char *out, size_t n, uint32_t sinceMs) {
  if (sinceMs == 0) { snprintf(out, n, "--"); return; }
  uint32_t age = (millis() - sinceMs) / 1000;
  if (age < 60)        snprintf(out, n, "%lus",  (unsigned long)age);
  else if (age < 3600) snprintf(out, n, "%lum",  (unsigned long)(age / 60));
  else                 snprintf(out, n, "%luh",  (unsigned long)(age / 3600));
}

// =================================================================
// OLED
// =================================================================
static void drawOled() {
  char up[16], fixAge[16], motAge[16];
  fmtUptime(up,     sizeof(up),     millis() - bootMs);
  fmtAge   (fixAge, sizeof(fixAge), lastFixMs);
  fmtAge   (motAge, sizeof(motAge), lastMotionMs);

  display.clearDisplay();
  display.setCursor(0, 0);

  display.print(F("13_mot ")); display.print(wakeReasonStr); display.print(' '); display.println(up);

  // 페어링용 ICCID 끝 8자리 (있으면) — 사용자가 앱에 입력할 값
  if (simIccid[0]) {
    size_t n = strlen(simIccid);
    const char *suffix = (n >= 8) ? simIccid + (n - 8) : simIccid;
    display.print(F("SIM ...")); display.println(suffix);
  }

  display.print(F("POST "));
  display.print(S.postOks); display.print('/'); display.print(S.postTries);
  display.print(F(" fs=")); display.println(S.failStreak);

  display.print(F("s=")); display.print(S.lastStatus);
  display.print(F(" bu=")); display.print(S.bringUpCount);
  display.print(F(" hr=")); display.println(S.hardResets);

  display.print(F("CSQ:")); display.print(S.csq);
  display.print(F(" REG:")); display.print(S.reg); display.print(' ');
  display.println(S.lteReady ? F("OK") : F("--"));

  bool fix = gps.location.isValid();
  display.print(F("L80 "));
  display.print(fix ? F("FIX") : F("---"));
  display.print(F(" sat:"));
  display.print((int)gps.satellites.value());
  display.print(' '); display.println(fixAge);

  if (fix) {
    display.print(F("lat:")); display.println(gps.location.lat(), 6);
    display.print(F("lng:")); display.println(gps.location.lng(), 6);
  } else {
    display.print(F("mot:")); display.print(motionEvents);
    display.print(F(" age:")); display.println(motAge);
    display.print(F("LIS=")); display.println(lisOk ? F("ok") : F("--"));
  }

  // 마지막 줄: vbat 또는 sleep 카운트다운
  if (sleepRequestedAtMs > 0) {
    int32_t remain = (int32_t)SLEEP_CLICK_GRACE_MS - (int32_t)(millis() - sleepRequestedAtMs);
    if (remain < 0) remain = 0;
    display.print(F("Sleep in ")); display.print(remain / 1000 + 1); display.print(F("s..."));
  } else {
    display.print(F("vbat ")); display.print(readVbatMv()); display.print(F(" mV"));
  }
  display.display();
}

// =================================================================
// LTE UART helpers (12_ 그대로)
// =================================================================
static void drainLte() {
  while (lteSerial.available()) {
    char c = (char)lteSerial.read();
    lastResp += c;
    if (lastResp.length() > 2048) lastResp.remove(0, 1024);
  }
}

// 응답에 UNDER-VOLTAGE / POWER DOWN 보이면 모듈이 곧 죽거나 이미 죽음 → 즉시 bail.
static bool lteHealthy() {
  if (lastResp.indexOf("UNDER-VOLTAGE") >= 0) return false;
  if (lastResp.indexOf("POWER DOWN")    >= 0) return false;
  return true;
}

static bool sendAT(const char *cmd, const char *expect, uint32_t timeoutMs) {
  lastResp = "";
  if (cmd && *cmd) {
    if (DBG) { Serial.print(F(">> ")); Serial.println(cmd); }
    lteSerial.print(cmd);
    lteSerial.print("\r\n");
  }
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    drainLte();
    // under-voltage 감지 즉시 빠져나감 (긴 타임아웃 안 끌고)
    if (!lteHealthy()) {
      if (DBG) { Serial.print(F("<< (UV abort) ")); Serial.println(lastResp); }
      return false;
    }
    // AT 블록 중에도 sleep 요청 만료 시 진입 가능하게
    checkSleepRequest();
    if (expect && lastResp.indexOf(expect) >= 0) {
      if (DBG) { Serial.print(F("<< ")); Serial.println(lastResp); }
      return true;
    }
    delay(5);
  }
  if (DBG && cmd && *cmd) {
    Serial.print(F("<< (timeout) ")); Serial.println(lastResp);
  }
  return expect == nullptr;
}

static void waitUartIdle(uint32_t idleMs, uint32_t maxWaitMs) {
  uint32_t lastByte = millis();
  uint32_t t0       = millis();
  while (millis() - t0 < maxWaitMs) {
    while (lteSerial.available()) { lteSerial.read(); lastByte = millis(); }
    if (millis() - lastByte >= idleMs) return;
    delay(10);
  }
}

static void pulsePwrKey() {
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, HIGH);
  delay(100);
  digitalWrite(PIN_PWRKEY, LOW);
  delay(1500);
  digitalWrite(PIN_PWRKEY, HIGH);
}

static void ltePowerOn() {
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, LOW);
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, HIGH);
  delay(200);

  if (sendAT("AT", "OK", 1500)) { DBGLN(F("[LTE] already on")); return; }
  DBGLN(F("[LTE] pulse PWRKEY"));
  pulsePwrKey();
  uint32_t t0 = millis();
  while (millis() - t0 < 5000) { drainLte(); delay(5); }
  sendAT("AT", "OK", 2000);
}

static void ltePowerOff() {
  // sleep 진입 시 AT 핑퐁에 시간 끌지 않음. 다음 부팅 때 어차피 PWRKEY로 다시 깨움.
  // 1) 모듈 살아있으면 fire-and-forget으로 CPOF 통보 → SIM 정상 detach 시도
  // 2) 응답 안 와도 신경 쓰지 않고 곧장 PWR_EN=HIGH 로 하드웨어 차단
  // (UV 상태/죽은 모듈에서는 AT가 어차피 timeout만 끌고 의미 없음)
  lteSerial.print("AT+CPOF\r\n");
  delay(300);                          // 모듈에 명령 전달 시간만 짧게 부여
  digitalWrite(PIN_PWR_EN, HIGH);      // 하드웨어 전원 차단 (확실한 종료)
}

static void hardPowerCycle() {
  DBGLN(F("[LTE] PWR_EN cycle"));
  digitalWrite(PIN_PWR_EN, HIGH);
  delay(2000);
  digitalWrite(PIN_PWR_EN, LOW);
  delay(2000);
  ltePowerOn();
}

// =================================================================
// LTE bring-up + HTTP (12_ 그대로)
// =================================================================
static bool lteBringUp() {
  if (!sendAT("AT", "OK", 2000)) return false;
  if (ttAtOkMs == 0) ttAtOkMs = millis();
  sendAT("ATE0", "OK", 1000);
  sendAT("AT+CMEE=2", "OK", 1000);
  sendAT("AT+CPIN?", "READY", 5000);
  sendAT("AT+CGNSPWR=0", "OK", 2000);

  if (sendAT("AT+CSQ", "+CSQ:", 1500)) {
    int p = lastResp.indexOf("+CSQ:");
    S.csq = lastResp.substring(p + 5).toInt();
  }

  uint32_t t0 = millis();
  while (millis() - t0 < 90000) {
    if (sendAT("AT+CEREG?", "OK", 2000)) {
      int p = lastResp.indexOf("+CEREG:");
      if (p >= 0) {
        int comma = lastResp.indexOf(',', p);
        if (comma >= 0) {
          S.reg = lastResp.substring(comma + 1).toInt();
          if (S.reg == 1 || S.reg == 5) break;
        }
      }
    }
    drawOled();
    delay(2000);
  }
  if (S.reg != 1 && S.reg != 5) return false;

  sendAT("AT+CNACT=0,0", "OK", 3000);
  delay(300);
  String c = String("AT+CNCFG=0,1,\"") + APN_NAME + "\"";
  sendAT(c.c_str(), "OK", 2000);
  bool pdp = sendAT("AT+CNACT=0,1", "ACTIVE", 20000);

  if (sendAT("AT+CNACT?", "+CNACT:", 2000)) {
    int p = lastResp.indexOf("+CNACT: 0,");
    if (p >= 0) {
      int sp = p + 10;
      int stat = lastResp.substring(sp, sp + 1).toInt();
      if (stat == 1) pdp = true;
    }
    int q1 = lastResp.indexOf('"');
    int q2 = lastResp.indexOf('"', q1 + 1);
    if (q1 > 0 && q2 > q1) {
      String ip = lastResp.substring(q1 + 1, q2);
      ip.toCharArray(S.ip, sizeof(S.ip));
      if (ip.length() > 0 && ip != "0.0.0.0") pdp = true;
    }
  }

  S.lteReady = pdp;
  if (pdp) S.bringUpCount++;
  return pdp;
}

// SIM 식별자 한 번만 가져오기. bring-up 직후 호출.
// 응답에서 영숫자만 추출하여 simIccid/simImei/simImsi 채움.
static void copyDigits(const String &src, char *out, size_t cap, size_t maxLen) {
  size_t n = 0;
  for (size_t i = 0; i < (size_t)src.length() && n < cap - 1 && n < maxLen; ++i) {
    char c = src[i];
    if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f')) {
      out[n++] = c;
    }
  }
  out[n] = 0;
}

// 응답에서 길이 minLen ~ maxLen 의 연속 hex/digit 시퀀스 첫 번째를 추출.
// "+CCID: 89..." 같이 접두어가 있어도, 그냥 raw "89..." 로 와도 동작.
static void extractLongDigitRun(const String &src, char *out, size_t cap, size_t minLen, size_t maxLen) {
  out[0] = 0;
  size_t n = src.length();
  size_t i = 0;
  while (i < n) {
    while (i < n && !isxdigit(src[i])) i++;
    size_t start = i;
    while (i < n && isxdigit(src[i])) i++;
    size_t len = i - start;
    if (len >= minLen) {
      size_t take = (len > maxLen) ? maxLen : len;
      if (take >= cap) take = cap - 1;
      for (size_t j = 0; j < take; j++) out[j] = src[start + j];
      out[take] = 0;
      return;
    }
  }
}

static void fetchSimInfo() {
  // 이미 받았으면 skip
  if (simIccid[0] != 0 && simImei[0] != 0) return;

  // ICCID — SIM7080G 정식 명령은 AT+CICCID (응답: "+ICCID: 89...").
  // 하위 호환으로 AT+CCID / AT+QCCID 도 시도.
  if (simIccid[0] == 0) {
    sendAT("AT+CICCID", "OK", 2000);
    extractLongDigitRun(lastResp, simIccid, sizeof(simIccid), 18, 22);
    if (simIccid[0] == 0) {
      sendAT("AT+CCID", "OK", 2000);
      extractLongDigitRun(lastResp, simIccid, sizeof(simIccid), 18, 22);
    }
    if (simIccid[0] == 0) {
      sendAT("AT+QCCID", "OK", 2000);
      extractLongDigitRun(lastResp, simIccid, sizeof(simIccid), 18, 22);
    }
  }

  // IMEI — AT+CGSN 응답에 15자리 숫자 한 줄
  if (simImei[0] == 0) {
    sendAT("AT+CGSN", "OK", 2000);
    extractLongDigitRun(lastResp, simImei, sizeof(simImei), 14, 16);
  }

  // IMSI — AT+CIMI 응답에 15자리 숫자 한 줄
  if (simImsi[0] == 0) {
    sendAT("AT+CIMI", "OK", 2000);
    extractLongDigitRun(lastResp, simImsi, sizeof(simImsi), 14, 16);
  }

  DBGP(F("[SIM] iccid=")); DBGLN(simIccid);
  DBGP(F("[SIM] imei="));  DBGLN(simImei);
  DBGP(F("[SIM] imsi="));  DBGLN(simImsi);

  // ICCID 있으면 device_uid 를 sim-<끝 8자리> 로 안정화 (MAC=0 같은 경우 대비)
  size_t n = strlen(simIccid);
  if (n >= 8) {
    snprintf(deviceUid, sizeof(deviceUid), "sim-%s", simIccid + (n - 8));
    DBGP(F("[SIM] device_uid → ")); DBGLN(deviceUid);
  }
}

static bool sendBodyAfterPrompt(const char *body, uint32_t len) {
  uint32_t t0 = millis();
  lastResp = "";
  while (millis() - t0 < 3000) {
    drainLte();
    if (lastResp.indexOf('>') >= 0) break;
    delay(5);
  }
  if (lastResp.indexOf('>') < 0) return false;
  lteSerial.write((const uint8_t *)body, len);
  return sendAT("", "OK", 8000);
}

static bool httpPostJson(const char *host, const char *path, const char *body, int *statusOut) {
  char cmd[96];
  *statusOut = -1;

  if (!sendAT("AT", "OK", 1500)) { DBGLN(F("[POST] module unresponsive")); return false; }
  sendAT("AT+CGNSPWR=0", "OK", 1000);
  waitUartIdle(200, 1000);
  sendAT("AT+SHDISC", nullptr, 800);
  waitUartIdle(200, 1000);

  snprintf(cmd, sizeof(cmd), "AT+SHCONF=\"URL\",\"%s\"", host);
  if (!sendAT(cmd, "OK", 2000)) return false;
  sendAT("AT+SHCONF=\"BODYLEN\",1024",  "OK", 2000);
  sendAT("AT+SHCONF=\"HEADERLEN\",350", "OK", 2000);
  sendAT("AT+SHSSL=0,\"\"", "OK", 2000);

  // SHCONN: 정상이면 수 초. 더 길어지면 모듈/네트워크가 망가졌다는 신호이므로
  // 20초까지 끌지 말고 10초에서 잘라 다음 사이클로 넘김.
  if (!sendAT("AT+SHCONN", "OK", 10000)) {
    DBGLN(F("[POST] SHCONN fail"));
    sendAT("AT+SHDISC", nullptr, 1500);
    return false;
  }

  sendAT("AT+SHCHEAD", "OK", 2000);
  sendAT("AT+SHAHEAD=\"Content-Type\",\"application/json\"", "OK", 2000);

  size_t len = strlen(body);
  snprintf(cmd, sizeof(cmd), "AT+SHBOD=%u,10000", (unsigned)len);
  if (DBG) { Serial.print(F(">> ")); Serial.println(cmd); }
  lteSerial.print(cmd); lteSerial.print("\r\n");
  if (!sendBodyAfterPrompt(body, len)) {
    DBGLN(F("[POST] SHBOD fail"));
    sendAT("AT+SHDISC", "OK", 3000); 
    return false;
  }

  snprintf(cmd, sizeof(cmd), "AT+SHREQ=\"%s\",3", path);
  if (!sendAT(cmd, "+SHREQ:", 30000)) {
    DBGLN(F("[POST] SHREQ fail"));
    sendAT("AT+SHDISC", "OK", 3000);
    return false;
  }

  int p  = lastResp.indexOf("+SHREQ:");
  int c1 = lastResp.indexOf(',', p);
  int c2 = lastResp.indexOf(',', c1 + 1);
  if (statusOut && c1 > 0 && c2 > c1) {
    *statusOut = lastResp.substring(c1 + 1, c2).toInt();
  }
  DBGP(F("[POST] HTTP ")); DBGLN(*statusOut);

  sendAT("AT+SHDISC", "OK", 3000);
  return true;
}

// =================================================================
// payload (motion 통계 포함)
// =================================================================
// SIM 식별자가 있으면 ", \"iccid\":\"...\", \"imei\":\"...\"" 형태 부분 문자열 만듦.
static void simFragment(char *out, size_t cap) {
  if (simIccid[0] || simImei[0] || simImsi[0]) {
    snprintf(out, cap, ",\"iccid\":\"%s\",\"imei\":\"%s\",\"imsi\":\"%s\"",
             simIccid, simImei, simImsi);
  } else {
    out[0] = 0;
  }
}

// awake 사이클 중 fix 통계 누적 — sleep payload 시 활용.
static void countFixForCycle(bool got_fix) {
  if (got_fix) cyc_fix_count++;
  else if (S.csq > 0) cyc_no_fix_count++;   // 모뎀 OK 인데 GPS 못 따림 = 실내/지하 단서
}

// 첫 POST 이후 ms 측정용 — sleep_duration_s 추정에 마이너 도움.
// (실제 sleep_duration 은 RTC 누적 시간으로 정확히는 모름 — boot 직후 0 으로 시작)
//
// payload 에 진단 카운터 (RTC + 이번 cycle) JSON 단편을 만들어 박는다.
static void buildDiagFragment(char *out, size_t cap, bool include_wake_extras) {
  uint32_t uptime_s = (millis() - bootMs) / 1000;
  if (include_wake_extras) {
    snprintf(out, cap,
      ",\"event\":\"wake\""
      ",\"diag\":{\"boots\":%lu,\"wakes\":%lu,\"motion_wakes\":%lu,\"switch_wakes\":%lu,"
      "\"no_fix_cycles\":%lu,\"modem_fail_cycles\":%lu,\"brownouts\":%lu,"
      "\"last_sleep_uptime_s\":%lu,\"cyc_no_fix\":%lu,\"cyc_fix\":%lu}",
      (unsigned long)rtc_boot_count, (unsigned long)rtc_wake_count,
      (unsigned long)rtc_wake_motion, (unsigned long)rtc_wake_switch,
      (unsigned long)rtc_no_fix_cycles, (unsigned long)rtc_modem_fail_cycles,
      (unsigned long)rtc_brownout_count,
      (unsigned long)rtc_last_sleep_uptime,
      (unsigned long)cyc_no_fix_count, (unsigned long)cyc_fix_count);
  } else {
    out[0] = 0;
  }
  (void)uptime_s;
}

static void buildPayload(char *out, size_t cap) {
  uint32_t vbatMv = readVbatMv();
  bool l80fix = gps.location.isValid();
  uint32_t motTotal = motionEvents;
  uint32_t motDelta = motTotal - motionEventsAtLastPost;
  uint32_t motAgeS  = lastMotionMs ? (millis() - lastMotionMs) / 1000 : 0;
  motionEventsAtLastPost = motTotal;

  // 사이클 fix 카운트 누적 (anomaly 추적용)
  countFixForCycle(l80fix);

  char sim[96]; simFragment(sim, sizeof(sim));
  char diag[320];
  buildDiagFragment(diag, sizeof(diag), wake_diag_pending);

  if (l80fix) {
    snprintf(out, cap,
      "{\"device_uid\":\"%s\"%s,\"ts\":%lu,\"awake\":%lu,\"csq\":%d,\"reg\":%d,"
      "\"vbat_mv\":%lu,\"at_ms\":%lu,"
      "\"l80\":{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat\":%d,\"ttff_s\":%lu},"
      "\"motion\":{\"total\":%lu,\"delta\":%lu,\"age_s\":%lu},"
      "\"wake\":\"%s\"%s}",
      deviceUid, sim,
      (unsigned long)((millis() - bootMs) / 1000),
      (unsigned long)S.bringUpCount,
      S.csq, S.reg, (unsigned long)vbatMv, (unsigned long)ttAtOkMs,
      gps.location.lat(), gps.location.lng(),
      (int)gps.satellites.value(),
      (unsigned long)(ttL80GnssMs / 1000),
      (unsigned long)motTotal, (unsigned long)motDelta, (unsigned long)motAgeS,
      wakeReasonStr, diag);
  } else {
    snprintf(out, cap,
      "{\"device_uid\":\"%s\"%s,\"ts\":%lu,\"awake\":%lu,\"csq\":%d,\"reg\":%d,"
      "\"vbat_mv\":%lu,\"at_ms\":%lu,"
      "\"l80\":{\"fix\":false,\"sat\":%d},"
      "\"motion\":{\"total\":%lu,\"delta\":%lu,\"age_s\":%lu},"
      "\"wake\":\"%s\"%s}",
      deviceUid, sim,
      (unsigned long)((millis() - bootMs) / 1000),
      (unsigned long)S.bringUpCount,
      S.csq, S.reg, (unsigned long)vbatMv, (unsigned long)ttAtOkMs,
      (int)gps.satellites.value(),
      (unsigned long)motTotal, (unsigned long)motDelta, (unsigned long)motAgeS,
      wakeReasonStr, diag);
  }
}

// sleep 진입 직전 송신용 — event=sleep_enter + 사이클 진단 + 진짜 정지 시각 offset.
//
// stopped_offset_s = "지금부터 N초 전이 진짜 정지 시각" — 펌웨어는 epoch 시각 못 갖지만
// 마지막 모션 시점 (lastMotionMs) 기준 경과 초로 표현 가능. 백엔드가 occurred_at - offset
// 으로 stopped_at 산출. 스위치-즉시-sleep 의 경우 offset≈0 이라 occurred_at 그대로 됨 (정확).
// motion-idle auto-sleep 의 경우 offset = idle 지속 시간.
static void buildSleepPayload(char *out, size_t cap, const char *reason) {
  uint32_t vbatMv = readVbatMv();
  uint32_t uptime_s = (millis() - bootMs) / 1000;
  char sim[96]; simFragment(sim, sizeof(sim));

  uint32_t stopped_offset_s = 0;
  if (lastMotionMs > 0 && millis() > lastMotionMs) {
    stopped_offset_s = (millis() - lastMotionMs) / 1000;
  }

  snprintf(out, cap,
    "{\"device_uid\":\"%s\"%s,\"ts\":%lu,\"csq\":%d,\"reg\":%d,\"vbat_mv\":%lu,"
    "\"event\":\"sleep_enter\",\"sleep_reason\":\"%s\",\"stopped_offset_s\":%lu,"
    "\"diag\":{\"boots\":%lu,\"wakes\":%lu,\"motion_wakes\":%lu,\"switch_wakes\":%lu,"
    "\"no_fix_cycles\":%lu,\"modem_fail_cycles\":%lu,\"brownouts\":%lu,"
    "\"cyc_no_fix\":%lu,\"cyc_fix\":%lu,\"cyc_post_ok\":%lu,\"cyc_post_fail\":%lu}}",
    deviceUid, sim, (unsigned long)uptime_s,
    S.csq, S.reg, (unsigned long)vbatMv,
    reason, (unsigned long)stopped_offset_s,
    (unsigned long)rtc_boot_count, (unsigned long)rtc_wake_count,
    (unsigned long)rtc_wake_motion, (unsigned long)rtc_wake_switch,
    (unsigned long)rtc_no_fix_cycles, (unsigned long)rtc_modem_fail_cycles,
    (unsigned long)rtc_brownout_count,
    (unsigned long)cyc_no_fix_count, (unsigned long)cyc_fix_count,
    (unsigned long)cyc_post_ok, (unsigned long)cyc_post_fail);
}

static void doPost() {
  char body[1024];
  buildPayload(body, sizeof(body));
  if (DBG) { Serial.print(F("[POST body] ")); Serial.println(body); }

  S.postTries++;
  int status = -1;
  bool ok = httpPostJson(POST_URL_HOST, POST_PATH, body, &status);
  if (ok) {
    S.lastStatus = status;
    if (status == 200) {
      S.postOks++;
      cyc_post_ok++;
      // wake_diag 는 200 OK 한 번 받으면 더 안 보냄 (도착 확인됨).
      wake_diag_pending = false;
    } else {
      cyc_post_fail++;
    }
  } else {
    S.lastStatus = -1;
    cyc_post_fail++;
  }

  // UNDER-VOLTAGE 가 잡히면 모듈이 곧 죽었거나 죽음 → 모듈 인식 다시 풀고
  // cooldown(60s) 후 bring-up 재시도. 이 동안 전원 레일이 회복할 시간 확보.
  if (lastResp.indexOf("UNDER-VOLTAGE") >= 0 || lastResp.indexOf("POWER DOWN") >= 0) {
    DBGLN(F("[POST] under-voltage detected → cooldown 60s"));
    S.lteReady      = false;
    S.failStreak    = 0;
    S.nextBringUpAt = millis() + UNDER_VOLT_COOLDOWN_MS;
  }
}

// =================================================================
// Deep sleep — wake = switch (LOW) OR LIS3DH INT (LOW, active-low 설정)
// =================================================================
static void enterDeepSleep() {
  if (inSleepProcedure) return;   // 절차 중복 진입 차단
  inSleepProcedure = true;

  DBGLN(F("[SLEEP] entering deep sleep"));

  // OLED 메시지
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println(F("Going to sleep..."));
  display.println();
  display.println(F("wake on: SW press"));
  display.println(F("         LIS motion"));
  display.display();

  // ── sleep_enter 이벤트 송신 — LTE 가 살아있을 때만 ──
  // 사이클이 fix 한 번도 못 따림 + 모뎀 OK 였다면 RTC anomaly 카운터 증가.
  if (cyc_fix_count == 0 && cyc_no_fix_count > 0) rtc_no_fix_cycles++;
  if (S.csq <= 0)                                  rtc_modem_fail_cycles++;
  rtc_last_sleep_uptime = (millis() - bootMs) / 1000;

  if (S.lteReady) {
    char body[640];
    buildSleepPayload(body, sizeof(body), pendingSleepReason);
    DBGP(F("[SLEEP] tx sleep_enter: ")); DBGLN(body);
    int status = -1;
    httpPostJson(POST_URL_HOST, POST_PATH, body, &status);
    DBGP(F("[SLEEP] sleep_enter http=")); DBGLN(status);
  } else {
    DBGLN(F("[SLEEP] LTE not ready — sleep_enter event lost"));
  }

  // LTE 안전 종료
  ltePowerOff();

  // LIS ISR 떼서 ESP 쪽 변동 차단 (모듈은 활성)
  detachInterrupt(digitalPinToInterrupt(PIN_LIS_INT));

  // 자가-wake 방지: LIS INT 핀이 안정적으로 HIGH(idle)가 될 때까지 대기.
  // 사용자가 디바이스를 내려놓는 모션 / 손 떼는 모션이 새 latch 걸 수 있어
  // 클리어 후 300ms HIGH 유지 시점까지 폴링. 최대 10초.
  uint32_t settleStart = millis();
  uint32_t highStableSince = 0;
  while (millis() - settleStart < 10000) {
    (void)lisRead(LIS_INT1_SRC);   // latch 클리어
    delay(20);
    if (digitalRead(PIN_LIS_INT) == HIGH) {
      if (highStableSince == 0) highStableSince = millis();
      if (millis() - highStableSince >= 300) break;   // 300ms 연속 HIGH = 안정
    } else {
      highStableSince = 0;   // 다시 LOW로 떨어졌으면 카운트 리셋
    }
  }
  DBGP(F("[SLEEP] LIS settled in ")); DBGP(millis() - settleStart); DBGLN(F("ms"));
  // settle 직후 추가 grace — latch 마지막 클리어 후 새 INT 안 일어나도록
  (void)lisRead(LIS_INT1_SRC);
  delay(500);
  (void)lisRead(LIS_INT1_SRC);

  // 스위치도 사용자가 아직 누르고 있으면 깨자마자 wake되니, 떼질 때까지 대기 (캡 3초)
  uint32_t swWaitStart = millis();
  while (digitalRead(PIN_SWITCH) == LOW && millis() - swWaitStart < 3000) {
    delay(20);
  }
  DBGLN(F("[SLEEP] sw released, sleeping now"));

  // OLED 끄기
  display.ssd1306_command(SSD1306_DISPLAYOFF);

  // wake 핀 mask — LIS 가 동작 중일 때만 LIS_INT 포함.
  // LIS 가 망가져 INT 를 floating LOW 로 두면 mask 에 포함된 것 자체가 즉시 wake 원인이 됨.
  uint64_t mask = (1ULL << PIN_SWITCH);
  if (lisOk) {
    mask |= (1ULL << PIN_LIS_INT);
  } else {
    DBGLN(F("[SLEEP] LIS not OK — switch-only wake"));
  }
  esp_deep_sleep_enable_gpio_wakeup(mask, ESP_GPIO_WAKEUP_GPIO_LOW);

  Serial.flush();
  esp_deep_sleep_start();
}

static const char *wakeCauseStr(esp_sleep_wakeup_cause_t c) {
  switch (c) {
    case ESP_SLEEP_WAKEUP_GPIO:      return "gpio";
    case ESP_SLEEP_WAKEUP_TIMER:     return "timer";
    case ESP_SLEEP_WAKEUP_UNDEFINED: return "boot";
    default:                         return "other";
  }
}

// 리셋 원인 진단용 — 브라운아웃 / 와치독 / 패닉 등 구분
static const char *resetReasonStr(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:    return "POWERON";
    case ESP_RST_EXT:        return "EXT-PIN";
    case ESP_RST_SW:         return "SW-RESTART";
    case ESP_RST_PANIC:      return "PANIC";
    case ESP_RST_INT_WDT:    return "INT-WDT";
    case ESP_RST_TASK_WDT:   return "TASK-WDT";
    case ESP_RST_WDT:        return "WDT-OTHER";
    case ESP_RST_DEEPSLEEP:  return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:   return "BROWNOUT";   // ← 전원 sag로 ESP 자체가 리셋
    case ESP_RST_SDIO:       return "SDIO";
    default:                 return "UNKNOWN";
  }
}

// =================================================================
// setup / loop
// =================================================================
void setup() {
  bootMs = millis();

  Serial.begin(115200);
  delay(200);
  DBGLN();
  DBGLN(F("=== 13_motion_aware_tracker ==="));

  // 리셋 원인 (BROWNOUT 인지 아닌지 구분 — 자혼자 재부팅 진단)
  esp_reset_reason_t rr = esp_reset_reason();
  DBGP(F("[BOOT] reset_reason=")); DBGLN(resetReasonStr(rr));

  // POWERON 이면 RTC 카운터 전체 리셋 (콜드부팅), 아니면 누적.
  if (rr == ESP_RST_POWERON) {
    rtc_boot_count        = 1;
    rtc_wake_count        = 0;
    rtc_wake_motion       = 0;
    rtc_wake_switch       = 0;
    rtc_no_fix_cycles     = 0;
    rtc_modem_fail_cycles = 0;
    rtc_brownout_count    = 0;
    rtc_last_sleep_uptime = 0;
    rtc_last_sleep_unix   = 0;
  } else {
    rtc_boot_count++;
    if (rr == ESP_RST_BROWNOUT) rtc_brownout_count++;
  }

  esp_sleep_wakeup_cause_t wc = esp_sleep_get_wakeup_cause();
  if (wc == ESP_SLEEP_WAKEUP_GPIO) {
    rtc_wake_count++;
    // 어느 핀이 깨웠는지 — wake-up GPIO mask로 확인.
    // 스위치 비트가 동시에 set 됐으면 사용자 의도(스위치)로 판단 — motion 무시.
    uint64_t status = esp_sleep_get_gpio_wakeup_status();
    if      (status & (1ULL << PIN_SWITCH))  { wakeReasonStr = "switch"; rtc_wake_switch++; }
    else if (status & (1ULL << PIN_LIS_INT)) { wakeReasonStr = "motion"; rtc_wake_motion++; }
    else                                      wakeReasonStr = "gpio";
  } else {
    wakeReasonStr = wakeCauseStr(wc);
  }
  DBGP(F("[BOOT] wake=")); DBGP(wakeReasonStr);
  DBGP(F("  boots=")); DBGP(rtc_boot_count);
  DBGP(F("  wakes=")); DBGP(rtc_wake_count);
  DBGP(F("  brown=")); DBGLN(rtc_brownout_count);

  // ── Motion wake bounce 검출 ──────────────────────────────
  // 진짜 차량 가속이면 1초 동안 INT 가 잠깐만 LOW 였다가 풀림 (motion 끝).
  // 진동 잔재 / 손짓이면 1초 동안 거의 내내 LOW 유지 → 가짜 wake 로 보고 다시 sleep.
  // 단, LIS 가 I2C 응답 안 하면 latch 클리어 불가 → 무한 loop 위험. 그땐 bounce 검사 skip.
  if (wakeReasonStr == "motion") {
    pinMode(PIN_LIS_INT, INPUT_PULLUP);
    Wire.begin(PIN_SDA, PIN_SCL);
    delay(20);                          // I2C 안정화
    uint8_t who = lisRead(LIS_WHO_AM_I);
    bool lisOK = (who == 0x33);
    if (!lisOK) {
      DBGP(F("[WAKE] LIS unresponsive (WHO=0x"));
      DBGP(who); DBGLN(F(") — bounce check skipped, proceeding"));
      goto skip_bounce_check;            // 정상 wake 진행
    }
    (void)lisRead(LIS_INT1_SRC);        // latch 첫 클리어

    {
      uint32_t obsStart = millis();
      uint32_t lowCount = 0, totalCount = 0;
      while (millis() - obsStart < WAKE_BOUNCE_OBSERVE_MS) {
        if (digitalRead(PIN_LIS_INT) == LOW) lowCount++;
        totalCount++;
        delay(20);
        if (totalCount % 5 == 0) (void)lisRead(LIS_INT1_SRC);   // 주기 latch 클리어
      }
      float ratio = totalCount > 0 ? (float)lowCount / totalCount : 0;
      DBGP(F("[WAKE] motion bounce check ratio=")); DBGLN(ratio);
      if (ratio > WAKE_BOUNCE_LOW_RATIO) {
      DBGLN(F("[WAKE] sustained vibration → re-sleep (가짜 wake)"));
      // RTC 카운터 보정 — 가짜 wake 차감
      if (rtc_wake_motion > 0) rtc_wake_motion--;
      if (rtc_wake_count  > 0) rtc_wake_count--;
      // settle 추가 — 진동 멎을 때까지 대기 (최대 5초)
      uint32_t reSettleStart = millis();
      uint32_t highSince = 0;
      while (millis() - reSettleStart < 5000) {
        if (lisOK) (void)lisRead(LIS_INT1_SRC);
        delay(30);
        if (digitalRead(PIN_LIS_INT) == HIGH) {
          if (highSince == 0) highSince = millis();
          if (millis() - highSince >= 200) break;
        } else {
          highSince = 0;
        }
      }
      uint64_t mask = (1ULL << PIN_SWITCH) | (1ULL << PIN_LIS_INT);
      esp_deep_sleep_enable_gpio_wakeup(mask, ESP_GPIO_WAKEUP_GPIO_LOW);
      Serial.flush();
      esp_deep_sleep_start();
      // never returns
      }   // close: if (ratio > ...)
    }     // close: inner block { uint32_t obsStart ... }
  }       // close: if (wakeReasonStr == "motion")
  skip_bounce_check: ;

  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);

  pinMode(PIN_SWITCH,  INPUT_PULLUP);
  pinMode(PIN_LIS_INT, INPUT_PULLUP);   // active-low LIS, idle HIGH (외부 신호)
  attachInterrupt(digitalPinToInterrupt(PIN_SWITCH), onSwitchChange, CHANGE);

  // device_uid
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(deviceUid, sizeof(deviceUid), "esp-%02x%02x%02x%02x%02x%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  DBGP(F("device_uid=")); DBGLN(deviceUid);

  analogReadResolution(12);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  // LIS3DH init
  lisOk = lisInit();
  if (lisOk) {
    DBGLN(F("[LIS] OK (active-low, motion=fall)"));
    attachInterrupt(digitalPinToInterrupt(PIN_LIS_INT), onLisInt, CHANGE);
  } else {
    DBGLN(F("[LIS] init failed — proceeding without motion"));
  }

  drawOled();

  gpsSerial.setRxBufferSize(1024);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);

  lteSerial.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);
  ltePowerOn();
  if (lteBringUp()) {
    fetchSimInfo();   // SIM 식별자 한 번만 가져옴
  }

  S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;
  S.nextPostAt    = millis() + 2000;
}

void loop() {
  // GPS 피드
  while (gpsSerial.available()) {
    char c = (char)gpsSerial.read();
    if (gps.encode(c)) {
      if (gps.location.isValid()) {
        if (ttL80GnssMs == 0) {
          ttL80GnssMs = millis() - bootMs;
          DBGLN(F("[L80] first fix"));
        }
        lastFixMs = millis();
      }
    }
  }

  // ISR이 release 시각 기록 → 3초 후 자동 sleep
  checkSleepRequest();
  // 모션 idle 자동 sleep — MOTION_AUTO_SLEEP_ENABLED 일 때만 동작
  checkMotionIdleSleep();
  // 디버그: 새 release 발생 시 한 번 출력 + 카운트다운 알림
  static uint32_t lastShownReleaseMs = 0;
  if (swLastReleaseMs != lastShownReleaseMs) {
    lastShownReleaseMs = swLastReleaseMs;
    DBGP(F("[SW] click dur=")); DBGP(swLastDurationMs);
    DBGP(F("ms → sleep in ")); DBGP(SLEEP_CLICK_GRACE_MS / 1000); DBGLN(F("s"));
  }

  // LIS3DH latch 정리 (50ms마다)
  static uint32_t lastLisPoll = 0;
  if (lisOk && millis() - lastLisPoll > 50) {
    lastLisPoll = millis();
    (void)lisRead(LIS_INT1_SRC);   // latch 해제 → INT pin LOW→HIGH
  }

  // LTE / POST 사이클 (12_와 동일)
  if (!S.lteReady) {
    if ((int32_t)(millis() - S.nextBringUpAt) >= 0) {
      DBGP(F("[LTE] retry bring-up (fails="));
      DBGP(S.bringUpFails); DBGLN(F(")"));

      if (S.bringUpFails >= BRINGUP_FAIL_HARD_RESET) {
        S.bringUpFails = 0;
        S.hardResets++;
        if (S.hardResets > HARD_RESET_LIMIT) {
          hardPowerCycle();
          S.hardResets = 0;
        } else {
          DBGLN(F("[LTE] HARD RESET via PWRKEY toggle"));
          pulsePwrKey(); delay(3000);
          pulsePwrKey(); delay(5000);
        }
      }

      ltePowerOn();
      lteBringUp();
      S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;

      if (S.lteReady) {
        fetchSimInfo();   // 처음 부팅에서 못 받았으면 여기서 받음 (멱등)
        S.bringUpFails = 0;
        S.hardResets   = 0;
        S.nextPostAt   = millis() + 2000;
      } else {
        S.bringUpFails++;
      }
    }
  } else {
    if ((int32_t)(millis() - S.nextPostAt) >= 0) {
      doPost();
      S.nextPostAt = millis() + POST_INTERVAL_MS;

      if (S.lastStatus != 200) {
        S.failStreak++;
        if (S.failStreak >= POST_FAIL_STREAK_REINIT) {
          DBGLN(F("[LTE] POST fail streak → reinit"));
          S.lteReady      = false;
          S.failStreak    = 0;
          S.nextBringUpAt = millis();
        }
      } else {
        S.failStreak = 0;
      }
    }
  }

  static uint32_t lastDraw = 0;
  if (millis() - lastDraw > 500) {
    lastDraw = millis();
    drawOled();
  }

  drainLte();
  delay(10);
}
