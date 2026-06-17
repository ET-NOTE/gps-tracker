// 03_5 — 모션-aware combined living-check (03_1 + 03_3 + 03_4)
//
// 구성:
//   LIS3DH (I2C 모션)  +  L80 (UART0 GPS NMEA)  +  SIM7080G (UART1 LTE AT)
//   PWR_EN GPIO6 = L80/SIM7080 공유 전원 (LOW=ON, HIGH=OFF)
//
// 동작:
//   부팅 → AWAKE 180s 시작 → GPS NMEA 스트림 + LTE AT/OK 폴링
//   180초 무 모션 → SLEEP (GPIO6 HIGH = 모듈 OFF)
//   SLEEP 중 LIS 모션 → AWAKE 갱신 (GPIO6 LOW + LTE PWRKEY 재펄스 + 180s 타이머)
//
// 디버그:
//   1초마다 한 줄 통합 헬스라인 — PWR / LIS / GPS / LTE 한눈에
//   [PWR] 전이 시점 별도 라인
//   필요 시 라인별 raw 한글 태그는 코드 안 주석 풀면 복원
//
// IDE 옵션:  USB CDC On Boot = Enabled  (없으면 시리얼 안 보임)

#include <Wire.h>
#include <HardwareSerial.h>

// ─── 핀 ───────────────────────────────────────────────────
#define PIN_SDA       8
#define PIN_SCL       9
#define PIN_INT       5     // LIS3DH INT1
#define PIN_PWR_EN    6     // L80 + SIM7080 공유 전원 (LOW=ON)

#define PIN_GPS_RX   20     // ESP RX  ← L80 TX
#define PIN_GPS_TX   21     // ESP TX  → L80 RX
#define GPS_BAUD     9600UL

// PCB rev: RX/TX swap (2025-06-17 신규 보드)
#define PIN_LTE_RX    2     // ESP RX  ← SIM TX
#define PIN_LTE_TX    4     // ESP TX  → SIM RX
#define PIN_PWRKEY    7
#define PIN_DTR      10
#define LTE_BAUD     115200UL

// ─── 부저 ─────────────────────────────────────────────────
#define PIN_BUZZER    1     // passive 마그네틱 부저 — PWM (tone) 으로 구동해야 들림
#define BUZZER_FREQ   2700  // Hz — 일반 마그네틱 부저 공진주파수 근처 (2-4kHz 권장)

// ─── 부저 상태머신 (non-blocking 연속 펄스) ─────────────
uint8_t  buzzerRemaining = 0;     // 남은 펄스 수 (한 펄스 = ON + OFF gap)
uint16_t buzzerPulseMs   = 0;
uint16_t buzzerGapMs     = 0;
bool     buzzerIsOn      = false;
uint32_t buzzerNextEdgeMs= 0;

// ⚠️ tone() duration 인자 필수. 안 주면 hardware PWM 이 noTone 까지 무한 재생됨 —
// loop 가 블로킹되면 그 시간 내내 비프 울리는 버그.
static void beep(uint8_t count, uint16_t pulseMs, uint16_t gapMs) {
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
    noTone(PIN_BUZZER);
    buzzerIsOn = false;
    if (buzzerRemaining > 0) buzzerRemaining--;
    if (buzzerRemaining > 0) buzzerNextEdgeMs = now + buzzerGapMs;   // gap → 다음 펄스
  } else if (buzzerRemaining > 0) {
    tone(PIN_BUZZER, BUZZER_FREQ, buzzerPulseMs);
    buzzerIsOn = true;
    buzzerNextEdgeMs = now + buzzerPulseMs;
  }
}

// ─── 모션-aware 전원 상태머신 ────────────────────────────
#define AWAKE_DURATION_MS    180000UL   // 마지막 모션 이후 180s 유지 (모듈 부팅 사이클 충분)

enum PwrState { PWR_AWAKE, PWR_SLEEP };
PwrState  pwrState         = PWR_AWAKE;
uint32_t  awakeUntilMs     = 0;
uint32_t  lastSeenHwMotion = 0;
uint32_t  awakeEnterCount  = 0;
uint32_t  sleepEnterCount  = 0;

