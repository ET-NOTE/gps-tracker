// 13_2_motion_aware_tracker — 13_1 기반 + 신규 PCB 핀 + 부저 (2026-06-17)
//
// 13_1 대비 변경점:
//   1) PCB rev — LTE RX/TX swap (RX=GPIO2, TX=GPIO4)
//   2) 신규 부저 — GPIO1 (active buzzer). 주요 이벤트에서 비프:
//        · 부팅 완료 (긴 1회)
//        · 첫 GPS fix (트리플 짧음)
//        · 첫 POST 200 OK (트리플 짧음)
//        · Deep sleep 진입 (긴 1회)
//        · Wake from sleep (모션) (이중 짧음)
//
// 동작 (13_1 동일):
//   - 부팅/wake → LTE bring-up, GPS, 15초 주기 POST
//   - 매 POST에 모션 이벤트 카운트 포함
//   - 정지 자동 sleep: 5분 연속 "유의미한 정지" 상태 시 deep sleep
//     · 정지 판정: LIS3DH 모션 OFF (최근 30초 이벤트 없음) AND GPS 이동 없음 (5분 fix 들의
//       max pairwise distance < 50m). GPS 가용 안 하면 LIS3DH 단독 판정.
//   - Deep sleep wake 트리거 = LIS3DH 모션 ONLY (active LOW). LIS init 실패 시 sleep
//     자체를 비활성화 (wake 불가능 deadlock 방지).
//
// 시리얼 디버그:
//   - 매 1초 STATUS 라인 + state-change 이벤트 라인 + [BUZ] 비프 트리거
//
// 핀:
//   I2C    SDA=GPIO8, SCL=GPIO9 (LIS3DH 0x19 또는 0x18 auto-probe)
//   GPS    ESP RX=GPIO20, TX=GPIO21, 9600
//   LTE    ESP RX=GPIO2,  TX=GPIO4, PWRKEY=GPIO7, DTR=GPIO10, PWR_EN=GPIO6   ← rev
//   ADC    GPIO3 (배터리)
//   LIS    INT1=GPIO5 (active LOW, idle HIGH)
//   BUZZER GPIO1 (active, HIGH=beep)                                          ← new

#include <Wire.h>
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

#define PIN_PWR_EN     6
#define PIN_PWRKEY     7
#define PIN_DTR        10
#define PIN_BAT        3
#define PIN_LIS_INT    5
// (PIN_SWITCH removed — 테스트 스위치 하드웨어 제거)

#define PIN_GPS_RX     20
#define PIN_GPS_TX     21
#define GPS_BAUD       9600

// PCB rev 2026-06-17 — RX/TX swap
#define PIN_LTE_RX     4     // OLD PCB pinout (pre-2026-06-17)
#define PIN_LTE_TX     2     // OLD PCB pinout (pre-2026-06-17)
#define LTE_BAUD       115200

#define PIN_BUZZER     1     // passive 마그네틱 부저 — tone() PWM 으로 구동
#define BUZZER_FREQ    2700  // Hz — 마그네틱 부저 공진주파수 근처 (최대 효율 + audible).
                             // 1800Hz 로 낮춰 봤으나 공진 외 효율 너무 낮아 inaudible → 복원.
#define BUZZER_ENABLED 1     // 부저 인프라 ON — 서버 cmd:beep + 마일스톤 비프 모두 동작.

// =================================================================
// 동작 파라미터
// =================================================================
#define APN_NAME            "iot.1nce.net"
// 운영 단계에서 swap. 라인 한 줄만 주석 토글하면 됨. POST_PATH 는 양쪽 모두 /ingest.
#define POST_URL_HOST       "http://gps.serial.kr"        // prod ← 현재
// #define POST_URL_HOST    "http://dev-gps.serial.kr"   // dev (테스트 단계)
#define POST_PATH           "/ingest"
// 15초 — LTE TX peak 빈도 (= brownout 트리거 빈도) 와 실시간 추적 응답성의 trade-off.
// 10초로 줄이면 brownout 빈도 ↑. 30초+ 면 추적 응답성 ↓.
#define POST_INTERVAL_MS    15000UL
#define BAT_DIV_RATIO       2.0f

#define BRINGUP_RETRY_MS              30000UL
#define POST_FAIL_STREAK_REINIT       2
#define BRINGUP_FAIL_HARD_RESET       3
#define HARD_RESET_LIMIT              2

#define UNDER_VOLT_COOLDOWN_MS        60000UL

// ──────────────────────────────────────────────────────────────────
// 정지 자동 sleep — LIS3DH + GPS 상호 검증.
//   STATIONARY_WINDOW_MS         : 정지 유지 시간 (5분 → sleep)
//   MOTION_QUIET_MS              : LIS3DH "조용함" 판정 — 이 시간 동안 이벤트 0건
//   GPS_DRIFT_THRESHOLD_M        : 5분 fix 들의 max pairwise distance 임계
//   GPS_STALE_MS                 : 마지막 fix 가 이 시간 넘게 오래면 GPS unavailable 간주
//   STATIONARY_BOOT_GRACE_MS     : 부팅/wake 직후 정지 판정 보류 (모듈 안정화 + first fix 대기)
// ──────────────────────────────────────────────────────────────────
#define STATIONARY_WINDOW_MS       (5UL * 60UL * 1000UL)  // [14_i] 5min 복귀 → 부저만 13_1 대비 다름
#define MOTION_QUIET_MS            30000UL
#define GPS_DRIFT_THRESHOLD_M      50.0f
#define GPS_STALE_MS               60000UL
#define STATIONARY_BOOT_GRACE_MS   60000UL
#define GPS_HISTORY_N              16

// 시리얼 STATUS 라인 주기
#define STATUS_PRINT_MS       1000UL

// LIS3DH 주소 — runtime 0x19 → 0x18 auto-probe (SDO=VCC vs SDO=GND).
// 03_1 단독 테스트에서 동작 확인됐다면 둘 중 하나로 응답.
static uint8_t LIS_ADDR = 0x19;
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

#define LIS_MOT_THS     0x10
#define LIS_MOT_DUR     0x06

#define LIS_EDGE_FILTER_MS  100UL
#define WAKE_BOUNCE_OBSERVE_MS  1000UL
#define WAKE_BOUNCE_LOW_RATIO    0.55f

#define DBG  1
#define DBGLN(...)  do { if (DBG) Serial.println(__VA_ARGS__); } while (0)
#define DBGP(...)   do { if (DBG) Serial.print(__VA_ARGS__); } while (0)

