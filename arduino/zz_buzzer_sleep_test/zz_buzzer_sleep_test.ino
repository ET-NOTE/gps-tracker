// =================================================================
// zz_buzzer_sleep_test (HIGH 버전) — gpio_hold 가 deep sleep 중 GPIO1 상태를
//   실제로 래치하는지 확정하는 대조 실험. sleep 진입 전 GPIO1=HIGH 로 두고 hold 교대.
//     · hold=OFF sleep → HIGH 안 유지(출력 비활성) → 무음(빠짐)
//     · hold=ON  sleep → HIGH 유지 → 6초 내내 울림
//   → OFF 무음 / ON 울림 이면 gpio_hold 가 상태를 래치함이 증명됨.
//   awake 4초(LOW)는 항상 무음(기준선).
// =================================================================
#include <esp_sleep.h>
#include "driver/gpio.h"

#define PIN_BUZZER 1
RTC_DATA_ATTR int cyc = 0;

void setup() {
  gpio_hold_dis((gpio_num_t)PIN_BUZZER);      // 이전 sleep hold 해제 → wake 후 즉시 조용
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  Serial.begin(115200);
  delay(2000);
  Serial.printf("\n=== sleep HOLD test | cyc=%d wake_cause=%d ===\n",
    cyc, (int)esp_sleep_get_wakeup_cause());

  Serial.println(F("[awake] GPIO1 LOW 4s — 무음 기준선"));
  digitalWrite(PIN_BUZZER, LOW);
  delay(4000);

  bool useHold = (cyc % 2 == 1);   // cyc 0,2,4=OFF / 1,3,5=ON
  Serial.printf("[sleep] 6s — GPIO1=HIGH, hold=%s → 예상: %s\n",
    useHold ? "ON" : "OFF", useHold ? "울림(HIGH 유지)" : "무음(HIGH 안 유지)");
  digitalWrite(PIN_BUZZER, HIGH);   // ★ HIGH 로 두고 진입
  if (useHold) {
    gpio_hold_en((gpio_num_t)PIN_BUZZER);
    gpio_deep_sleep_hold_en();
  }
  cyc++;
  esp_sleep_enable_timer_wakeup(6ULL * 1000000ULL);
  Serial.flush();
  esp_deep_sleep_start();
}

void loop() {}