// 부저 트리거 추적 (첫 이벤트만)
bool      lteFirstOkBeeped  = false;
bool      gpsFirstFixBeeped = false;

// ─── LIS3DH ──────────────────────────────────────────────
uint8_t lisAddr = 0;
#define LIS_WHO_AM_I    0x0F
#define LIS_CTRL_REG1   0x20
#define LIS_CTRL_REG2   0x21
#define LIS_CTRL_REG3   0x22
#define LIS_CTRL_REG4   0x23
#define LIS_CTRL_REG5   0x24
#define LIS_REFERENCE   0x26
#define LIS_OUT_X_L     0x28
#define LIS_INT1_CFG    0x30
#define LIS_INT1_SRC    0x31
#define LIS_INT1_THS    0x32
#define LIS_INT1_DUR    0x33

#define MOT_THRESHOLD   0x18   // 384mg
#define MOT_DURATION    0x02   // 40ms

uint32_t hwMotionCount = 0;
uint32_t swMotionCount = 0;
uint32_t lastSwMotionMs = 0;
uint8_t  lastSrc = 0;
uint32_t i2cBadStreak = 0;
uint32_t i2cReinitCount = 0;
volatile uint32_t intRiseCount = 0;
volatile uint32_t intFallCount = 0;

static void IRAM_ATTR onIntChange() {
  if (digitalRead(PIN_INT)) intRiseCount++; else intFallCount++;
}

static void lisWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(lisAddr);
  Wire.write(reg); Wire.write(val);
  Wire.endTransmission();
}
static uint8_t lisRead(uint8_t reg) {
  Wire.beginTransmission(lisAddr);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((int)lisAddr, 1);
  return Wire.available() ? Wire.read() : 0xFF;
}
static void lisReadN(uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(lisAddr);
  Wire.write(reg | 0x80);   // auto-increment
  Wire.endTransmission(false);
  Wire.requestFrom((int)lisAddr, (int)n);
  for (uint8_t i = 0; i < n && Wire.available(); i++) buf[i] = Wire.read();
}

static bool detectLis() {
  const uint8_t kAddrs[] = { 0x18, 0x19, 0x1E, 0x1D };
  for (uint8_t a : kAddrs) {
    Wire.beginTransmission(a);
    Wire.write(LIS_WHO_AM_I);
    if (Wire.endTransmission(false) != 0) continue;
    if (Wire.requestFrom((int)a, 1) != 1 || !Wire.available()) continue;
    uint8_t who = Wire.read();
    Serial.printf("[LIS]   0x%02X: WHO=0x%02X %s\n", a, who, who == 0x33 ? "<-- LIS3DH" : "");
    if (who == 0x33) { lisAddr = a; return true; }
  }
  return false;
}

static void lisConfig() {
  lisWrite(LIS_CTRL_REG1, 0x47);   // ODR=50Hz, XYZ enable
  lisWrite(LIS_CTRL_REG2, 0xC1);   // HPF autoreset + 적용 to AOI1
  lisWrite(LIS_CTRL_REG3, 0x40);   // I1_AOI1 → INT1
  lisWrite(LIS_CTRL_REG4, 0x88);   // BDU + ±2g + HR
  lisWrite(LIS_CTRL_REG5, 0x08);   // LIR_INT1 latch
  (void)lisRead(LIS_REFERENCE);
  lisWrite(LIS_INT1_THS, MOT_THRESHOLD);
  lisWrite(LIS_INT1_DUR, MOT_DURATION);
  lisWrite(LIS_INT1_CFG, 0x2A);    // ZHIE | YHIE | XHIE (OR mode)
  (void)lisRead(LIS_INT1_SRC);     // 부팅 latch 클리어
}