// =================================================================
// RTC slow-memory 카운터 (13_과 동일 의미)
// =================================================================
RTC_DATA_ATTR uint32_t rtc_boot_count        = 0;
RTC_DATA_ATTR uint32_t rtc_wake_count        = 0;
RTC_DATA_ATTR uint32_t rtc_wake_motion       = 0;
RTC_DATA_ATTR uint32_t rtc_wake_switch       = 0;
RTC_DATA_ATTR uint32_t rtc_no_fix_cycles     = 0;
RTC_DATA_ATTR uint32_t rtc_modem_fail_cycles = 0;
RTC_DATA_ATTR uint32_t rtc_brownout_count    = 0;
RTC_DATA_ATTR uint32_t rtc_last_sleep_uptime = 0;
RTC_DATA_ATTR uint32_t rtc_last_sleep_unix   = 0;
RTC_DATA_ATTR uint32_t rtc_lis_reinits       = 0;   // I2C wedge → LIS reinit 누적 (HW 결선 불안 진단)

static uint32_t cyc_fix_count        = 0;
static uint32_t cyc_no_fix_count     = 0;
static uint32_t cyc_post_ok          = 0;
static uint32_t cyc_post_fail        = 0;
static bool     wake_diag_pending    = true;

// ── 부저 ─────────────────────────────────────────────────────────
// 마일스톤 비프 플래그 — RTC_DATA_ATTR 로 deep sleep wake / brownout reset 거쳐도 보존.
// 한 device 세션 (전원 인가 ~ 완전 정전) 동안 트리플 비프는 각 1회.
// 운행 중 트리플이 자주 들리던 원인: brownout 으로 ESP 리셋 → static 변수 false → 매 부팅마다 다시 울림.
// RTC_DATA_ATTR 는 brownout 후에도 보존되므로 진짜 power-off 까지만 리셋됨.
// 부트 비프도 RTC 가드 — 배터리 운영 시 LTE bring-up 직전의 brownout-reboot 루프가
// "삐——" 10초 연속음 만들던 증상 fix. flag=set 을 beep 호출 *전에* 해서 beep 중 brownout 도 차단.
RTC_DATA_ATTR bool buzz_boot_done       = false;
RTC_DATA_ATTR bool buzz_first_fix_done  = false;
RTC_DATA_ATTR bool buzz_first_post_done = false;
RTC_DATA_ATTR bool buzz_low_batt_done   = false;   // 저전압 8-beep 경고 — RTC 가드로 반복 방지

#define LOW_BATT_BEEP_MV     3500   // vbat < 3500mV 면 1회 8-beep 경고

// 부저 non-blocking 상태머신.
static uint8_t  buzzerRemaining  = 0;
static uint16_t buzzerPulseMs    = 0;
static uint16_t buzzerGapMs      = 0;
static bool     buzzerIsOn       = false;
static uint32_t buzzerNextEdgeMs = 0;

// ⚠️ 핵심: tone() 의 3번째 인자(duration ms)를 반드시 넘긴다.
// 안 넘기면 hardware PWM 이 noTone() 호출 전까지 무한 재생됨.
// loop 가 LTE bring-up/HTTP POST 등으로 1-2분 블로킹되면 그 사이 updateBuzzer 가 안 불려서
// 비프가 그 시간 내내 울리는 버그가 됨. duration 을 주면 hardware 가 정확히 pulseMs 후 자동 정지.
static void beep(uint8_t count, uint16_t pulseMs, uint16_t gapMs) {
#if !BUZZER_ENABLED
  (void)count; (void)pulseMs; (void)gapMs;
  return;
#endif
  buzzerRemaining = count;
  buzzerPulseMs   = pulseMs;
  buzzerGapMs     = gapMs;
  if (count == 0) return;
  tone(PIN_BUZZER, BUZZER_FREQ, pulseMs);
  buzzerIsOn = true;
  buzzerNextEdgeMs = millis() + pulseMs;
}

static void updateBuzzer() {
  if (buzzerRemaining == 0 && !buzzerIsOn) return;
  uint32_t now = millis();
  if ((int32_t)(now - buzzerNextEdgeMs) < 0) return;
  if (buzzerIsOn) {
    noTone(PIN_BUZZER);   // hardware 가 이미 멈췄어도 state cleanup
    buzzerIsOn = false;
    if (buzzerRemaining > 0) buzzerRemaining--;
    if (buzzerRemaining > 0) buzzerNextEdgeMs = now + buzzerGapMs;
  } else if (buzzerRemaining > 0) {
    tone(PIN_BUZZER, BUZZER_FREQ, buzzerPulseMs);
    buzzerIsOn = true;
    buzzerNextEdgeMs = now + buzzerPulseMs;
  }
}

// sleep 직전엔 마지막 비프 끝까지 보장해야 무음 OFF 발생 방지 — 짧게 blocking
static void waitBuzzerFlush(uint32_t maxMs = 1500) {
  uint32_t t0 = millis();
  while ((buzzerRemaining > 0 || buzzerIsOn) && (millis() - t0) < maxMs) {
    updateBuzzer();
    delay(5);
  }
  noTone(PIN_BUZZER);
  buzzerIsOn = false;
  buzzerRemaining = 0;
}

// =================================================================
// 객체 / 상태
// =================================================================
TinyGPSPlus      gps;
HardwareSerial   gpsSerial(0);
HardwareSerial   lteSerial(1);

String   lastResp;
uint32_t bootMs   = 0;
uint32_t ttAtOkMs = 0;
uint32_t ttL80GnssMs = 0;
uint32_t lastFixMs   = 0;

// GPS UART 진단 — 0 이면 GPS 모듈/UART 끊김. >0 인데 sat=0 이면 안테나/하늘 문제.
uint32_t gpsCharsRx     = 0;
uint32_t gpsSentencesOk = 0;
uint32_t gpsFirstCharMs = 0;

// L80-R 가 부팅 직후 emit 하는 $GPTXT 안테나 상태 ("ANTENNA OK"/"OPEN"/"SHORT").
// 시리얼 디버그에 한 번만 출력. STATUS 라인에 lastAntennaStatus 짧게 포함.
char lastAntennaStatus[16] = "?";  // "OK" / "OPEN" / "SHORT" / "?"

char deviceUid[32] = "esp-unknown";
const char *wakeReasonStr = "boot";

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

volatile uint32_t motionEvents          = 0;
volatile uint32_t lastMotionMs          = 0;
uint32_t          motionEventsAtLastPost = 0;
bool              lisOk                 = false;
// LIS3DH I2C 헬스 — 연속 0xFF 응답 카운트. 임계 넘으면 Wire 재초기화 + lisInit 재시도.
uint32_t          lisI2cBadStreak       = 0;
uint32_t          lisLastReinitMs       = 0;

static void enterDeepSleep(const char *reason);
static volatile bool inSleepProcedure = false;

