// ESP32-C3 mini: 진짜 Deep Sleep + GPIO1 스위치 토글 — OLED 전용 디버그
//
// 배선:
//   GPIO1 <- 스위치 한 쪽. 다른 쪽은 GND. (active LOW, 내부 INPUT_PULLUP + RTC pullup)
//   GPIO6 -> 모듈 전원 제어 (awake=LOW, sleep=HIGH)
//   OLED I2C: GPIO8(SDA), GPIO9(SCL), 주소 0x3C
//   배터리 ADC: GPIO3 (분압비 2.0 가정)
//
// 사이클:
//   부팅 → awake 상태 (GPIO6 LOW, OLED ON, 정보 표시)
//   스위치 눌림(HIGH 감지) → deep sleep 진입 (GPIO6 HIGH, OLED OFF, 무제한)
//   스위치 다시 눌림 → wake → 재부팅 → awake 상태
//
// Deep Sleep wake: ext1 (GPIO1 LOW 레벨). RTC GPIO 0~5만 가능, GPIO1 OK.
//
// ⚠ Serial / USB CDC 출력 없음 — 배터리 직결 측정 중 노이즈 최소화.

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <esp_sleep.h>
#include <driver/gpio.h>

// --- pins ---
#define PIN_SDA        8
#define PIN_SCL        9
#define OLED_ADDR      0x3C

#define PIN_SWITCH     1     // 스위치 (active LOW, deep sleep wake)
#define PIN_PWR_EN     6     // 모듈 전원 (LOW=ON, HIGH=OFF)
#define SWITCH_PRESSED LOW
#define SWITCH_RELEASED HIGH
#define PIN_BAT        3     // 배터리 ADC
#define BAT_DIV_RATIO  2.0f

// --- 버튼 설정 ---
#define BTN_DEBOUNCE_MS              30
#define BTN_HOLD_RELEASE_TIMEOUT_MS  5000
// release 후 상태 전환까지의 유예 — 채터링/접점 불안정 방어
#define BTN_RELEASE_GRACE_MS         500

// --- RTC 메모리 (deep sleep 건너 유지) ---
RTC_DATA_ATTR uint32_t bootCount   = 0;
RTC_DATA_ATTR uint32_t awakeCount  = 0;
RTC_DATA_ATTR uint32_t sleepCount  = 0;

Adafruit_SSD1306 display(128, 64, &Wire, -1);

static uint16_t readVbatMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(PIN_BAT);
  return (uint16_t)((sum / 16) * BAT_DIV_RATIO);
}

static uint16_t readSwitchMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogReadMilliVolts(PIN_SWITCH);
  // ADC 읽기 후 pinMode 원복 — ESP32 analogRead가 내부 pullup을 꺼버리는 경우 대비
  pinMode(PIN_SWITCH, INPUT_PULLUP);
  return (uint16_t)(sum / 8);
}

static const char* wakeReasonStr(esp_sleep_wakeup_cause_t c) {
  switch (c) {
    case ESP_SLEEP_WAKEUP_GPIO:      return "SWITCH";
    case ESP_SLEEP_WAKEUP_EXT1:      return "EXT1";
    case ESP_SLEEP_WAKEUP_TIMER:     return "TIMER";
    case ESP_SLEEP_WAKEUP_UNDEFINED: return "RESET";
    default:                         return "OTHER";
  }
}

static void initOled() {
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
}

static void drawAwake(esp_sleep_wakeup_cause_t cause) {
  display.clearDisplay();
  display.setCursor(0, 0);
  display.setTextSize(2);
  display.println(F("AWAKE"));
  display.setTextSize(1);

  display.print(F("boot #")); display.print(bootCount);
  display.print(F(" awk #")); display.println(awakeCount);
  display.print(F("sleeps ")); display.print(sleepCount);
  display.print(F(" up "));    display.print(millis() / 1000); display.println(F("s"));
  display.print(F("vbat "));   display.print(readVbatMv()); display.println(F(" mV"));
  display.print(F("IO1 d="));  display.print(digitalRead(PIN_SWITCH));
  display.print(F(" a="));     display.print(readSwitchMv()); display.println(F("mV"));
  display.print(F("IO6="));    display.print(digitalRead(PIN_PWR_EN));
  display.print(F(" wk:"));    display.println(wakeReasonStr(cause));
  display.display();
}

