// ESP32-C3 mini + LIS3DH (3축 가속도 ±2/4/8/16g) + OLED
//   ※ 모듈 표면에 LIS3DSH 라고 적혀있어도 실제 칩이 LIS3DH인 경우 (WHO_AM_I=0x33).
//      0x1E/0x1D 대신 0x18/0x19 주소 사용. (이 보드: 0x19, SDO=1)
//
// I2C : SDA=GPIO8, SCL=GPIO9 (OLED 공유)
// INT : GPIO5 ← LIS3DH INT1
//
// 이 단계에서 검증할 것:
//   1) I2C 통신 (WHO_AM_I = 0x33) — 모듈/배선/주소 확인
//   2) X/Y/Z 가속도 연속 읽기 + 피크 트래킹
//   3) HW INT 검증 — INT1_CFG/THS/DURATION으로 motion-detect 인터럽트.
//      HPF로 중력 DC 제거 → 흔들었을 때만 INT1이 H로 latch.
//      소프트웨어가 INT1_SRC 읽으면 자동 클리어 → INT1 핀 H→L.
//
// 참고: LIS3DH I2C 멀티바이트 읽기는 sub-address MSB 1로 (auto-increment).
//       즉 OUT_X_L(0x28) 6바이트 읽으려면 0xA8 보냄.

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// --- pins ---
#define PIN_SDA       8
#define PIN_SCL       9
#define PIN_INT       5

#define OLED_ADDR     0x3C

// --- LIS3DH 레지스터 ---
#define REG_WHO_AM_I    0x0F   // expect 0x33
#define REG_CTRL_REG1   0x20   // ODR + axis enable + LPen
#define REG_CTRL_REG2   0x21   // HPF
#define REG_CTRL_REG3   0x22   // INT1 source routing
#define REG_CTRL_REG4   0x23   // BDU + FS + HR
#define REG_CTRL_REG5   0x24   // FIFO + LIR_INT1 (latch)
#define REG_REFERENCE   0x26
#define REG_OUT_X_L     0x28
#define REG_INT1_CFG    0x30
#define REG_INT1_SRC    0x31   // 읽으면 latched INT 클리어
#define REG_INT1_THS    0x32
#define REG_INT1_DUR    0x33

// ─── 모션 인터럽트 민감도 (둘 다 키우면 둔해짐) ─────────────────────
//
// MOT_THRESHOLD: 임계 가속도 — ±2g HR mode 1 LSB = 16 mg
//   0x04 = 64mg   매우 민감 (정전기/진동 노이즈에도 반응)
//   0x08 = 128mg  민감 (가벼운 탭에 반응) ← 너무 잘 잡힘
//   0x10 = 256mg  보통 (의도적 흔들기)
//   0x18 = 384mg  ↑ 현재 기본값 (책상 위 가벼운 진동 무시)
//   0x20 = 512mg  둔감 (꽤 흔들어야 함, 차량 진동급)
//   0x40 = 1024mg ≈ 1g (충격급, 떨어뜨림 감지)
//
// MOT_DURATION: 임계 초과가 얼마나 지속돼야 트리거 — ODR=50Hz 1 LSB = 20 ms
//   0x00 = 즉시   (탭 임펄스 잡기)
//   0x02 = 40ms   ← 현재 기본값 (브리프 글리치 무시)
//   0x05 = 100ms  (의도적 움직임만)
//   0x0A = 200ms  (걷기/이동 같은 지속적 움직임)
//
// 더 둔하게: THS↑   더 안정적으로(글리치 제거): DUR↑
#define MOT_THRESHOLD   0x18
#define MOT_DURATION    0x02

// 소프트 임계치 (피크 magnitude — 인터럽트와 별개로 보조 검증)
#define SW_MOTION_THRESH_G    0.20f
#define SW_MOTION_DEBOUNCE_MS 400

// --- module state ---
Adafruit_SSD1306 display(128, 64, &Wire, -1);
uint8_t lisAddr = 0;       // 0x18 or 0x19
uint32_t swMotionCount = 0;
uint32_t lastSwMotionMs = 0;
uint32_t hwMotionCount = 0;       // INT1_SRC IA(bit6) 카운트
uint8_t  lastSrc = 0;
uint32_t loopCount = 0;
float maxAbsX = 0, maxAbsY = 0, maxAbsZ = 0;
float maxMag  = 0;

// HW interrupt edge counters (양쪽 엣지)
volatile uint32_t intRiseCount = 0;
volatile uint32_t intFallCount = 0;
volatile uint32_t lastRiseMs = 0;
volatile uint32_t lastFallMs = 0;