// ──────────────────────────────────────────────────────────────────
// 정지 감지 상태 — checkStationarySleep() 가 매 loop 마다 갱신.
// stationarySinceMs > 0 일 때 (millis - stationarySinceMs) 가 STATIONARY_WINDOW_MS 넘으면 sleep.
// ──────────────────────────────────────────────────────────────────
static uint32_t stationarySinceMs = 0;
static bool     stationaryLastEvalGpsAvail = false;
static float    stationaryLastDriftM       = 0;
static int      stationaryLastValidFixes   = 0;

// GPS 위치 ring buffer — 최근 fix 들 추적 (drift 계산용).
struct GpsSample {
  double   lat;
  double   lng;
  uint32_t at_ms;
};
static GpsSample gpsHist[GPS_HISTORY_N];
static uint8_t   gpsHistHead = 0;    // 다음에 쓸 위치
static bool      gpsHistFull = false;

static void gpsHistPush(double lat, double lng, uint32_t at_ms) {
  gpsHist[gpsHistHead] = { lat, lng, at_ms };
  gpsHistHead = (gpsHistHead + 1) % GPS_HISTORY_N;
  if (gpsHistHead == 0) gpsHistFull = true;
}

// 두 좌표 간 거리 (haversine, meter)
static float haversineM(double la1, double lo1, double la2, double lo2) {
  const double R = 6371000.0;
  const double r = M_PI / 180.0;
  double dLa = (la2 - la1) * r;
  double dLo = (lo2 - lo1) * r;
  double a = sin(dLa/2)*sin(dLa/2) +
             cos(la1*r) * cos(la2*r) * sin(dLo/2)*sin(dLo/2);
  return (float)(2.0 * R * asin(sqrt(a)));
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
  // 0x19 (SDO=VCC) → 0x18 (SDO=GND) 순서로 probe
  const uint8_t kCandidates[] = { 0x19, 0x18 };
  bool found = false;
  for (uint8_t a : kCandidates) {
    LIS_ADDR = a;
    uint8_t who = lisRead(LIS_WHO_AM_I);
    Serial.printf("[LIS] probe 0x%02X WHO=0x%02X%s\n", a, who,
                  who == 0x33 ? " <-- LIS3DH!" : "");
    if (who == 0x33) { found = true; break; }
  }
  if (!found) {
    DBGLN(F("[LIS] not found at 0x19/0x18 — check wiring (SDA=8 SCL=9) + SDO pin"));
    return false;
  }
  lisWrite(LIS_CTRL_REG1, 0x47);
  lisWrite(LIS_CTRL_REG2, 0xC1);
  lisWrite(LIS_CTRL_REG3, 0x40);
  lisWrite(LIS_CTRL_REG4, 0x88);
  lisWrite(LIS_CTRL_REG5, 0x08);
  lisWrite(LIS_CTRL_REG6, 0x02);
  (void)lisRead(LIS_REFERENCE);
  lisWrite(LIS_INT1_THS, LIS_MOT_THS);
  lisWrite(LIS_INT1_DUR, LIS_MOT_DUR);
  lisWrite(LIS_INT1_CFG, 0x2A);
  (void)lisRead(LIS_INT1_SRC);
  return true;
}

static volatile uint32_t lisEdgeFilterMs = 0;
static void IRAM_ATTR onLisInt() {
  uint32_t now = millis();
  if (now - lisEdgeFilterMs < LIS_EDGE_FILTER_MS) return;
  lisEdgeFilterMs = now;
  if (digitalRead(PIN_LIS_INT) == LOW) {
    motionEvents++;
    lastMotionMs = now;
  }
}

// ──────────────────────────────────────────────────────────────────
// 정지 자동 sleep — 매 loop 호출.
//  · LIS3DH 안 잡혔으면 sleep 자체 비활성화 (wake deadlock 방지)
//  · 부팅 직후 grace (60s) — 모듈 안정화 + first fix 대기
//  · LIS 모션 OFF 조건: 최근 MOTION_QUIET_MS 안에 이벤트 0건
//  · GPS 가용 시 (마지막 fix 가 GPS_STALE_MS 안):
//        recent fix history 의 max pairwise distance > GPS_DRIFT_THRESHOLD_M 면 이동
//  · 두 조건 모두 OK 면 stationarySinceMs 카운트 시작.
//    STATIONARY_WINDOW_MS 유지되면 sleep.
//  · 어느 한 조건이라도 깨지면 윈도우 즉시 reset.
// ──────────────────────────────────────────────────────────────────
static void checkStationarySleep() {
  if (inSleepProcedure) return;
  if (!lisOk) return;                                   // wake 수단 없음 → sleep 안 함
  uint32_t now = millis();
  if (now - bootMs < STATIONARY_BOOT_GRACE_MS) return;  // boot grace

  // 1) LIS 조용함 판정
  bool motionQuiet = (lastMotionMs == 0) || (now - lastMotionMs >= MOTION_QUIET_MS);
  if (!motionQuiet) {
    if (stationarySinceMs) DBGLN(F("[STAT] motion broke window → reset"));
    stationarySinceMs = 0;
    return;
  }

  // 2) GPS drift 계산 (가용 시) — recent fix 들의 max pairwise distance
  bool gpsAvail = (lastFixMs != 0) && (now - lastFixMs < GPS_STALE_MS);
  stationaryLastEvalGpsAvail = gpsAvail;
  if (gpsAvail) {
    int validN = 0;
    float maxDist = 0;
    int total = gpsHistFull ? GPS_HISTORY_N : gpsHistHead;
    for (int i = 0; i < total; i++) {
      const GpsSample &a = gpsHist[i];
      if (a.at_ms == 0) continue;
      if (now - a.at_ms > STATIONARY_WINDOW_MS) continue;
      validN++;
      for (int j = i + 1; j < total; j++) {
        const GpsSample &b = gpsHist[j];
        if (b.at_ms == 0) continue;
        if (now - b.at_ms > STATIONARY_WINDOW_MS) continue;
        float d = haversineM(a.lat, a.lng, b.lat, b.lng);
        if (d > maxDist) maxDist = d;
      }
    }
    stationaryLastValidFixes = validN;
    stationaryLastDriftM     = maxDist;
    if (validN >= 3 && maxDist > GPS_DRIFT_THRESHOLD_M) {
      if (stationarySinceMs) {
        Serial.printf("[STAT] gps moved %.1fm > %.0fm → reset\n",
                      maxDist, GPS_DRIFT_THRESHOLD_M);
      }
      stationarySinceMs = 0;
      return;
    }
  } else {
    stationaryLastValidFixes = 0;
    stationaryLastDriftM     = 0;
  }

  // 3) 윈도우 시작 / 만료
  if (stationarySinceMs == 0) {
    stationarySinceMs = now;
    Serial.printf("[STAT] window start (gps=%s drift=%.1fm fixes=%d)\n",
      gpsAvail ? "avail" : "stale",
      stationaryLastDriftM, stationaryLastValidFixes);
  } else if (now - stationarySinceMs >= STATIONARY_WINDOW_MS) {
    const char *reason = gpsAvail ? "stationary" : "stationary_lis_only";
    Serial.printf("[STAT] %lus stationary → sleep (reason=%s)\n",
      (unsigned long)((now - stationarySinceMs) / 1000), reason);
    enterDeepSleep(reason);
  }
}