static void drawSleepBanner() {
  display.clearDisplay();
  display.setCursor(0, 16);
  display.setTextSize(2);
  display.println(F(" SLEEP"));
  display.println(F("  ..."));
  display.setTextSize(1);
  display.display();
}

// 스위치 확인 (active LOW): 디바운스 후에도 LOW면 true. release 후 GRACE 기간까지 대기.
static bool buttonWasPressed() {
  if (digitalRead(PIN_SWITCH) != SWITCH_PRESSED) return false;
  delay(BTN_DEBOUNCE_MS);
  if (digitalRead(PIN_SWITCH) != SWITCH_PRESSED) return false;

  // 사용자가 손 뗄 때까지 대기 (HIGH 복귀)
  uint32_t t0 = millis();
  while (digitalRead(PIN_SWITCH) == SWITCH_PRESSED && millis() - t0 < BTN_HOLD_RELEASE_TIMEOUT_MS) {
    delay(10);
  }
  // release 후 그레이스 — 채터링 방어. 이 기간 중 다시 LOW 튀면 false 반환.
  uint32_t g0 = millis();
  while (millis() - g0 < BTN_RELEASE_GRACE_MS) {
    if (digitalRead(PIN_SWITCH) == SWITCH_PRESSED) return false;
    delay(10);
  }
  return true;
}

static void enterDeepSleep() {
  sleepCount++;

  // OLED 배너 후 꺼서 자체 소모 제거
  drawSleepBanner();
  delay(500);
  display.ssd1306_command(SSD1306_DISPLAYOFF);

  // 모듈 전원 차단
  digitalWrite(PIN_PWR_EN, HIGH);

  // GPIO1 설정: pullup 유지, pulldown 금지 → 기본 HIGH, 스위치 닫히면 LOW
  gpio_pulldown_dis((gpio_num_t)PIN_SWITCH);
  gpio_pullup_en((gpio_num_t)PIN_SWITCH);

  // ESP32-C3 deep sleep GPIO wake (LOW 레벨) — ext1 대신 신 API 사용
  esp_deep_sleep_enable_gpio_wakeup(1ULL << PIN_SWITCH, ESP_GPIO_WAKEUP_GPIO_LOW);

  // 다른 wake 소스 모두 무효 (무제한 sleep)
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_TIMER);

  esp_deep_sleep_start();
  // 여기 이후는 실행되지 않음. 깨어나면 setup부터 재시작.
}

void setup() {
  bootCount++;

  // 1) 모듈 전원 즉시 ON (awake 상태)
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);

  // 2) 스위치 핀 입력 + 풀업 (active LOW)
  pinMode(PIN_SWITCH, INPUT_PULLUP);

  // 3) ADC / OLED 초기화
  analogReadResolution(12);
  initOled();

  // 4) wake 원인 확인. GPIO(스위치)로 깨어난 경우 awakeCount 증가
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  if (cause == ESP_SLEEP_WAKEUP_GPIO || cause == ESP_SLEEP_WAKEUP_EXT1) {
    awakeCount++;
  }

  // 5) awake 화면 한 번 그림. 이후 loop에서 주기 갱신
  drawAwake(cause);

  // 6) 깨어난 직후 스위치 아직 눌려있을 수 있음 → release(HIGH) + GRACE 대기
  uint32_t t0 = millis();
  while (digitalRead(PIN_SWITCH) == SWITCH_PRESSED && millis() - t0 < BTN_HOLD_RELEASE_TIMEOUT_MS) {
    delay(10);
  }
  // GRACE 중 다시 LOW 튀면 타이머 재시작 — 채터링 반복되어도 완전히 조용해질 때까지 대기.
  uint32_t g0 = millis();
  while (millis() - g0 < BTN_RELEASE_GRACE_MS) {
    if (digitalRead(PIN_SWITCH) == SWITCH_PRESSED) { g0 = millis(); }
    delay(10);
  }
}

void loop() {
  // 화면 주기 갱신 (500ms) — 실시간 VBAT / IO 상태 관찰
  static uint32_t lastDraw = 0;
  if (millis() - lastDraw > 500) {
    lastDraw = millis();
    drawAwake(esp_sleep_get_wakeup_cause());
  }

  // 스위치 감지 → Deep Sleep 진입
  if (buttonWasPressed()) {
    enterDeepSleep();
  }

  delay(20);
}