static void lisReadAccel(float *gx, float *gy, float *gz) {
  uint8_t raw[6];
  lisReadN(LIS_OUT_X_L, raw, 6);
  int16_t x = (int16_t)((raw[1] << 8) | raw[0]) >> 4;
  int16_t y = (int16_t)((raw[3] << 8) | raw[2]) >> 4;
  int16_t z = (int16_t)((raw[5] << 8) | raw[4]) >> 4;
  *gx = x * 0.001f; *gy = y * 0.001f; *gz = z * 0.001f;
}

// ─── GPS (L80, UART0) ────────────────────────────────────
HardwareSerial gpsSerial(0);
char     gpsLine[200];
uint16_t gpsLineLen = 0;
uint32_t gpsBytes = 0, gpsLines = 0, gpsSilentSinceMs = 0;
uint32_t cntGGA = 0, cntRMC = 0, cntGSV = 0;
int      lastFix = -1, lastSatsUsed = -1, lastSatsView = -1, lastGsaMode = -1;
char     lastRmcStat = 0;
char     lastRmcTime[12] = {0};
bool     haveFix = false;

static void getField(const char* l, int idx, char* out, size_t outsz) {
  size_t i = 0, fi = 0, oi = 0;
  while (l[i] && fi < (size_t)idx) { if (l[i] == ',') fi++; i++; }
  while (l[i] && l[i] != ',' && l[i] != '*' && oi + 1 < outsz) out[oi++] = l[i++];
  out[oi] = 0;
}

static void parseGpsLine(const char* l) {
  char f[16];
  if (strncmp(l, "$GPGGA", 6) == 0) {
    cntGGA++;
    getField(l, 6, f, sizeof(f)); lastFix      = f[0] ? atoi(f) : 0;
    getField(l, 7, f, sizeof(f)); lastSatsUsed = f[0] ? atoi(f) : 0;
    haveFix = (lastFix >= 1);
  } else if (strncmp(l, "$GPRMC", 6) == 0) {
    cntRMC++;
    getField(l, 1, f, sizeof(f)); strncpy(lastRmcTime, f, sizeof(lastRmcTime)-1);
    getField(l, 2, f, sizeof(f)); lastRmcStat = f[0] ? f[0] : '?';
  } else if (strncmp(l, "$GPGSA", 6) == 0) {
    getField(l, 2, f, sizeof(f)); lastGsaMode = f[0] ? atoi(f) : 0;
  } else if (strncmp(l, "$GPGSV", 6) == 0) {
    cntGSV++;
    getField(l, 3, f, sizeof(f)); lastSatsView = f[0] ? atoi(f) : 0;
  }
}

static void drainGps() {
  while (gpsSerial.available()) {
    int c = gpsSerial.read();
    if (c < 0) break;
    gpsBytes++;
    if (c == '\n' || c == '\r') {
      if (gpsLineLen > 0) {
        gpsLine[gpsLineLen] = 0;
        gpsLines++;
        parseGpsLine(gpsLine);
        // 라인별 raw 보고 싶으면 아래 주석 해제:
        // Serial.printf("[NMEA] %s\n", gpsLine);
        gpsLineLen = 0;
      }
    } else if (gpsLineLen < sizeof(gpsLine) - 1) {
      gpsLine[gpsLineLen++] = (char)c;
    } else {
      gpsLineLen = 0;
    }
  }
}

// ─── LTE (SIM7080G, UART1) ───────────────────────────────
HardwareSerial lte(1);
char     lteLine[200];
uint16_t lteLineLen = 0;
uint32_t lteBytes = 0;
uint32_t cntOK = 0, cntERROR = 0, cntATEcho = 0;
bool     haveAnyResp = false, haveRDY = false, haveCFUN = false, haveCPIN = false;

static void parseLteLine(const char* l) {
  haveAnyResp = true;
  if (strcmp(l, "OK") == 0)               cntOK++;
  else if (strstr(l, "ERROR"))            cntERROR++;
  else if (strncmp(l, "AT", 2) == 0)      cntATEcho++;
  else if (strcmp(l, "RDY") == 0)         haveRDY = true;
  else if (strncmp(l, "+CFUN:", 6) == 0)  haveCFUN = true;
  else if (strncmp(l, "+CPIN:", 6) == 0 && strstr(l, "READY")) haveCPIN = true;
}