// =================================================================
// utils
// =================================================================
static uint16_t readVbatMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(PIN_BAT);
  return (uint16_t)((sum / 16) * BAT_DIV_RATIO);
}

// =================================================================
// 상세 시리얼 STATUS — OLED 대체 단일 라인 (1초 주기).
//
// 형식:
//   [STATUS <uptime>s wake=<reason>][LTE OK/--  CSQ=N REG=N IP=...  POST=ok/try fs=N s=<status> bu=N hr=N]
//   [L80 FIX/--- sat=N lat=... lng=... fix_age=Ns ttff=Ns][mot t=N d=N age=Ns lis=ok/--][vbat=NmV][sw <grace>]
// 보통 한 줄로 길어 → 너비 위해 줄바꿈 한 번.
// =================================================================
static void printStatus() {
  uint32_t now = millis();
  uint32_t up_s = (now - bootMs) / 1000;

  // .isValid() 는 첫 fix 후 영구 true — sat 잃어도 stale 좌표 반환. age + sat 으로 freshness 강제.
  bool fix = gps.location.isValid()
          && gps.location.age() < 5000
          && gps.satellites.value() >= 4;
  uint32_t fixAge = lastFixMs ? (now - lastFixMs) / 1000 : 0;
  uint32_t motTotal = motionEvents;
  uint32_t motAgeS  = lastMotionMs ? (now - lastMotionMs) / 1000 : 0;

  Serial.printf(
    "[STATUS %lus wake=%s] LTE:%s CSQ=%d REG=%d IP=%s POST=%lu/%lu fs=%u s=%d bu=%u hr=%u\n",
    (unsigned long)up_s, wakeReasonStr,
    S.lteReady ? "OK" : "--",
    S.csq, S.reg, S.ip,
    (unsigned long)S.postOks, (unsigned long)S.postTries,
    (unsigned)S.failStreak, S.lastStatus,
    (unsigned)S.bringUpCount, (unsigned)S.hardResets);

  Serial.printf(
    "       L80:%s sat=%d nmea_rx=%lu ok=%lu",
    fix ? "FIX" : "---", (int)gps.satellites.value(),
    (unsigned long)gpsCharsRx, (unsigned long)gpsSentencesOk);
  if (fix) {
    Serial.printf(" lat=%.6f lng=%.6f fix_age=%lus ttff=%lus",
      gps.location.lat(), gps.location.lng(),
      (unsigned long)fixAge,
      (unsigned long)(ttL80GnssMs / 1000));
  } else if (gpsCharsRx == 0) {
    Serial.printf(" (NO NMEA — check D6/UART/baud)");
  } else if ((int)gps.satellites.value() == 0) {
    Serial.printf(" (NMEA flowing, no sat — antenna/sky)");
  } else {
    Serial.printf(" (acquiring)");
  }
  Serial.printf(" | mot t=%lu d=%lu age=%lus lis=%s reinits=%lu bad=%lu | vbat=%umV",
    (unsigned long)motTotal,
    (unsigned long)(motTotal - motionEventsAtLastPost),
    (unsigned long)motAgeS,
    lisOk ? "ok" : "--",
    (unsigned long)rtc_lis_reinits,
    (unsigned long)lisI2cBadStreak,
    (unsigned)readVbatMv());
  Serial.printf(" | ant=%s", lastAntennaStatus);

  // 정지 윈도우 진행 상황 (lisOk 시만 유효)
  if (lisOk && stationarySinceMs > 0) {
    uint32_t held = (now - stationarySinceMs) / 1000;
    uint32_t target = STATIONARY_WINDOW_MS / 1000;
    Serial.printf(" | stationary %lu/%lus drift=%.1fm fixes=%d gps=%s",
      (unsigned long)held, (unsigned long)target,
      stationaryLastDriftM, stationaryLastValidFixes,
      stationaryLastEvalGpsAvail ? "avail" : "stale");
  }
  // SIM 식별자 한 줄 (있을 때만, 페어링 디버그용)
  if (simIccid[0]) {
    size_t n = strlen(simIccid);
    const char *suffix = (n >= 8) ? simIccid + (n - 8) : simIccid;
    Serial.printf(" | SIM ...%s", suffix);
  }
  Serial.println();
}

// =================================================================
// LTE UART helpers (13_ 동일)
// =================================================================
static void drainLte() {
  while (lteSerial.available()) {
    char c = (char)lteSerial.read();
    lastResp += c;
    if (lastResp.length() > 2048) lastResp.remove(0, 1024);
  }
}

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
    if (!lteHealthy()) {
      if (DBG) { Serial.print(F("<< (UV abort) ")); Serial.println(lastResp); }
      return false;
    }
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
  lteSerial.print("AT+CPOF\r\n");
  delay(300);
  digitalWrite(PIN_PWR_EN, HIGH);
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
// LTE bring-up + HTTP (13_ 동일)
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
    // 등록 대기 중 주기적 상태 출력
    printStatus();
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
  if (simIccid[0] != 0 && simImei[0] != 0) return;

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

  if (simImei[0] == 0) {
    sendAT("AT+CGSN", "OK", 2000);
    extractLongDigitRun(lastResp, simImei, sizeof(simImei), 14, 16);
  }
  if (simImsi[0] == 0) {
    sendAT("AT+CIMI", "OK", 2000);
    extractLongDigitRun(lastResp, simImsi, sizeof(simImsi), 14, 16);
  }

  DBGP(F("[SIM] iccid=")); DBGLN(simIccid);
  DBGP(F("[SIM] imei="));  DBGLN(simImei);
  DBGP(F("[SIM] imsi="));  DBGLN(simImsi);

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

  // ── 응답 body 읽기 — 서버 명령 (예: beep) 처리 ──
  // +SHREQ 의 length 가 0 보다 크면 body 가 있다. AT+SHREAD=0,<len> 으로 받아옴.
  // body 가 작으니 JSON 파서 안 쓰고 substring 검색만.
  if (c2 > c1) {
    int len = lastResp.substring(c2 + 1).toInt();
    if (len > 0 && len < 512) {
      char readCmd[40];
      snprintf(readCmd, sizeof(readCmd), "AT+SHREAD=0,%d", len);
      // SIM7080G 의 SHREAD: "OK" 즉시 응답 + body 는 별도 "+SHREAD: <len>\r\n<body>" URC 로
      // 늦게 도착. expect="OK" 로 잡으면 body 도착 전 return → cmd:beep parse 실패.
      // expect="+SHREAD:" 으로 URC 기다리고, 그 후 body 까지 추가 drain.
      if (sendAT(readCmd, "+SHREAD:", 5000)) {
        uint32_t t0 = millis();
        while (millis() - t0 < 500) { drainLte(); delay(10); }
        // ── 서버가 cmd: beep 보냈으면 부저 트리거 ──
        if (lastResp.indexOf("\"cmd\":\"beep\"") >= 0
         || lastResp.indexOf("\"cmd\": \"beep\"") >= 0) {
          DBGLN(F("[BUZ] 🔔 server cmd: beep — 현장 식별 트리거"));
          // 이전 작동 확인된 패턴 — 변경하지 말 것.
          beep(5, 200, 100);
        }
      }
    }
  }

  sendAT("AT+SHDISC", "OK", 3000);
  return true;
}

