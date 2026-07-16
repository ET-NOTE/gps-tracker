#include "motion.h"
#include "config.h"
#include <Wire.h>
#include <math.h>

// =================================================================
// ✅ RESOLVED (2026-07-03) — 만성 모션 카운터 under-count 근본원인 규명+수정.
//   [진짜 원인] CTRL_REG2=0xC1 (HPF **HPM=11 autoreset**) 가 인터럽트 데이터 경로 전체를
//     freeze 시킴 — INT1_SRC(src=0x15 고정)·OUT 레지스터·INT1 핀 전부 갱신 정지. 흔들어도
//     high-event(XH/YH/ZH) 안 뜨고 IA=0, pin=1 유지 → events_ 0~3 에서 굶음.
//     (원본 13_4_aa 도 동일 config → 같은 under-count. false-sleep 사고의 근본원인.)
//   [수정] CTRL_REG2 = 0x01 (HPF **HPM=00 normal**, reference 로 중력 제거, autoreset 제거).
//     + THS 0x08→0x04(64mg), DUR 0x06→0x02(40ms), 카운트/freshness 를 IA 뿐 아니라
//       순간 high-event(0x2A) 로도 갱신(LIS_HI_EVT_MASK).
//   [검증 2026-07-03 벤치] 정지 MOT=0(오검출 0, src=0x15 高비트 없음) / 살짝 흔들기 16s → MOT +65
//     (기존 수 분간 0~3). IA=1·pin=0 어서트 확인. deep-sleep wake 는 INT1 핀 직결이라 무영향(오히려 개선).
//   [진단 도구] MOTION_RAW_DEBUG=1: HPF off 로 OUT_X/Y/Z 원시 mg / 또는 INT1_SRC·핀 로깅. 운영 0.
//   [특성화] 정지 노이즈~35mg / 살짝~50-114mg / 중간~346 / 세게~411 (HPF off 실측).
// =================================================================