static void drainLteSerial() {
  while (lte.available()) {
    int c = lte.read();
    if (c < 0) break;
    lteBytes++;
    if (c == '\n' || c == '\r') {
      if (lteLineLen > 0) {
        lteLine[lteLineLen] = 0;
        parseLteLine(lteLine);
        // 라인별 raw 보고 싶으면 아래 주석 해제:
        // Serial.printf("[LTE] %s\n", lteLine);
        lteLineLen = 0;
      }
    } else if (lteLineLen < sizeof(lteLine) - 1) {
      lteLine[lteLineLen++] = (char)c;
    } else {
      lteLineLen = 0;
    }
  }
}

static bool isLteAlreadyOn() {
  while (lte.available()) (void)lte.read();
  lte.print("AT\r\n");
  uint32_t t0 = millis();
  char buf[64]; size_t blen = 0;
  while (millis() - t0 < 1500) {
    while (lte.available()) {
      int c = lte.read();
      if (c < 0) break;
      if (blen < sizeof(buf) - 1) buf[blen++] = (char)c;
    }
    buf[blen] = 0;
    if (strstr(buf, "OK")) return true;
  }
  return false;
}

static void pulsePwrKey() {
  digitalWrite(PIN_PWRKEY, HIGH);
  delay(100);
  digitalWrite(PIN_PWRKEY, LOW);
  delay(1500);
  digitalWrite(PIN_PWRKEY, HIGH);
}

// SLEEP 종료 후 또는 첫 부팅에서 LTE 깨우기. PWR_EN 이 이미 LOW 인 상태에서 호출.
static void ltePowerOn(bool firstBoot) {
  pinMode(PIN_DTR, OUTPUT);     digitalWrite(PIN_DTR, LOW);
  pinMode(PIN_PWRKEY, OUTPUT);  digitalWrite(PIN_PWRKEY, HIGH);
  delay(200);

  if (firstBoot) {
    // UART 처음 begin (이미 begin 된 상태에서도 호환)
    lte.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);
  }

  if (isLteAlreadyOn()) {
    Serial.println(F("[LTE] 이미 켜져있음 (AT 응답 OK) — PWRKEY skip"));
    return;
  }

  Serial.println(F("[LTE] PWRKEY pulse"));
  pulsePwrKey();

  // 5s drain — 부팅 메시지 흡수
  uint32_t t0 = millis();
  while (millis() - t0 < 5000) {
    while (lte.available()) (void)lte.read();
    delay(5);
  }
  // 확인 AT
  while (lte.available()) (void)lte.read();
  lte.print("AT\r\n");
  delay(1500);
}

