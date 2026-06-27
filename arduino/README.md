# Arduino sketches

ESP32-C3 mini GPS tracker 의 firmware sketch 모음. 단계별 incremental development + 진단용 bisection sketch.

## Production firmware (현재 운영용)

| Sketch | 단말기 버전 | 주요 특징 |
|---|---|---|
| [13_1_motion_aware_tracker](13_1_motion_aware_tracker/) | **v1** (구버전) | LIS3DH motion-aware sleep, L80-R GPS (9600 baud), SIM7080G LTE-M, motion wake, geofence, lifecycle (wake/sleep_enter) |
| [13_2_motion_aware_tracker](13_2_motion_aware_tracker/) | **v2** (신버전 PCB) | = 13_1 + PCB rev (LTE RX/TX swap, GPIO1 부저). **A안 WDT feed** 적용 |
| [13_3_motion_aware_tracker](13_3_motion_aware_tracker/) | **v3** (LC86G 최신) | = 13_2 + 부저 driver tone() → digitalWrite + GPS_BAUD 115200 (LC86G boot default) + A안 WDT feed |
| [13_4_motion_aware_tracker](13_4_motion_aware_tracker/) | **v3** (LC86G 최신) | = 13_3 + LC86G 가벼운 호환 변경 (PAIR025 EASY, PAIR062 GLL/VTG OFF, STATIONARY 3분, fix 판정 완화 sat>=3/age<10s/hdop<5.0, payload hdop 필드) |
| [13_5_motion_aware_tracker](13_5_motion_aware_tracker/) | v3 — **참고용 / 폐기** | 13_4 회귀 분석용 누적 sketch (PMTK741 hot-start hint + PQTMANTENNASTATUS 파싱 + GSV 1s 포함). 부담 크다고 판단되어 production 미사용 |

**A안 (WDT feed)**: `esp_task_wdt_reset()` 을 sendAT/waitUartIdle/sendBodyAfterPrompt/doPost/SHREAD 5곳에 명시 호출. INT-WDT cascade 회피 → cold-boot 손실 방지. 의사결정 컨텍스트: [`memory/project_int_wdt_bypass_decision.md`](../memory/project_int_wdt_bypass_decision.md).

## 진단용 sketch (한시적)

| Sketch | 목적 |
|---|---|
| [14_a ~ 14_j, 14_l, 14_m](.) | 부저 ↔ LTE 간섭 bisection (2026-06-23~24). 결론: GPIO1 PWM 직결이 LTE 깨뜨림 → 13_3 의 digitalWrite driver 로 회피. 자세한 결론: [`memory/project_buzzer_lte_diagnostic.md`](../memory/project_buzzer_lte_diagnostic.md) |

## Hardware test sketch

| Sketch | 목적 |
|---|---|
| `01_oled_test`, `02_battery_adc`, `03_*` | 각 peripheral 단독 동작 검증 (OLED, ADC, LIS3DH, I2C scan, L80 GPS, SIM7080G, LC86G antenna) |
| `04_gps_l80r_test` ~ `12_continuous_tracker` | 통합 firmware 개발 progression (production 진입 전 prototype). 13_x 시리즈로 대체됨 |

## Build / flash

`arduino-cli` 사용 — fqbn `esp32:esp32:esp32c3:CDCOnBoot=cdc`. 예시:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc arduino/13_4_motion_aware_tracker
arduino-cli upload  --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc -p COM41 arduino/13_4_motion_aware_tracker
```