namespace motion {

// ── LIS3DH 레지스터 (구현 상세) ──
#define LIS_WHO_AM_I    0x0F
#define LIS_CTRL_REG1   0x20
#define LIS_CTRL_REG2   0x21
#define LIS_CTRL_REG3   0x22
#define LIS_CTRL_REG4   0x23
#define LIS_CTRL_REG5   0x24
#define LIS_CTRL_REG6   0x25
#define LIS_REFERENCE   0x26
#define LIS_INT1_CFG    0x30
#define LIS_INT1_SRC    0x31
#define LIS_INT1_THS    0x32
#define LIS_INT1_DUR    0x33
#define LIS_INT1_SRC_IA 0x40   // INT1_SRC bit6 = interrupt active (motion since last read)
#define LIS_HI_EVT_MASK 0x2A   // XH|YH|ZH (bit1/3/5) = 순간 고이벤트 (DUR 미충족이라도 모션 신호로 사용)
#define LIS_OUT_X_L     0x28   // OUT_X_L … OUT_Z_H(0x2D) 연속. bit7=1 → auto-increment burst.

static uint8_t  lisAddr = 0x19;   // 0x19(SDO=VCC) → 0x18(SDO=GND) auto-probe
static bool     ok_     = false;

static uint32_t events_ = 0;
static uint32_t lastMs_ = 0;

static uint32_t badStreak_  = 0;
static uint32_t lastPollMs_ = 0;
static uint32_t lastCountMs_ = 0;
RTC_DATA_ATTR static uint32_t reinits_ = 0;   // I2C wedge reinit 누적 (sleep 보존)

// -----------------------------------------------------------------
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

static bool lisInit() {
  const uint8_t cand[] = { 0x19, 0x18 };
  bool found = false;
  for (uint8_t a : cand) {
    lisAddr = a;
    uint8_t who = lisRead(LIS_WHO_AM_I);
    Serial.printf("[LIS] probe 0x%02X WHO=0x%02X%s\n", a, who, who == 0x33 ? " <-- LIS3DH!" : "");
    if (who == 0x33) { found = true; break; }
  }
  if (!found) {
    DBGLN(F("[LIS] not found @0x19/0x18 — check SDA=8 SCL=9 + SDO"));
    return false;
  }
  lisWrite(LIS_CTRL_REG1, 0x47);   // 50Hz, XYZ enable
  lisWrite(LIS_CTRL_REG2, 0x01);   // (2026-07-03 FIX) HPF normal 모드(HPM=00)+INT1 적용. was 0xC1(HPM=11 autoreset)=데이터경로 freeze 원인(src/OUT/pin 전부 고정→ 만성 under-count). 중력은 REFERENCE 로 제거.
  lisWrite(LIS_CTRL_REG3, 0x40);   // IA1 → INT1 pin (deep-sleep wake 용)
  lisWrite(LIS_CTRL_REG4, 0x88);
  lisWrite(LIS_CTRL_REG5, 0x08);   // LIR_INT1 latch
  lisWrite(LIS_CTRL_REG6, 0x02);   // INT active-low
  (void)lisRead(LIS_REFERENCE);
  lisWrite(LIS_INT1_THS, LIS_MOT_THS);
  lisWrite(LIS_INT1_DUR, LIS_MOT_DUR);
  lisWrite(LIS_INT1_CFG, 0x2A);    // X/Y/Z high event (OR)
  (void)lisRead(LIS_INT1_SRC);     // 초기 latch clear
  return true;
}

// ── I2C(Wire) 견고화 헬퍼 (P6-I2C 2026-07-06) ───────────────────
static void wireBegin() {
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(LIS_I2C_HZ);
  Wire.setTimeOut(LIS_I2C_TIMEOUT_MS);   // 버스 hang 시 드라이버 무한대기 방지
}
// 버스가 slave 에 의해 SDA LOW 로 잡혀있으면(중단된 read 등) SCL 9펄스로 마저 clock-out 시켜
//   slave 가 SDA 를 릴리즈하게 한 뒤 STOP 발생. reinit 전에 호출해 Wire.begin 이 살아있는 버스에서 시작하게.
static void busRecover() {
  Wire.end();
  pinMode(PIN_SCL, OUTPUT_OPEN_DRAIN);
  pinMode(PIN_SDA, INPUT_PULLUP);        // SDA 릴리즈 + 상태 읽기
  digitalWrite(PIN_SCL, HIGH);
  for (int i = 0; i < 9 && digitalRead(PIN_SDA) == LOW; i++) {
    digitalWrite(PIN_SCL, LOW);  delayMicroseconds(5);
    digitalWrite(PIN_SCL, HIGH); delayMicroseconds(5);
  }
  pinMode(PIN_SDA, OUTPUT_OPEN_DRAIN);   // STOP: SCL HIGH 에서 SDA LOW→HIGH
  digitalWrite(PIN_SDA, LOW);  delayMicroseconds(5);
  digitalWrite(PIN_SCL, HIGH); delayMicroseconds(5);
  digitalWrite(PIN_SDA, HIGH); delayMicroseconds(5);
}

// -----------------------------------------------------------------
void init() {
  pinMode(PIN_LIS_INT, INPUT_PULLUP);   // active-low LIS — idle HIGH. deep-sleep wake 는 Block 8 에서 핀으로 설정.
  wireBegin();
  ok_ = lisInit();
  if (ok_) DBGLN(F("[LIS] OK (active-low, polling INT1_SRC IA)"));
  else     DBGLN(F("[LIS] init failed — proceeding without motion"));
}

// 폴링 기반 카운트 — tick() 이 50ms 마다 INT1_SRC 를 읽어 IA 비트로 모션 판정.
// ⚠️ 엣지 인터럽트 방식(원본) 폐기 이유: LIR latch + tick 의 SRC-read 가 INT 핀 엣지를
//    교란해 런타임 카운트가 몇 건 뒤 굶음 (2026-07-02 벤치 실측: GPS 는 이동 감지하는데
//    MOT 카운트 정지). IA 비트 폴링은 latch/엣지 타이밍에 면역.
void tick() {
  if (!ok_) return;
  uint32_t now = millis();
  if (now - lastPollMs_ <= LIS_HEALTH_POLL_MS) return;
  lastPollMs_ = now;

  uint8_t src = lisRead(LIS_INT1_SRC);   // 읽는 즉시 latch clear
  if (src == 0xFF) {
    badStreak_++;
    if (badStreak_ >= LIS_BAD_STREAK_REINIT) {
      Serial.printf("[LIS] I2C wedge — bus-recover + reinit #%lu\n", (unsigned long)(reinits_ + 1));
      busRecover(); delay(10);
      wireBegin();
      ok_ = lisInit();
      reinits_++;
      badStreak_ = 0;
      if (!ok_) Serial.println(F("[LIS] reinit FAIL — wake source lost"));
      else      Serial.println(F("[LIS] reinit OK"));
    }
    return;
  }
  badStreak_ = 0;

#if MOTION_RAW_DEBUG
  // (P2 진단 2026-07-03) 인터럽트 경로 확인 — INT1_SRC 원값 + INT1 핀레벨 + 이 250ms 창의
  //   src OR 누적(어떤 축이라도 이벤트 떴는지). 흔들기 시 이 값들이 반응하는지 봄.
  {
    static uint32_t lastDbgMs = 0;
    static uint8_t  srcAcc    = 0;
    srcAcc |= src;
    if (now - lastDbgMs >= 250) {
      lastDbgMs = now;
      uint8_t cfg = lisRead(LIS_INT1_CFG);   // 0x30 재확인
      Serial.printf("[MOT int] src=0x%02X acc=0x%02X IA=%d pin=%d CFG=0x%02X THS=0x%02X DUR=0x%02X\n",
        src, srcAcc, (src & LIS_INT1_SRC_IA) ? 1 : 0, digitalRead(PIN_LIS_INT),
        cfg, LIS_MOT_THS, LIS_MOT_DUR);
      srcAcc = 0;
    }
  }
#endif

  // (2026-07-03 P2) 모션 신호 = IA(지속≥DUR) OR 순간 高이벤트(XH/YH/ZH=0x2A).
  //   IA 만 보면 DUR 게이트로 짧은 주행 범프를 놓쳐 under-count → 高이벤트 비트도 freshness 로 반영.
  //   정지 baseline src=0x15(高비트 0)라 오검출 안전(HPM=00 fix 이후).
  if (src & (LIS_INT1_SRC_IA | LIS_HI_EVT_MASK)) {
    lastMs_ = now;   // freshness: 어떤 모션이든 즉시 갱신 (quiet 판정 입력)
    if (lastCountMs_ == 0 || now - lastCountMs_ >= LIS_EDGE_FILTER_MS) {
      lastCountMs_ = now;
      events_++;
    }
  }
}

// (P2 진단 2026-07-03) OUT_X/Y/Z 원시 가속도 (±2g HR, mg). FDS=0 라 OUT 은 HPF 미적용(중력 포함).
//   ※ 버스트(auto-inc) 읽기가 얼어붙는 현상 관측 → 축별 개별 read (single-byte 는 검증됨).
bool readRaw(int16_t &xMg, int16_t &yMg, int16_t &zMg) {
  if (!ok_) return false;
  uint8_t xl = lisRead(0x28), xh = lisRead(0x29);
  uint8_t yl = lisRead(0x2A), yh = lisRead(0x2B);
  uint8_t zl = lisRead(0x2C), zh = lisRead(0x2D);
  int16_t rx = (int16_t)(xl | (xh << 8));
  int16_t ry = (int16_t)(yl | (yh << 8));
  int16_t rz = (int16_t)(zl | (zh << 8));
  xMg = rx >> 4;   yMg = ry >> 4;   zMg = rz >> 4;   // 12-bit HR, ±2g → 1mg/digit
  return true;
}

int rawMagMg() {
  int16_t x, y, z;
  if (!readRaw(x, y, z)) return -1;
  return (int)sqrtf((float)x * x + (float)y * y + (float)z * z);
}

// -----------------------------------------------------------------
bool     ok()        { return ok_; }
uint32_t events()    { return events_; }
uint32_t lastMs()    { return lastMs_; }
uint32_t reinits()   { return reinits_; }
uint32_t badStreak() { return badStreak_; }

bool quiet(uint32_t quietMs) {
  return (lastMs_ == 0) || (millis() - lastMs_ >= quietMs);
}

void clearLatch() {
  if (ok_) (void)lisRead(LIS_INT1_SRC);
}

} // namespace motion