// ─── setup ───────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(5000);
  Serial.println();
  Serial.println(F("=== 03_5 combined living-check ==="));
  Serial.printf("LIS3DH I2C  SDA=GPIO%d  SCL=GPIO%d  INT=GPIO%d\n", PIN_SDA, PIN_SCL, PIN_INT);
  Serial.printf("PWR_EN=GPIO%d (LOW=ON, 공유)\n", PIN_PWR_EN);
  Serial.printf("GPS  UART0  RX=GPIO%d  TX=GPIO%d  baud=%lu\n", PIN_GPS_RX, PIN_GPS_TX, GPS_BAUD);
  Serial.printf("LTE  UART1  RX=GPIO%d  TX=GPIO%d  PWRKEY=GPIO%d  DTR=GPIO%d  baud=%lu\n",
                PIN_LTE_RX, PIN_LTE_TX, PIN_PWRKEY, PIN_DTR, LTE_BAUD);
  Serial.printf("BUZZER=GPIO%d (active)\n", PIN_BUZZER);
  Serial.printf("AWAKE 유지 시간: %lus  (마지막 모션 이후)\n", AWAKE_DURATION_MS / 1000UL);

  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  // ── I2C + LIS3DH ──
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  if (!detectLis()) {
    Serial.println(F("[LIS] FAIL — WHO_AM_I 0x33 응답기 없음. 진행은 하지만 모션 감지 불가."));
  } else {
    lisConfig();
    Serial.printf("[LIS] OK at 0x%02X  R1=0x%02X R3=0x%02X R4=0x%02X CFG=0x%02X THS=0x%02X DUR=0x%02X\n",
                  lisAddr,
                  lisRead(LIS_CTRL_REG1), lisRead(LIS_CTRL_REG3), lisRead(LIS_CTRL_REG4),
                  lisRead(LIS_INT1_CFG), lisRead(LIS_INT1_THS), lisRead(LIS_INT1_DUR));
  }

  pinMode(PIN_INT, INPUT_PULLDOWN);
  attachInterrupt(digitalPinToInterrupt(PIN_INT), onIntChange, CHANGE);

  // ── PWR_EN — AWAKE 시작 ──
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);
  pwrState        = PWR_AWAKE;
  awakeUntilMs    = millis() + AWAKE_DURATION_MS;
  awakeEnterCount = 1;
  Serial.printf("[PWR] 🚀 AWAKE 시작 (GPIO%d=LOW, %lus 유지)\n", PIN_PWR_EN, AWAKE_DURATION_MS / 1000UL);

  // ── GPS UART (즉시 시작) ──
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  Serial.println(F("[GPS] UART0 시작"));

  // ── LTE 시퀀스 (모듈 internal power 안정화 후) ──
  delay(500);
  ltePowerOn(/*firstBoot=*/true);

  // 부팅 완료 비프 (긴 한 번)
  Serial.println(F("[BUZ] 부팅 완료 — long beep"));
  beep(1, 400, 0);

  Serial.println();
}