// I2C wedge 복구: 연속 N번 0xFF 읽히면 reinit
uint32_t i2cBadStreak = 0;
uint32_t i2cReinitCount = 0;

// loop의 edge-trigger 디버그용 (마지막으로 시리얼에 찍은 카운트)
uint32_t lastRiseLogged = 0;
uint32_t lastFallLogged = 0;

static void IRAM_ATTR onIntChange() {
  uint32_t now = millis();
  if (digitalRead(PIN_INT)) {
    intRiseCount++;
    lastRiseMs = now;
  } else {
    intFallCount++;
    lastFallMs = now;
  }
}

// --- I2C helpers ---
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
// LIS3DH 멀티바이트 읽기: sub-address MSB 1 (auto-increment 활성)
static void lisReadN(uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(lisAddr);
  Wire.write(reg | 0x80);
  Wire.endTransmission(false);
  Wire.requestFrom((int)lisAddr, (int)n);
  for (uint8_t i = 0; i < n && Wire.available(); i++) buf[i] = Wire.read();
}

static void i2cScan() {
  Serial.println(F("[I2C] scanning bus..."));
  uint8_t found = 0;
  for (uint8_t a = 0x08; a < 0x78; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf("[I2C]   responder at 0x%02X\n", a);
      found++;
    }
  }
  Serial.printf("[I2C] %u device(s) found\n", found);
}

struct AddrTry { uint8_t addr; const char *note; };
static const AddrTry kAddrs[] = {
  { 0x18, "LIS3DH SDO=0" },
  { 0x19, "LIS3DH SDO=1" },
  { 0x1E, "LIS3DSH SDO=1" },
  { 0x1D, "LIS3DSH SDO=0" },
};

// 각 주소 WHO_AM_I 점검. 0x33 (LIS3DH) 발견 시 lisAddr 세팅.
static bool detectLis() {
  Serial.println(F("[LIS] probing WHO_AM_I @ candidate addresses..."));
  bool ok = false;
  for (const auto &t : kAddrs) {
    Wire.beginTransmission(t.addr);
    Wire.write(REG_WHO_AM_I);
    uint8_t err = Wire.endTransmission(false);
    if (err != 0) {
      Serial.printf("[LIS]   0x%02X (%s): NACK on reg write (err=%u)\n", t.addr, t.note, err);
      continue;
    }
    uint8_t got = Wire.requestFrom((int)t.addr, 1);
    if (got != 1 || !Wire.available()) {
      Serial.printf("[LIS]   0x%02X (%s): no data after reg write\n", t.addr, t.note);
      continue;
    }
    uint8_t who = Wire.read();
    Serial.printf("[LIS]   0x%02X (%s): WHO=0x%02X %s\n",
                  t.addr, t.note, who,
                  who == 0x33 ? "<-- LIS3DH!" :
                  who == 0x3F ? "<-- LIS3DSH (다른 칩)" :
                  who == 0x32 ? "<-- LIS331DLH (다른 칩)" : "");
    if (who == 0x33 && !ok) {
      lisAddr = t.addr;
      ok = true;
    }
  }
  return ok;
}

// LIS3DH motion-detect 설정 (MMA8452 FF_MT_CFG와 동등한 흐름)
static void lisConfig() {
  // CTRL_REG1: ODR=0100 (50Hz), LPen=0 (HR/normal), Z/Y/X EN=111  → 0x47
  lisWrite(REG_CTRL_REG1, 0x47);

  // CTRL_REG2:
  //   HPM[1:0] = 11  → autoreset on interrupt (HPF가 INT 발생 시 자동 리셋)
  //   HPCF[1:0]= 00  → 가장 높은 cutoff (~ODR/50, 사용자 손동작 통과)
  //   FDS      = 0   → 출력 데이터는 raw (중력 그대로 보임)  ← 자세 변화 보이게
  //   HPCLICK  = 0
  //   HPIS2    = 0
  //   HPIS1    = 1   → HPF 신호를 AOI1에 적용 (AOI1만 motion-only)
  //   = 0b1100_0001 = 0xC1
  lisWrite(REG_CTRL_REG2, 0xC1);

  // CTRL_REG3: I1_AOI1 (bit 6) → AOI1 motion 인터럽트를 INT1으로
  lisWrite(REG_CTRL_REG3, 0x40);

  // CTRL_REG4: BDU=1, FS=00 (±2g), HR=1 (high res 12-bit) → 0x88
  lisWrite(REG_CTRL_REG4, 0x88);

  // CTRL_REG5: LIR_INT1=1 (bit3) — INT1 latch, INT1_SRC 읽기로 클리어
  lisWrite(REG_CTRL_REG5, 0x08);

  // HPF reference 초기화
  (void)lisRead(REG_REFERENCE);

  // 임계치 / 디바운스
  lisWrite(REG_INT1_THS, MOT_THRESHOLD);
  lisWrite(REG_INT1_DUR, MOT_DURATION);

  // INT1_CFG: bit5 ZHIE | bit3 YHIE | bit1 XHIE = 0b00101010 = 0x2A
  //           AOI=0 (OR mode) — 한 축이라도 임계치 초과면 트리거
  lisWrite(REG_INT1_CFG, 0x2A);

  // 부팅 직후 latch된 인터럽트 클리어
  (void)lisRead(REG_INT1_SRC);
}