// =================================================================
// payload (13_ 동일)
// =================================================================
static void simFragment(char *out, size_t cap) {
  if (simIccid[0] || simImei[0] || simImsi[0]) {
    snprintf(out, cap, ",\"iccid\":\"%s\",\"imei\":\"%s\",\"imsi\":\"%s\"",
             simIccid, simImei, simImsi);
  } else {
    out[0] = 0;
  }
}

static void countFixForCycle(bool got_fix) {
  if (got_fix) cyc_fix_count++;
  else if (S.csq > 0) cyc_no_fix_count++;
}

// 정지 자동 sleep 상태 JSON 단편 — 서버에서 카운트다운 / 좌표 바운더리 / 흔들 시 리셋 가시화.
//   active        : 정지 윈도우 진행 중 (= stationarySinceMs != 0)
//   held_s        : 정지 유지 시간 (초)
//   window_s      : 목표 (STATIONARY_WINDOW_MS / 1000 = 300)
//   sleep_in_s    : window_s - held_s (0 이면 곧 sleep)
//   drift_m       : 최근 5분 fix 들의 max pairwise distance (현재값)
//   threshold_m   : GPS_DRIFT_THRESHOLD_M (= 50, 임계 가시화)
//   fixes         : 윈도우 내 유효 fix 수
//   gps_avail     : GPS 가용 여부 (false 면 lis_only 판정 중)
//   motion_age_s  : 마지막 모션 이벤트 이후 경과 (0 = 아직 모션 없음)
static void buildStationaryFragment(char *out, size_t cap) {
  uint32_t now = millis();
  bool active = (stationarySinceMs != 0);
  uint32_t held_s   = active ? (now - stationarySinceMs) / 1000 : 0;
  uint32_t window_s = STATIONARY_WINDOW_MS / 1000;
  uint32_t sleep_in_s = (held_s >= window_s) ? 0 : (window_s - held_s);
  uint32_t motion_age_s = lastMotionMs ? (now - lastMotionMs) / 1000 : 0;
  snprintf(out, cap,
    ",\"stationary\":{\"active\":%s,\"held_s\":%lu,\"window_s\":%lu,\"sleep_in_s\":%lu,"
    "\"drift_m\":%.1f,\"threshold_m\":%.1f,\"fixes\":%d,\"gps_avail\":%s,\"motion_age_s\":%lu,"
    "\"lis_ok\":%s,\"lis_reinits\":%lu}",
    active ? "true" : "false",
    (unsigned long)held_s, (unsigned long)window_s, (unsigned long)sleep_in_s,
    stationaryLastDriftM, (float)GPS_DRIFT_THRESHOLD_M,
    stationaryLastValidFixes,
    stationaryLastEvalGpsAvail ? "true" : "false",
    (unsigned long)motion_age_s,
    lisOk ? "true" : "false",
    (unsigned long)rtc_lis_reinits);
}

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
  // sticky-fix 방어: .isValid() 만 보면 첫 fix 후 sat 0 이어도 true 유지 → 백엔드가 stale 좌표를
  // 새 fix 처럼 인식. age (마지막 NMEA update) + sat 카운트로 freshness 강제.
  bool l80fix = gps.location.isValid()
             && gps.location.age() < 5000
             && gps.satellites.value() >= 4;
  uint32_t motTotal = motionEvents;
  uint32_t motDelta = motTotal - motionEventsAtLastPost;
  uint32_t motAgeS  = lastMotionMs ? (millis() - lastMotionMs) / 1000 : 0;
  motionEventsAtLastPost = motTotal;

  countFixForCycle(l80fix);

  char sim[96]; simFragment(sim, sizeof(sim));
  char diag[320];
  buildDiagFragment(diag, sizeof(diag), wake_diag_pending);
  char stat[256];
  buildStationaryFragment(stat, sizeof(stat));

  if (l80fix) {
    // heading: NMEA $GPRMC course over ground (0-360°). 정지 시 isValid()=false → null 로 보냄.
    float heading = gps.course.isValid() ? gps.course.deg() : -1.0f;
    char headingFrag[24];
    if (heading >= 0) snprintf(headingFrag, sizeof(headingFrag), ",\"heading\":%.1f", heading);
    else              headingFrag[0] = 0;

    snprintf(out, cap,
      "{\"device_uid\":\"%s\"%s,\"ts\":%lu,\"awake\":%lu,\"csq\":%d,\"reg\":%d,"
      "\"vbat_mv\":%lu,\"at_ms\":%lu,"
      "\"l80\":{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sat\":%d,\"ttff_s\":%lu%s},"
      "\"motion\":{\"total\":%lu,\"delta\":%lu,\"age_s\":%lu}%s,"
      "\"wake\":\"%s\"%s}",
      deviceUid, sim,
      (unsigned long)((millis() - bootMs) / 1000),
      (unsigned long)S.bringUpCount,
      S.csq, S.reg, (unsigned long)vbatMv, (unsigned long)ttAtOkMs,
      gps.location.lat(), gps.location.lng(),
      (int)gps.satellites.value(),
      (unsigned long)(ttL80GnssMs / 1000),
      headingFrag,
      (unsigned long)motTotal, (unsigned long)motDelta, (unsigned long)motAgeS,
      stat,
      wakeReasonStr, diag);
  } else {
    snprintf(out, cap,
      "{\"device_uid\":\"%s\"%s,\"ts\":%lu,\"awake\":%lu,\"csq\":%d,\"reg\":%d,"
      "\"vbat_mv\":%lu,\"at_ms\":%lu,"
      "\"l80\":{\"fix\":false,\"sat\":%d},"
      "\"motion\":{\"total\":%lu,\"delta\":%lu,\"age_s\":%lu}%s,"
      "\"wake\":\"%s\"%s}",
      deviceUid, sim,
      (unsigned long)((millis() - bootMs) / 1000),
      (unsigned long)S.bringUpCount,
      S.csq, S.reg, (unsigned long)vbatMv, (unsigned long)ttAtOkMs,
      (int)gps.satellites.value(),
      (unsigned long)motTotal, (unsigned long)motDelta, (unsigned long)motAgeS,
      stat,
      wakeReasonStr, diag);
  }
}

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
  char body[1280];   // stationary fragment 추가 (~250B) 로 1024 → 1280
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
      wake_diag_pending = false;
      if (!buzz_first_post_done) {
        buzz_first_post_done = true;
        DBGLN(F("[BUZ] 🎉 첫 POST 200 — 4-beep"));
        beep(4, 80, 80);
      }
    } else {
      cyc_post_fail++;
    }
  } else {
    S.lastStatus = -1;
    cyc_post_fail++;
  }

  if (lastResp.indexOf("UNDER-VOLTAGE") >= 0 || lastResp.indexOf("POWER DOWN") >= 0) {
    DBGLN(F("[POST] under-voltage detected → cooldown 60s"));
    S.lteReady      = false;
    S.failStreak    = 0;
    S.nextBringUpAt = millis() + UNDER_VOLT_COOLDOWN_MS;
  }

  // 저전압 경고 — 한 device 세션 동안 1회. POST cycle 직후 vbat 측정 (LTE peak 직후라 droop 반영).
  if (!buzz_low_batt_done && readVbatMv() < LOW_BATT_BEEP_MV) {
    buzz_low_batt_done = true;
    DBGLN(F("[BUZ] 🪫 low battery — 8-beep"));
    beep(8, 80, 80);
  }
}