// ─── loop ────────────────────────────────────────────────
void loop() {
  uint32_t now = millis();

  // (1) LIS3DH 폴링 (PWR_EN 무관 — I2C 는 항상 동작)
  float gx = 0, gy = 0, gz = 0, mag = 0;
  if (lisAddr) {
    lisReadAccel(&gx, &gy, &gz);
    uint8_t src = lisRead(LIS_INT1_SRC);
    if (src == 0xFF) {
      i2cBadStreak++;
      if (i2cBadStreak >= 20) {
        Wire.end(); delay(10); Wire.begin(PIN_SDA, PIN_SCL); Wire.setClock(400000);
        lisConfig(); i2cReinitCount++; i2cBadStreak = 0;
      }
    } else {
      i2cBadStreak = 0;
      if (src & 0x40) { hwMotionCount++; lastSrc = src; }
    }
    mag = sqrtf(gx*gx + gy*gy + gz*gz);
    if (fabsf(mag - 1.0f) > 0.20f && now - lastSwMotionMs > 400) {
      swMotionCount++;
      lastSwMotionMs = now;
    }
  }

  // (2) 모션 → PWR 상태 갱신
  if (hwMotionCount > lastSeenHwMotion) {
    lastSeenHwMotion = hwMotionCount;
    if (pwrState == PWR_SLEEP) {
      pwrState = PWR_AWAKE;
      digitalWrite(PIN_PWR_EN, LOW);
      awakeEnterCount++;
      Serial.printf("[PWR] 🚀 모션 감지 → AWAKE (GPIO%d=LOW). 모듈 재기동 중...\n", PIN_PWR_EN);
      beep(2, 100, 100);            // wake-up 이중 비프
      delay(1500);                  // 모듈 internal power 안정화
      while (gpsSerial.available()) (void)gpsSerial.read();
      ltePowerOn(/*firstBoot=*/false);
    } else {
      Serial.println(F("[PWR] 🔄 AWAKE 중 모션 — 180s 타이머 리셋"));
      beep(1, 50, 0);               // 짧은 단발 — 타이머 갱신만
    }
    awakeUntilMs = now + AWAKE_DURATION_MS;
  }

  // (3) AWAKE 타이머 만료 → SLEEP
  if (pwrState == PWR_AWAKE && (int32_t)(now - awakeUntilMs) >= 0) {
    pwrState = PWR_SLEEP;
    digitalWrite(PIN_PWR_EN, HIGH);
    sleepEnterCount++;
    Serial.printf("[PWR] 💤 %lus 무 모션 → SLEEP (GPIO%d=HIGH, 모듈 OFF). 모션 대기...\n",
                  AWAKE_DURATION_MS / 1000UL, PIN_PWR_EN);
    beep(1, 600, 0);                // 긴 단발 — sleep 신호
  }

  // (4) AWAKE 일 때만 GPS/LTE 폴링 + 5s 마다 AT
  if (pwrState == PWR_AWAKE) {
    drainGps();
    drainLteSerial();
    static uint32_t lastAT = 0;
    if (now - lastAT >= 5000) {
      lastAT = now;
      lte.print("AT\r\n");
    }
  }

  // (4b) 첫 LTE OK / 첫 GPS fix 마일스톤 비프
  if (!lteFirstOkBeeped && cntOK > 0) {
    lteFirstOkBeeped = true;
    Serial.println(F("[BUZ] 🎉 첫 LTE OK — triple beep"));
    beep(3, 80, 80);
  }
  if (!gpsFirstFixBeeped && haveFix) {
    gpsFirstFixBeeped = true;
    Serial.println(F("[BUZ] 🎉 첫 GPS fix — triple beep"));
    beep(3, 80, 80);
  }

  // (4c) 부저 상태머신 tick
  updateBuzzer();

  // (5) 1초 헬스라인
  static uint32_t lastLog = 0;
  if (now - lastLog >= 1000) {
    lastLog = now;
    int32_t remainSec = (pwrState == PWR_AWAKE && awakeUntilMs > now)
                          ? (int32_t)((awakeUntilMs - now) / 1000) : 0;

    // 통합 헬스 한 줄
    Serial.printf("[%lus] PWR=%-5s GPIO6=%c remain=%4ds | LIS:hw=%lu sw=%lu int=%c | "
                  "GPS:lines=%lu fix=%d sat=%d/v%d | LTE:bytes=%lu OK=%lu ERR=%lu | wake/sleep=%lu/%lu\n",
                  now / 1000UL,
                  pwrState == PWR_AWAKE ? "AWAKE" : "SLEEP",
                  pwrState == PWR_AWAKE ? 'L' : 'H',
                  (int)remainSec,
                  (unsigned long)hwMotionCount, (unsigned long)swMotionCount,
                  digitalRead(PIN_INT) ? 'H' : 'L',
                  (unsigned long)gpsLines, lastFix, lastSatsUsed, lastSatsView,
                  (unsigned long)lteBytes, (unsigned long)cntOK, (unsigned long)cntERROR,
                  (unsigned long)awakeEnterCount, (unsigned long)sleepEnterCount);

    // 한글 종합
    Serial.print(F("[종합] "));
    if (pwrState == PWR_SLEEP) {
      Serial.print(F("💤 SLEEP 중 (모듈 OFF, LIS 만 활성). 모션 발생 시 즉시 AWAKE"));
    } else {
      // LIS
      if (!lisAddr)                 Serial.print(F("⚠️  LIS 없음"));
      else                          Serial.print(F("✅ LIS"));
      Serial.print(F(" | "));
      // GPS
      if (gpsLines == 0)            Serial.print(F("❌ GPS 무응답"));
      else if (haveFix)             Serial.printf("✅ GPS %dD fix (위성 %d)", lastGsaMode, lastSatsUsed);
      else if (lastSatsView > 0)    Serial.printf("⏳ GPS 위성 %d (fix 부족)", lastSatsView);
      else                          Serial.print(F("⏳ GPS UART OK, 위성 0 (실내)"));
      Serial.print(F(" | "));
      // LTE
      if (cntOK > 0)                Serial.printf("✅ LTE (OK %lu회)", (unsigned long)cntOK);
      else if (cntATEcho > 0)       Serial.print(F("⏳ LTE echo (OK 대기)"));
      else if (haveAnyResp)         Serial.print(F("⏳ LTE 응답 일부 (OK 아직)"));
      else                          Serial.print(F("❌ LTE 무응답"));
    }
    Serial.println();
  }

  delay(50);
}