// HR(12-bit) ±2g → 1 LSB = 1 mg → 1g = 1000 LSB
// OUT_x_H/L 16비트 좌측정렬, >>4 후 1g=1000.
static void lisReadAccel(float *gx, float *gy, float *gz) {
  uint8_t raw[6];
  lisReadN(REG_OUT_X_L, raw, 6);
  int16_t x = (int16_t)((raw[1] << 8) | raw[0]) >> 4;
  int16_t y = (int16_t)((raw[3] << 8) | raw[2]) >> 4;
  int16_t z = (int16_t)((raw[5] << 8) | raw[4]) >> 4;
  const float scale = 1.0f / 1000.0f;
  *gx = x * scale;
  *gy = y * scale;
  *gz = z * scale;
}

void setup() {
  Serial.begin(115200);
  delay(5000);
  Serial.println();
  Serial.println(F("=== 03_1 LIS3DH motion test ==="));
  Serial.printf("SDA=GPIO%d  SCL=GPIO%d  INT=GPIO%d\n", PIN_SDA, PIN_SCL, PIN_INT);

  pinMode(PIN_INT, INPUT_PULLDOWN);
  attachInterrupt(digitalPinToInterrupt(PIN_INT), onIntChange, CHANGE);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);

  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  i2cScan();

  if (!detectLis()) {
    Serial.println(F("[LIS] FAIL — no chip responded with 0x33 (LIS3DH)"));
    display.setCursor(0, 0);
    display.println(F("LIS3DH NOT FOUND"));
    display.println(F("see Serial @115200"));
    display.print(F("SDA=GPIO")); display.println(PIN_SDA);
    display.print(F("SCL=GPIO")); display.println(PIN_SCL);
    display.display();
    while (true) delay(1000);
  }

  lisConfig();

  Serial.printf("[LIS] OK at 0x%02X (LIS3DH)\n", lisAddr);
  Serial.printf("[LIS]   R1=0x%02X R2=0x%02X R3=0x%02X R4=0x%02X R5=0x%02X\n",
                lisRead(REG_CTRL_REG1), lisRead(REG_CTRL_REG2),
                lisRead(REG_CTRL_REG3), lisRead(REG_CTRL_REG4),
                lisRead(REG_CTRL_REG5));
  Serial.printf("[LIS]   INT1_CFG=0x%02X THS=0x%02X DUR=0x%02X\n",
                lisRead(REG_INT1_CFG), lisRead(REG_INT1_THS), lisRead(REG_INT1_DUR));

  display.setCursor(0, 0);
  display.println(F("LIS3DH ready"));
  display.print(F("addr=0x")); display.println(lisAddr, HEX);
  display.print(F("R1=")); display.print(lisRead(REG_CTRL_REG1), HEX);
  display.print(F(" R3=")); display.print(lisRead(REG_CTRL_REG3), HEX);
  display.print(F(" R4=")); display.println(lisRead(REG_CTRL_REG4), HEX);
  display.print(F("CFG=")); display.print(lisRead(REG_INT1_CFG), HEX);
  display.print(F(" THS=")); display.print(lisRead(REG_INT1_THS), HEX);
  display.print(F(" D=")); display.println(lisRead(REG_INT1_DUR), HEX);
  display.print(F("FS=+/-2g ODR=50Hz"));
  display.display();
  delay(2000);
}