// =================================================================
// Deep sleep
// =================================================================
static void enterDeepSleep(const char *reason) {
  if (inSleepProcedure) return;
  inSleepProcedure = true;

  DBGP(F("[SLEEP] entering deep sleep — wake on LIS motion (reason="));
  DBGP(reason); DBGLN(F(")"));

  DBGLN(F("[BUZ] 💤 sleep — 2-beep (이전 작동 확인된 짧은 패턴 — 6-beep 의 빠른 PWM transient 가 PWR_EN HIGH 전 brownout 트리거 의심)"));
  beep(2, 100, 100);
  waitBuzzerFlush();

  if (cyc_fix_count == 0 && cyc_no_fix_count > 0) rtc_no_fix_cycles++;
  if (S.csq <= 0)                                 rtc_modem_fail_cycles++;
  rtc_last_sleep_uptime = (millis() - bootMs) / 1000;

  if (S.lteReady) {
    char body[640];
    buildSleepPayload(body, sizeof(body), reason);
    DBGP(F("[SLEEP] tx sleep_enter: ")); DBGLN(body);
    int status = -1;
    httpPostJson(POST_URL_HOST, POST_PATH, body, &status);
    DBGP(F("[SLEEP] sleep_enter http=")); DBGLN(status);
  } else {
    DBGLN(F("[SLEEP] LTE not ready — sleep_enter event lost"));
  }

  ltePowerOff();

  detachInterrupt(digitalPinToInterrupt(PIN_LIS_INT));

  // LIS INT 핀이 안정적으로 HIGH 가 될 때까지 대기 (자가-wake 방지). max 10s.
  uint32_t settleStart = millis();
  uint32_t highStableSince = 0;
  while (millis() - settleStart < 10000) {
    (void)lisRead(LIS_INT1_SRC);
    delay(20);
    if (digitalRead(PIN_LIS_INT) == HIGH) {
      if (highStableSince == 0) highStableSince = millis();
      if (millis() - highStableSince >= 300) break;
    } else {
      highStableSince = 0;
    }
  }
  DBGP(F("[SLEEP] LIS settled in ")); DBGP(millis() - settleStart); DBGLN(F("ms"));
  (void)lisRead(LIS_INT1_SRC);
  delay(500);
  (void)lisRead(LIS_INT1_SRC);

  // wake 핀 = LIS_INT only. LIS init 실패면 checkStationarySleep 가 호출조차 안 하니
  // 이 경로엔 도달하지 않지만, 방어적으로 한 번 더 가드.
  // [14_j] bench test — timer wake 8s 강제 활성. LIS 없어도 sleep 진행.
  if (lisOk) {
    uint64_t mask = (1ULL << PIN_LIS_INT);
    esp_deep_sleep_enable_gpio_wakeup(mask, ESP_GPIO_WAKEUP_GPIO_LOW);
  } else {
    DBGLN(F("[SLEEP] LIS not OK — timer-only wake"));
  }
  esp_sleep_enable_timer_wakeup(8ULL * 1000000ULL);   // 8s 자동 wake

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
    case ESP_RST_BROWNOUT:   return "BROWNOUT";
    case ESP_RST_SDIO:       return "SDIO";
    default:                 return "UNKNOWN";
  }
}

