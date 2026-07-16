#include "motion.h"
#include "config.h"
#include <Wire.h>

// =================================================================
// ⚠️ OPEN ITEM (2026-07-02) — 런타임 모션 카운터가 벤치 손흔들기를 거의 못 셈.
//   증상: 흔들어도 events_ 가 1~3 에서 멈춤. 엣지-ISR / IA-비트 폴링 둘 다 동일.
//   확인됨: LIS 는 살아있음(WHO=0x33, SRC 정상). 딥슬립 wake(운영 신뢰)는 INT1 핀을
//           하드웨어로 직접 쓰므로 이 카운터와 무관 → wake 는 정상.
//   미확정: 원인이 (a) THS(0x08=128mg)/DUR(0x06≈120ms 지속) 문턱이 손흔들기보다 높아서인지,
//           (b) HPF/latch 설정 문제인지. GPS drift 는 실내 노이즈라 이동 증거로 못 씀.
//   영향: 정지(quiet) 판정 → 자동 sleep 조기 트리거 위험. 단 GPS drift 교차검증이 완화.
//   TODO: OUT_X/Y/Z 원시 가속도 읽어 센서가 흔들림을 보는지 확정 후 THS/DUR 재튜닝.
//         (원본 13_4_aa 도 동일 구조라 같은 under-count 였을 것 — false-sleep 사고와 연관 가능)
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
  lisWrite(LIS_CTRL_REG2, 0xC1);   // HPF on INT1
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

// -----------------------------------------------------------------
void init() {
  pinMode(PIN_LIS_INT, INPUT_PULLUP);   // active-low LIS — idle HIGH. deep-sleep wake 는 Block 8 에서 핀으로 설정.
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
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
      Serial.printf("[LIS] I2C wedge — reinit #%lu\n", (unsigned long)(reinits_ + 1));
      Wire.end(); delay(10);
      Wire.begin(PIN_SDA, PIN_SCL);
      Wire.setClock(400000);
      ok_ = lisInit();
      reinits_++;
      badStreak_ = 0;
      if (!ok_) Serial.println(F("[LIS] reinit FAIL — wake source lost"));
      else      Serial.println(F("[LIS] reinit OK"));
    }
    return;
  }
  badStreak_ = 0;

  if (src & LIS_INT1_SRC_IA) {
    // 모션 감지됨. 디바운스(EDGE_FILTER)로 카운트 rate 제한.
    if (lastCountMs_ == 0 || now - lastCountMs_ >= LIS_EDGE_FILTER_MS) {
      lastCountMs_ = now;
      events_++;
      lastMs_ = now;
    } else {
      lastMs_ = now;   // 카운트는 안 해도 freshness 는 갱신
    }
  }
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
