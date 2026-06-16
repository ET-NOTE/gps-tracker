// ESP32-C3 mini + MMA8452Q (GY-45) 가속도센서 + OLED
// I2C : SDA=GPIO8, SCL=GPIO9 (OLED 공유)
// INT : GPIO1 <- MMA8452 INT1
//
// 운영 모드: HPF ON → DC 중력 제거, AC(움직임) 성분만 motion 블록과 OUT 레지스터에 반영
// 모션 이벤트 두 경로로 관찰:
//   poll : FF_MT_SRC의 EA 비트를 I2C로 폴링
//   isr  : INT 핀 RISING 하드웨어 인터럽트 (Deep Sleep wake 소스로도 쓸 예정)

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// --- pins ---
#define PIN_SDA        8
#define PIN_SCL        9
#define PIN_INT        1

#define OLED_ADDR      0x3C
#define MMA_ADDR       0x1D

// 모션 라우팅: 1 = INT1, 0 = INT2. (현재 배선: MMA INT1 -> ESP GPIO1)
#define ROUTE_TO_INT1  1

// 0.063g/LSB. 0x02 ≈ 0.13g (감도 양호), 0x04 ≈ 0.25g (약간 둔함)
#define MOT_THRESHOLD  0x02
// ODR 50Hz 기준 1카운트 = 20ms 디바운스. 0x02 = 40ms.
#define MOT_DEBOUNCE   0x02

// 소프트웨어 디바운스: 한 제스처의 울림(50Hz로 수십개 이벤트)을 1로 합침
#define ISR_DEBOUNCE_MS  500

// --- MMA8452Q 레지스터 ---
#define REG_OUT_X_MSB      0x01
#define REG_WHO_AM_I       0x0D
#define REG_XYZ_CFG        0x0E
#define REG_HP_FILTER_CUT  0x0F
#define REG_FF_MT_CFG      0x15
#define REG_FF_MT_SRC      0x16
#define REG_FF_MT_THS      0x17
#define REG_FF_MT_CNT      0x18
#define REG_CTRL_REG1      0x2A
#define REG_CTRL_REG3      0x2C
#define REG_CTRL_REG4      0x2D
#define REG_CTRL_REG5      0x2E

Adafruit_SSD1306 display(128, 64, &Wire, -1);

volatile uint32_t isrCount = 0;
volatile uint32_t isrRawCount = 0;      // 디바운스 없는 원시 ISR 발화 수 (참고용)
volatile uint32_t lastIsrMs = 0;
uint32_t pollCount = 0;
float maxAbsX = 0, maxAbsY = 0, maxAbsZ = 0;
float maxMag  = 0;
uint8_t lastSrc = 0;

static void IRAM_ATTR onMotion() {
  isrRawCount++;
  uint32_t now = millis();
  if (now - lastIsrMs > ISR_DEBOUNCE_MS) {
    isrCount++;
    lastIsrMs = now;
  }
}