// =================================================================
// setup / loop
// =================================================================
void setup() {
  // ⚠️ 안전장치: 이전 부팅에서 brownout 직전 호출된 tone() 의 LEDC PWM 이 잔존할 수 있음.
  // Serial 시작 전에 강제 정지. BUZZER_ENABLED=0 이어도 하드웨어 잔존 PWM 차단 위해 무조건 호출.
  pinMode(PIN_BUZZER, OUTPUT);
  noTone(PIN_BUZZER);
  digitalWrite(PIN_BUZZER, LOW);

  bootMs = millis();

  Serial.begin(115200);
  delay(2000);   // USB CDC 안정화 대기
  DBGLN();
  DBGLN(F("=== 13_1_motion_aware_tracker (OLED-less, verbose serial) ==="));

  esp_reset_reason_t rr = esp_reset_reason();
  DBGP(F("[BOOT] reset_reason=")); DBGLN(resetReasonStr(rr));

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
    rtc_lis_reinits       = 0;
  } else {
    rtc_boot_count++;
    if (rr == ESP_RST_BROWNOUT) rtc_brownout_count++;
  }

  esp_sleep_wakeup_cause_t wc = esp_sleep_get_wakeup_cause();
  if (wc == ESP_SLEEP_WAKEUP_GPIO) {
    rtc_wake_count++;
    uint64_t status = esp_sleep_get_gpio_wakeup_status();
    if (status & (1ULL << PIN_LIS_INT)) { wakeReasonStr = "motion"; rtc_wake_motion++; }
    else                                  wakeReasonStr = "gpio";
    // 정상 deep sleep wake — wake 마다 첫 fix / 첫 POST milestone beep 다시 들리게 reset.
    // 운영자가 매 wake 후 "LTE 살았는지 / GPS 잡혔는지" 청각 확인. brownout reset 은 RTC 보존이라
    // 영향 없음 (이 분기는 진짜 motion/gpio wake 일 때만).
    buzz_first_fix_done  = false;
    buzz_first_post_done = false;
  } else {
    wakeReasonStr = wakeCauseStr(wc);
  }
  Serial.printf("[BOOT] wake=%s boots=%lu wakes=%lu motion_wakes=%lu brown=%lu\n",
    wakeReasonStr,
    (unsigned long)rtc_boot_count, (unsigned long)rtc_wake_count,
    (unsigned long)rtc_wake_motion, (unsigned long)rtc_brownout_count);

  // Motion wake bounce 검출
  if (wakeReasonStr == "motion") {
    pinMode(PIN_LIS_INT, INPUT_PULLUP);
    Wire.begin(PIN_SDA, PIN_SCL);
    delay(20);
    uint8_t who = lisRead(LIS_WHO_AM_I);
    bool lisOK = (who == 0x33);
    if (!lisOK) {
      DBGP(F("[WAKE] LIS unresponsive (WHO=0x"));
      DBGP(who, HEX); DBGLN(F(") — bounce check skipped"));
      goto skip_bounce_check;
    }
    (void)lisRead(LIS_INT1_SRC);

    {
      uint32_t obsStart = millis();
      uint32_t lowCount = 0, totalCount = 0;
      while (millis() - obsStart < WAKE_BOUNCE_OBSERVE_MS) {
        if (digitalRead(PIN_LIS_INT) == LOW) lowCount++;
        totalCount++;
        delay(20);
        if (totalCount % 5 == 0) (void)lisRead(LIS_INT1_SRC);
      }
      float ratio = totalCount > 0 ? (float)lowCount / totalCount : 0;
      DBGP(F("[WAKE] motion bounce check ratio=")); DBGLN(ratio);
      if (ratio > WAKE_BOUNCE_LOW_RATIO) {
        DBGLN(F("[WAKE] sustained vibration → re-sleep (가짜 wake)"));
        if (rtc_wake_motion > 0) rtc_wake_motion--;
        if (rtc_wake_count  > 0) rtc_wake_count--;
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
        uint64_t mask = (1ULL << PIN_LIS_INT);
        esp_deep_sleep_enable_gpio_wakeup(mask, ESP_GPIO_WAKEUP_GPIO_LOW);
        Serial.flush();
        esp_deep_sleep_start();
      }
    }
  }
  skip_bounce_check: ;

  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);   // [14_b] L80+LTE ON, delay(300) 제거 검증

  // ── 부저 init + 부팅/wake 비프 ──
  // ⚠️ LTE bring-up 직전이라 이 비프가 끝날 때까지 명시적으로 기다림.
  // 안 그러면 LTE 30s+ 블로킹 동안 updateBuzzer 가 안 불려도 hardware 는 duration 자동 정지로 안전한데
  // 그래도 시퀀스 (2-pulse wake) 의 두번째 비프 타이밍이 어긋날 수 있어서 flush.
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  {
    esp_sleep_wakeup_cause_t wc = esp_sleep_get_wakeup_cause();
    // motion wake (정상 deep sleep 후 LIS 트리거) 는 매번 울림 — wake_cause=GPIO 면 진짜 wake.
    // cold boot 는 RTC 가드 — brownout 재부팅 루프 시 반복 차단.
    if (wc == ESP_SLEEP_WAKEUP_GPIO || wc == ESP_SLEEP_WAKEUP_EXT0 || wc == ESP_SLEEP_WAKEUP_EXT1) {
      DBGLN(F("[BUZ] 🚀 wake from sleep (motion) — 6-beep"));
      beep(6, 50, 50);
    } else if (!buzz_boot_done) {
      buzz_boot_done = true;   // ← 진짜 power-off 까지 RTC 보존
      DBGLN(F("[BUZ] 🚀 cold boot — long beep"));
      beep(1, 400, 0);
    } else {
      DBGLN(F("[BUZ] (skip) cold boot 비프 이미 울림 — brownout 재부팅 추정"));
    }
    waitBuzzerFlush();
  }

  pinMode(PIN_LIS_INT, INPUT_PULLUP);   // active-low LIS — idle HIGH (외부 신호)

  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(deviceUid, sizeof(deviceUid), "esp-%02x%02x%02x%02x%02x%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  Serial.printf("[BOOT] device_uid=%s\n", deviceUid);

  analogReadResolution(12);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);

  // LIS3DH init (OLED 없이 I2C 단일 소비자)
  lisOk = lisInit();
  if (lisOk) {
    DBGLN(F("[LIS] OK (active-low, motion=fall)"));
    attachInterrupt(digitalPinToInterrupt(PIN_LIS_INT), onLisInt, CHANGE);
  } else {
    DBGLN(F("[LIS] init failed — proceeding without motion"));
  }

  gpsSerial.setRxBufferSize(4096);   // LTE bringup 동안 NMEA overflow 방지 (~4s 분량)
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);

  lteSerial.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);
  ltePowerOn();
  if (lteBringUp()) {
    fetchSimInfo();
  }

  S.nextBringUpAt = millis() + BRINGUP_RETRY_MS;
  S.nextPostAt    = millis() + 2000;

  // 첫 STATUS 라인
  printStatus();
}

