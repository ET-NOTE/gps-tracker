# 4. 펌웨어 리팩터 — Arduino → IDF (draft)

> Draft. 상세 서사는 발행 전 완성 예정.

## 요약

- **초기**: Arduino IDE + `arduino-esp32` core. 빠른 프로토 iteration
- **문제**: firmware 5K 줄 넘어가면서 stuck watchdog / recovery 경로가 7가지 병존. 하나 고치면 다른 곳 회귀
- **결정**: IDF from-source + `arduino-esp32` as component 방식으로 이관 시작 (`idf_caltest/`)
- **Block 별 이관** (아직 진행 중):
  - Block 1: config.h + buzzer
  - Block 2: hw_power (PWR_EN 레일 + PWRKEY)
  - Block 3: gps (LC86G · NMEA · 안테나 · fix · drift · batch)
  - Block 4: motion (LIS3DH · WAKE-ON-MOTION)
  - Block 5: lte (AT + bring-up + SIM)
  - Block 6: lte HTTP keepalive + telemetry
  - Block 7: recovery (단일 state machine 으로 통합)
  - Block 8: sleep_mgr (deep sleep · timer wake)
- **golden reference**: `arduino/13_4_aa_motion_aware_tracker/` (Arduino 최종본)
- **target**: `idf_caltest/` (IDF 최종본)

## 왜 IDF?

- **Non-blocking CDC**: Arduino Serial 은 blocking. Logger 스톨 시 firmware 영구 hang. IDF 는 `setTxTimeoutMs(0)` 로 non-blocking. 사고 #? (INT-WDT 크래시 폭주) 방지.
- **RTC memory 세밀 제어**: `RTC_DATA_ATTR` 는 arduino-esp32 에도 있지만 IDF 는 더 세밀 (특히 wake-stub, deep sleep 후 첫 실행).
- **partition 자유**: OTA 파티션 조정, NVS 분리 등.
- **cargo/npm 같은 dependency 관리**: `idf_component.yml` 로 arduino-esp32 도 pin.

## 관련 코드

- `idf_caltest/main/main.cpp` — 상단 주석에 Block 이관 이력
- `arduino/15_a_modular/` — Arduino IDE 로도 같은 소스 관리 (개발 편의)

## 다음

- [5. 서버](05-server.md) — draft