// --- I2C helpers ---
static void mmaWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MMA_ADDR);
  Wire.write(reg); Wire.write(val);
  Wire.endTransmission();
}
static uint8_t mmaRead(uint8_t reg) {
  Wire.beginTransmission(MMA_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((int)MMA_ADDR, 1);
  return Wire.available() ? Wire.read() : 0xFF;
}
static void mmaReadN(uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(MMA_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((int)MMA_ADDR, (int)n);
  for (uint8_t i = 0; i < n && Wire.available(); i++) buf[i] = Wire.read();
}

// --- sensor config ---
static void mmaConfigMotion() {
  mmaWrite(REG_CTRL_REG1, 0x00);             // STANDBY (config 변경은 STANDBY에서만)
  mmaWrite(REG_XYZ_CFG, 0x10);               // ±2g + HPF_OUT=1 (AC only)
  mmaWrite(REG_HP_FILTER_CUT, 0x03);         // HPF SEL=11 → ~2Hz cutoff (사람 움직임 통과)
  mmaWrite(REG_FF_MT_CFG, 0xD8);             // ELE=1(latch), OAE=1(motion), Z/Y/X EFE=1
  mmaWrite(REG_FF_MT_THS, MOT_THRESHOLD);
  mmaWrite(REG_FF_MT_CNT, MOT_DEBOUNCE);
  mmaWrite(REG_CTRL_REG3, 0x02);             // IPOL=1(active high), PP_OD=0(push-pull)
  mmaWrite(REG_CTRL_REG4, 0x04);             // INT_EN_FF_MT
  mmaWrite(REG_CTRL_REG5, ROUTE_TO_INT1 ? 0x04 : 0x00);  // INT1 or INT2 라우팅
  mmaWrite(REG_CTRL_REG1, (0b100 << 3) | 0x01); // ACTIVE + ODR 50Hz
  mmaRead(REG_FF_MT_SRC);                    // 부팅 시 latch된 것 클리어
}

static void readAccel(float *gx, float *gy, float *gz) {
  uint8_t raw[6];
  mmaReadN(REG_OUT_X_MSB, raw, 6);
  int16_t x = ((int16_t)(raw[0] << 8 | raw[1])) >> 4;
  int16_t y = ((int16_t)(raw[2] << 8 | raw[3])) >> 4;
  int16_t z = ((int16_t)(raw[4] << 8 | raw[5])) >> 4;
  *gx = x / 1024.0f;
  *gy = y / 1024.0f;
  *gz = z / 1024.0f;
}

void setup() {
  // INT 핀: 내부 풀다운 (MMA 초기화 전/단선 시 라인 정의, Deep Sleep 준비)
  pinMode(PIN_INT, INPUT_PULLDOWN);
  attachInterrupt(digitalPinToInterrupt(PIN_INT), onMotion, RISING);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);

  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  uint8_t who = mmaRead(REG_WHO_AM_I);
  if (who != 0x2A) {
    display.setCursor(0, 0);
    display.print(F("WHO=0x")); display.print(who, HEX);
    display.println(F(" FAIL"));
    display.display();
    while (true) delay(1000);
  }

  mmaConfigMotion();

  // 설정 검증 (2초 표시)
  display.setCursor(0, 0);
  display.println(F("MMA8452 ready"));
  display.print(F("R3=")); display.print(mmaRead(REG_CTRL_REG3), HEX);
  display.print(F(" R4=")); display.print(mmaRead(REG_CTRL_REG4), HEX);
  display.print(F(" R5=")); display.println(mmaRead(REG_CTRL_REG5), HEX);
  display.print(F("MT_CFG=")); display.print(mmaRead(REG_FF_MT_CFG), HEX);
  display.print(F(" THS=")); display.println(mmaRead(REG_FF_MT_THS), HEX);
  display.print(F("pin=GPIO")); display.print(PIN_INT);
  display.print(F(" route=INT")); display.println(ROUTE_TO_INT1 ? 1 : 2);
  display.display();
  delay(2000);
}

void loop() {
  float gx, gy, gz;
  readAccel(&gx, &gy, &gz);

  uint8_t src = mmaRead(REG_FF_MT_SRC);   // 읽으면 EA 자동 클리어
  if (src & 0x80) pollCount++;
  if (src)        lastSrc = src;

  if (fabs(gx) > maxAbsX) maxAbsX = fabs(gx);
  if (fabs(gy) > maxAbsY) maxAbsY = fabs(gy);
  if (fabs(gz) > maxAbsZ) maxAbsZ = fabs(gz);
  float mag = sqrt(gx*gx + gy*gy + gz*gz);
  if (mag > maxMag) maxMag = mag;

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
  display.print(F("INT:"));
  display.print(digitalRead(PIN_INT) ? F("H") : F("L"));
  display.print(F(" SRC:0x")); display.println(lastSrc, HEX);
  display.print(F("poll:")); display.print(pollCount);
  display.print(F(" isr:")); display.print(isrCount);
  display.print(F("(")); display.print(isrRawCount); display.println(F(")"));
  display.print(F("up:")); display.print(millis() / 1000); display.print('s');
  display.display();
  delay(50);
}
