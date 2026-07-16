// =================================================================
// zz_buzzer_test — 능동 부저 단독 격리 테스트 (GPIO1 만 건드림).
//   LTE/GPS/LIS/sleep/WiFi 전부 없음 → 부저 원인 완전 격리.
//   각 단계(A~F)를 시리얼에 찍으며 GPIO1 상태를 바꿈. 소리와 로그를 대조하세요.
//
//   판정 포인트:
//   · A(LOW 8s) 가 무음, B(HIGH 3s) 가 울림  → GPIO1 이 부저 제어, LOW=무음 (정상)
//   · A(LOW) 가 여전히 울림                   → GPIO1 LOW 로 안 꺼짐 = 배선/HW 문제 (다른 핀?)
//   · D(INPUT_PULLDOWN) 가 울림               → 플로팅 시 울림 = boot/sleep 전기적 원인 확정
//
//   FQBN: esp32:esp32:esp32c3:CDCOnBoot=cdc  (시리얼 관찰용)
// =================================================================
#define PIN_BUZZER 1

static void hold(const char *tag, int level, uint32_t ms) {
  const char *st = (level < 0) ? "INPUT_PULLDOWN(float)" : (level ? "HIGH(=on 예상)" : "LOW(=off 예상)");
  Serial.printf("[%lus] --- %s : GPIO1 = %s for %lums ---\n",
    (unsigned long)(millis() / 1000), tag, st, (unsigned long)ms);
  Serial.flush();
  if (level < 0) {
    pinMode(PIN_BUZZER, INPUT_PULLDOWN);
  } else {
    pinMode(PIN_BUZZER, OUTPUT);
    digitalWrite(PIN_BUZZER, level ? HIGH : LOW);
  }
  uint32_t t0 = millis();
  while (millis() - t0 < ms) delay(50);
}

void setup() {
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);   // 부팅 즉시 LOW
  Serial.begin(115200);
  delay(2000);
  Serial.println();
  Serial.println(F("=== zz_buzzer_test — GPIO1 단독 격리 ==="));
  Serial.println(F("소리를 들으며 각 단계 로그와 대조하세요."));
}

void loop() {
  hold("A LOW",            0, 8000);   // 무음이어야 함
  hold("B HIGH",           1, 3000);   // 울려야 함 (active buzzer on)
  hold("C LOW",            0, 5000);   // 무음
  hold("D FLOAT(pulldown)", -1, 5000); // 플로팅 상태 — 울리는지?

  // E: 짧은 3-beep (HIGH/LOW 토글)
  Serial.printf("[%lus] --- E 3-beep (120ms on/off) ---\n", (unsigned long)(millis() / 1000));
  pinMode(PIN_BUZZER, OUTPUT);
  for (int i = 0; i < 3; i++) {
    digitalWrite(PIN_BUZZER, HIGH); delay(120);
    digitalWrite(PIN_BUZZER, LOW);  delay(120);
  }

  hold("F LOW (긴 무음)",   0, 10000);  // 10s 무음 — 여기서 울리면 GPIO1 무관 확정
}