void loop() {
  uint32_t now = millis();

  // ── ISR-detected edge 즉시 디버그 트리거 (lisRead보다 먼저!)
  // ISR이 잡은 카운트가 우리가 마지막에 찍은 값보다 늘었으면 그 사이에 엣지 발생.
  // 이 시점엔 INT 핀이 아직 H일 가능성이 큼 → 직접 read로 확인 가능.
  uint32_t r0 = intRiseCount, f0 = intFallCount;
  uint32_t newR = r0 - lastRiseLogged;
  uint32_t newF = f0 - lastFallLogged;
  if (newR || newF) {
    bool pinNow = digitalRead(PIN_INT);
    Serial.printf("[%lums] *EDGE*  +R%lu(@%lums,Δ%lums)  +F%lu(@%lums,Δ%lums)  pinNow=%c\n",
                  now,
                  (unsigned long)newR, (unsigned long)lastRiseMs, (unsigned long)(now - lastRiseMs),
                  (unsigned long)newF, (unsigned long)lastFallMs, (unsigned long)(now - lastFallMs),
                  pinNow ? 'H' : 'L');
    lastRiseLogged = r0;
    lastFallLogged = f0;
  }

  float gx, gy, gz;
  lisReadAccel(&gx, &gy, &gz);
  loopCount++;

  // INT1_SRC 폴링 — IA(bit6) = active interrupt
  // (LIR_INT1=1 이라 latch 상태. 읽기로 클리어 → INT1 핀 H→L)
  uint8_t src = lisRead(REG_INT1_SRC);
  if (src == 0xFF) {
    // 0xFF는 I2C 응답 없음의 기본값. 일시적 글리치는 흔하니 카운트만, 임계치 넘으면 reinit.
    i2cBadStreak++;
    if (i2cBadStreak >= 20) {  // 50ms × 20 = 1s 동안 응답 없음 → 와지로 간주
      Serial.println(F("[LIS] I2C wedge detected — reinit"));
      Wire.end();
      delay(10);
      Wire.begin(PIN_SDA, PIN_SCL);
      Wire.setClock(400000);
      lisConfig();
      i2cReinitCount++;
      i2cBadStreak = 0;
    }
  } else {
    i2cBadStreak = 0;
    if (src & 0x40) {
      hwMotionCount++;
      lastSrc = src;
    }
  }

  if (fabs(gx) > maxAbsX) maxAbsX = fabs(gx);
  if (fabs(gy) > maxAbsY) maxAbsY = fabs(gy);
  if (fabs(gz) > maxAbsZ) maxAbsZ = fabs(gz);
  float mag = sqrtf(gx*gx + gy*gy + gz*gz);
  if (mag > maxMag) maxMag = mag;

  // 소프트 임계치 모션 (인터럽트와 별개로 1g 기준 magnitude 편차)
  if (fabs(mag - 1.0f) > SW_MOTION_THRESH_G) {
    if (now - lastSwMotionMs > SW_MOTION_DEBOUNCE_MS) {
      swMotionCount++;
      lastSwMotionMs = now;
    }
  }

  display.clearDisplay();
  display.setCursor(0, 0);
  display.print(F("X")); display.print(gx, 2);
  display.print(F(" p")); display.println(maxAbsX, 2);
  display.print(F("Y")); display.print(gy, 2);
  display.print(F(" p")); display.println(maxAbsY, 2);
  display.print(F("Z")); display.print(gz, 2);
  display.print(F(" p")); display.println(maxAbsZ, 2);
  display.print(F("|v|")); display.print(mag, 2);
  display.print(F(" max")); display.println(maxMag, 2);
  display.print(F("HW:")); display.print(hwMotionCount);
  display.print(F(" SW:")); display.print(swMotionCount);
  display.print(F(" SRC:")); display.println(lastSrc, HEX);
  uint32_t r = intRiseCount, f = intFallCount;
  display.print(F("R")); display.print(r);
  display.print(F(" F")); display.print(f);
  display.print(F(" int=")); display.println(digitalRead(PIN_INT) ? F("H") : F("L"));
  display.print(F("up:")); display.print(now / 1000); display.print('s');
  display.print(F(" lp:")); display.print(loopCount);
  display.display();

  // 시리얼: 1초마다 한 줄
  static uint32_t lastLog = 0;
  if (now - lastLog >= 1000) {
    lastLog = now;
    Serial.printf("[%lus] x=%+.2f y=%+.2f z=%+.2f |v|=%.2f maxMag=%.2f hw=%lu sw=%lu src=0x%02X int=%c R=%lu F=%lu badI2C=%lu reinit=%lu\n",
                  now / 1000UL, gx, gy, gz, mag, maxMag,
                  (unsigned long)hwMotionCount, (unsigned long)swMotionCount,
                  lastSrc, digitalRead(PIN_INT) ? 'H' : 'L',
                  (unsigned long)r, (unsigned long)f,
                  (unsigned long)i2cBadStreak, (unsigned long)i2cReinitCount);
  }

  delay(50);
}