void loop() {
  // [14_j] 강제 sleep 사이클 — 첫 POST 성공 시 즉시 sleep, 8s timer wake 로 반복.
  if (cyc_post_ok > 0) enterDeepSleep("test_after_first_post");
  else if (millis() > 120000UL) enterDeepSleep("test_timeout_120s");

  // GPS 피드 — NMEA 문자 카운트로 UART 정상 여부 진단 + fix 시 history 에 push
  static uint32_t lastGpsHistPushMs = 0;
  // 안테나 상태 스캐너 — NMEA 스트림 어디에 "ANTENNA <상태>" 가 나오든 즉시 잡음.
  // 셋업 라인 ($GPTXT) 에 한정 X. L80-R 가 상태 변경 시 emit 하므로 매 char scan.
  // 상태머신: "ANTENNA " 8자 패턴 매칭 후 delimiter (',' '*' '\r' '\n' 공백) 전까지 단어 수집.
  static const char ANT_PAT[] = "ANTENNA ";
  static uint8_t  antMatchIdx = 0;
  static bool     antCollecting = false;
  static char     antStatusBuf[12];
  static uint8_t  antStatusIdx = 0;

  while (gpsSerial.available()) {
    char c = (char)gpsSerial.read();
    if (!gpsFirstCharMs) {
      gpsFirstCharMs = millis();
      Serial.printf("[L80] first NMEA char @+%.1fs\n", (gpsFirstCharMs - bootMs) / 1000.0f);
    }
    gpsCharsRx++;

    // ── 안테나 키워드 매칭 (NMEA 구조와 무관, 매 char 적용) ─────────────
    if (antCollecting) {
      // "ANTENNA " 매칭 후 상태 단어 수집 중
      if (c == ',' || c == '*' || c == '\r' || c == '\n' || c == ' '
          || antStatusIdx >= sizeof(antStatusBuf) - 1) {
        antStatusBuf[antStatusIdx] = 0;
        if (antStatusIdx > 0) {
          // 변화 있을 때만 시리얼 echo (스팸 방지) — 첫 감지 또는 상태 변경 시
          bool changed = strncmp(lastAntennaStatus, antStatusBuf, sizeof(lastAntennaStatus)) != 0;
          strncpy(lastAntennaStatus, antStatusBuf, sizeof(lastAntennaStatus) - 1);
          lastAntennaStatus[sizeof(lastAntennaStatus) - 1] = 0;
          if (changed) {
            Serial.printf("[L80] antenna=%s (boot+%.1fs)\n",
              lastAntennaStatus, (millis() - bootMs) / 1000.0f);
          }
        }
        antCollecting = false;
        antMatchIdx = 0;
        antStatusIdx = 0;
      } else {
        antStatusBuf[antStatusIdx++] = c;
      }
    } else {
      // "ANTENNA " 8자 패턴 매칭
      if (c == ANT_PAT[antMatchIdx]) {
        antMatchIdx++;
        if (antMatchIdx >= 8) {
          antCollecting = true;
          antStatusIdx = 0;
        }
      } else {
        // 매칭 실패 — 'A' 부터 다시 시작 가능한지
        antMatchIdx = (c == ANT_PAT[0]) ? 1 : 0;
      }
    }

    if (gps.encode(c)) {
      gpsSentencesOk++;
      if (gps.location.isValid()) {
        uint32_t now = millis();
        if (ttL80GnssMs == 0) {
          ttL80GnssMs = now - bootMs;
          Serial.printf("[L80] *** FIRST FIX *** ttff=%.1fs sat=%d lat=%.6f lng=%.6f\n",
            ttL80GnssMs / 1000.0f, (int)gps.satellites.value(),
            gps.location.lat(), gps.location.lng());
          if (!buzz_first_fix_done) {
            buzz_first_fix_done = true;
            DBGLN(F("[BUZ] 🎉 첫 GPS fix — triple beep"));
            beep(3, 80, 80);
          }
        }
        lastFixMs = now;
        // 정지 판정용 history 에 ~10초마다 push (너무 빠르면 fix 노이즈가 윈도우를 흔듦)
        if (now - lastGpsHistPushMs >= 10000) {
          lastGpsHistPushMs = now;
          gpsHistPush(gps.location.lat(), gps.location.lng(), now);
        }
      }
    }
  }

  // 자동 정지 sleep 평가
  checkStationarySleep();

  // 모션 이벤트 신규 발생 시 즉시 로그
  static uint32_t lastMotionLogged = 0;
  if (motionEvents != lastMotionLogged) {
    Serial.printf("[MOT] event #%lu (total=%lu, age=0s)\n",
      (unsigned long)(motionEvents - lastMotionLogged),
      (unsigned long)motionEvents);
    lastMotionLogged = motionEvents;
  }

  // LIS3DH latch 정리 + 헬스 체크 (50ms마다).
  // 연속 0xFF 20회 (= 1초) 응답 없음이면 I2C wedge / 결선 불량으로 보고 Wire 재초기화.
  // lisInit 재실행으로 0x18/0x19 auto-probe 다시 수행 (배선 흔들림으로 SDO 가 잠시 floating
  // 됐다 회복되는 경우 자동 복구).
  static uint32_t lastLisPoll = 0;
  if (lisOk && millis() - lastLisPoll > 50) {
    lastLisPoll = millis();
    uint8_t src = lisRead(LIS_INT1_SRC);
    if (src == 0xFF) {
      lisI2cBadStreak++;
      if (lisI2cBadStreak >= 20) {
        Serial.printf("[LIS] I2C wedge — reinit attempt #%lu\n",
                      (unsigned long)(rtc_lis_reinits + 1));
        detachInterrupt(digitalPinToInterrupt(PIN_LIS_INT));
        Wire.end(); delay(10);
        Wire.begin(PIN_SDA, PIN_SCL);
        Wire.setClock(400000);
        lisOk = lisInit();
        rtc_lis_reinits++;
        lisLastReinitMs = millis();
        lisI2cBadStreak = 0;
        if (lisOk) {
          attachInterrupt(digitalPinToInterrupt(PIN_LIS_INT), onLisInt, CHANGE);
          Serial.println(F("[LIS] reinit OK"));
        } else {
          Serial.println(F("[LIS] reinit FAIL — wake source lost, sleep disabled"));
        }
      }
    } else {
      lisI2cBadStreak = 0;
    }
  }

  // LTE / POST 사이클
  if (!S.lteReady) {
    if ((int32_t)(millis() - S.nextBringUpAt) >= 0) {
      Serial.printf("[LTE] retry bring-up (fails=%u)\n", (unsigned)S.bringUpFails);

      if (S.bringUpFails >= BRINGUP_FAIL_HARD_RESET) {
        S.bringUpFails = 0;
        S.hardResets++;
        DBGLN(F("[BUZ] ⚠️ LTE hard reset — 7-beep"));
        beep(7, 60, 60);
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
        Serial.printf("[LTE] bring-up OK (count=%u CSQ=%d REG=%d IP=%s)\n",
          (unsigned)S.bringUpCount, S.csq, S.reg, S.ip);
        fetchSimInfo();
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

  // 주기적 STATUS — OLED 대신
  static uint32_t lastStatusMs = 0;
  if (millis() - lastStatusMs > STATUS_PRINT_MS) {
    lastStatusMs = millis();
    printStatus();
  }

  // ── 시리얼 'a' 입력 → 강제 sleep 진입 (하드웨어 진단용) ──
  // sleep 진입 후 USB-CDC 끊김 → 시리얼 잠시 보이지 않음. 자이로 흔들기로 motion wake.
  // hardware 개발자가 sleep 동작 (PWR_EN HIGH / 모듈 OFF / wake 복귀) 직접 검증 가능.
  if (Serial.available()) {
    int c = Serial.read();
    if (c == 'a' || c == 'A') {
      DBGLN(F("[TEST] 'a' 입력 → 강제 sleep 진입"));
      enterDeepSleep("manual_test");
    }
  }

  drainLte();
  updateBuzzer();
  delay(10);
}
