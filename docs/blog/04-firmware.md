# 4. 펌웨어 리팩터 — Arduino → IDF

> Arduino 로 시작해서 firmware 5천 줄 넘어가면서 복구 경로 7가지가 얽혔다. 하나 고치면 다른 곳 회귀. 결국 IDF from-source + arduino-esp32 as component 로 이관 중.

## Arduino 로 시작한 이유

첫 sketch (`arduino/05_sim7080g_at/`) 는 breadboard 수준. `#include <Arduino.h>` 로 `setup()/loop()` 짜면 뭔가 돌아감. GPS/LTE 벤더 라이브러리도 대개 Arduino API 로 제공. IDE 하나 열고 컴파일+플래시 3분.

취미 프로젝트로 시작할 때 이 진입 장벽 낮음은 매우 크다. IDF 로 갔으면 ESP-IDF 설치 + CMake + `sdkconfig` + `menuconfig` 부터 배워야 하는데, GPS 하나 잡는 게 목적이면 오버킬.

## Arduino 의 한계가 드러난 순간

`arduino/13_1_motion_aware_tracker/` 시점부터 firmware 가 커지기 시작. GPS + LTE + 모션 + 배터리 + sleep 관리가 다 하나의 `.ino` 파일에 있음. 5천 줄 넘어가면서:

### 1. Serial 이 blocking → INT-WDT 폭주

Arduino 의 `Serial.print()` 는 CDC (USB Serial) 로 나갈 때 **호스트가 안 읽으면 buffer 가 참고 무기한 block** 함. 개발 중에는 문제 없지만 필드 device 는:

- USB monitor 물려 있다가 노트북 sleep 으로 인식 실패 → CDC buffer full → `Serial.print` 안 넘어감
- 그 사이 loop 안 다른 코드 안 돌아감 → **INT-WDT trip** (interrupt watchdog: interrupt disable 상태가 길면 crash)
- Reset 후 다시 부팅 → USB 재감지 실패 → 다시 stall → 다시 INT-WDT

**sss 실측**: 12:06 3분 사이 INT-WDT crash **18회**. `esp_reset_reason() = INT_WDT`. RTC memory 도 유실.

**대응 (Arduino)**: `Serial.setTxTimeoutMs(0)` — CDC write timeout 0ms 로 non-blocking. **arduino-esp32 v3 부터만 있음**. 그 이전 버전은 지원 안 함.

**교훈**: Arduino 도 IDF 위에서 도는데, IDF 의 non-blocking 옵션을 Arduino API 로 노출하는 게 늦음. 이런 종류 사고 잡으려면 **저수준 접근 필수**.

### 2. 복구 경로 7가지 병존

`13_4_motion_aware_tracker` 시점 코드 안 stuck/crash 대응 로직 세어보면:

1. `stuckWatchdog()` — 마지막 성공 POST 이후 5분+ 무응답이면 `esp_restart()`
2. `bootStuckEscalation()` — 부팅 후 성공 POST 0회 5분+ 이면 `esp_restart()`
3. `hardPowerCycle()` — bringup 연속 실패 3회+ 이면 railCycle (PWR_EN 12초 OFF → ON)
4. `softToHardStreak()` — soft cycle 2회 연속이면 hard cycle
5. `dataRetryLimit()` — REG OK 인데 POST 실패 시 CFUN 전 data-plane 재활성 2회
6. `regLostRecovery()` — REG lost 30초+ 지속 시 soft recovery
7. `intWdtBypass()` — INT_WDT crash 후 restart 자체 회복 로직

각각 다른 timer / 다른 조건 / 다른 action. 어느 것부터 트리거될지 예측 어려움. 특히 사고 #1 (INT-WDT 4시간 offline) 같은 케이스는 **모든 로직이 다 무력화**되는 상황.

### 3. 부저와 LTE 상호작용

Chapter 3 에서 다룬 사고 — 마그네틱 부저 (GPIO1 PWM) 가 LTE bringup 방해. 이건 하드웨어 문제인데 firmware 로 우회하려면:

- `BUZZER_ENABLED=0` 로 컴파일 매크로 게이트
- GPIO1 을 `INPUT_PULLDOWN` 으로 격리
- `arduino/13_4_aa_motion_aware_tracker/` fork (sss 원본 오염 방지)

Fork 로 sss/aa 분리는 좋았는데 **공통 patch 는 양쪽 수동 반영**. 매 사고마다 두 번 편집. 통합 firmware 필요.

## IDF from-source 로 이관 결정

`idf_caltest/` 프로젝트를 신설했다. 구조:

```
idf_caltest/
├── CMakeLists.txt              # IDF project entry
├── sdkconfig.defaults          # menuconfig 초기값
├── partitions.csv              # OTA 파티션 (나중에)
├── main/
│   ├── idf_component.yml       # dependencies (arduino-esp32 v3.3.0)
│   ├── CMakeLists.txt          # main component
│   ├── main.cpp                # setup/loop (Arduino API)
│   ├── config.h                # 핀·타이밍·플래그 단일 소스
│   ├── buzzer.{h,cpp}          # Block 1
│   ├── hw_power.{h,cpp}        # Block 2 — PWR_EN 레일 + PWRKEY
│   ├── gps.{h,cpp}             # Block 3 — LC86G/L86 NMEA + 안테나 + batch
│   ├── motion.{h,cpp}          # Block 4 — LIS3DH WAKE-ON-MOTION
│   ├── lte.{h,cpp}             # Block 5 — AT + bring-up
│   ├── telemetry.{h,cpp}       # Block 6 — HTTP POST payload
│   ├── recovery.{h,cpp}        # Block 7 — 복구 state machine 통합
│   ├── sleep_mgr.{h,cpp}       # Block 8 — deep sleep 관리
│   ├── breadcrumb.{h,cpp}      # 죽기 직전 phase (RTC 유지)
│   └── loopwdt.h               # loop task hardware watchdog
└── build/                       # (gitignored)
```

핵심 개선점:

### arduino-esp32 as component

```yaml
# idf_component.yml
dependencies:
  espressif/arduino-esp32:
    version: "^3.3.0"
```

이 한 줄로 arduino-esp32 를 IDF 컴포넌트로 fetch. `Arduino.h`, `Serial`, `HardwareSerial`, `Wire`, `Preferences` 등 다 그대로 사용 가능. **Arduino API 재사용 + IDF 저수준 제어 동시**.

Migration cost 가 매우 낮았음. `13_4_aa` 의 `.ino` 코드를 `main.cpp` 로 옮기고 `#include <Arduino.h>` 추가만 하면 대부분 컴파일. 몇 가지 튜닝 필요 — 예: `Serial.setTxTimeoutMs(0)` 는 arduino-esp32 v3 API 라 IDF build 안에서도 그대로 동작.

### Block 별 이관

`13_4_aa` 의 5000줄 `.ino` 를 통째 옮기지 않고 **하나씩 모듈로 잘라서** 이관:

- **Block 1 (buzzer)**: 능동 부저 상태머신. beep(count, pulse_ms, gap_ms) API. non-blocking update() 를 loop 마다 호출.
- **Block 2 (hw_power)**: PWR_EN 레일 (LOW=ON) + PWRKEY 펄스 (극성 반전 처리). railCycle() 로 12초 OFF → ON.
- **Block 3 (gps)**: LC86G/L86 UART 관리. NMEA parser. 안테나 URC (`$PQTMANTENNASTATUS` + `$GPTXT ANTSTATUS`) 통합 파싱. Batch fixes ring buffer (POST 사이 fix 누적).
- **Block 4 (motion)**: LIS3DH I2C. `WAKE_ON_MOTION` 인터럽트 세팅. Deep sleep 에서도 유지.
- **Block 5 (lte)**: SIM7080 AT 상태머신. `bringUp()`, `httpPost()`, `hardCycle()`. CSQ/REG/IP 모니터링.
- **Block 6 (telemetry)**: JSON payload 빌더. `vbat_mv + cbc_mv` 두 배터리 값 포함.
- **Block 7 (recovery)**: **7가지 병존 로직을 단일 state machine 으로 통합**. 상태: `HEALTHY`, `SOFT_RETRY`, `HARD_RETRY`, `RESTART_ESCALATION`. 매 tick 단일 액션.
- **Block 8 (sleep_mgr)**: 정지 판정 (3분 GPS drift + 모션 quiet) → deep sleep. Timer wake heartbeat (5분/10분). Wake 원인 로깅.

이관 순서로 검증. 예를 들어 Block 1-4 는 sss/aa 두 rev 다 병렬 실기 테스트. Block 5 (lte) 는 통신 안정 확인 후 Block 6 (telemetry) 로. Block 7 은 마지막에 recovery 통합.

### 검증 방법

각 Block 이관 후:

1. **NVS 크래시 카운터** (`hwdiag` namespace) — INT-WDT 등 crash 시 boots 증가. `esp_reset_reason` 별 카운트 (`br`, `iw`, `tw`, `pn`, `sw`).
2. **부저 알람** — crash 재부팅 시 긴삐 3회 자동 알람. 필드 device 를 눈/귀로 진단.
3. **`printStatus()`** — 매 iteration 다중 필드 (LTE/GPS/모션/recovery state) log 출력. 문제 발생 시 grep 편함.

`idf_caltest/main/main.cpp` 의 헤더 주석에 이관 이력 그대로:

```cpp
// Block 1 (done): config.h + buzzer.
// Block 2 (done): hw_power — 공유 PWR_EN 레일 + PWRKEY.
// Block 3 (done): gps — LC86G·NMEA·안테나·fix·drift·batch.
// Block 4 (done*): motion — LIS3DH. wake OK. ※런타임 카운터 open item (motion.cpp).
// Block 5 (done): lte — AT + bring-up + SIM.
// Block 6 (done): lte HTTP keepalive + telemetry. POST 200 검증.
// Block 7 (done): recovery — 복구 경로 통합 단일 state machine (무오발동 검증).
// Block 8 (현재): sleep_mgr — deep sleep + wake 부기 + 정지 자동 sleep + timer-wake heartbeat.
```

## Recovery state machine (Block 7 하이라이트)

7가지 복구 로직을 하나로 통합한 예:

```cpp
namespace recovery {
  enum State { HEALTHY, SOFT_RETRY, HARD_RETRY, RESTART_ESCALATION };
  static State s_state = HEALTHY;
  static uint32_t s_bringFails = 0;
  static uint32_t s_hardResets = 0;
  static uint32_t s_softStreak = 0;

  void notifyPostResult(bool ok200) {
    if (ok200) { s_state = HEALTHY; s_softStreak = 0; return; }
    // 실패
    s_softStreak++;
    if (s_softStreak >= SOFT_TO_HARD_STREAK) {
      s_state = HARD_RETRY;
      lte::hardCycle();
      s_hardResets++;
      s_softStreak = 0;
    } else {
      s_state = SOFT_RETRY;
      lte::softReconnect();
    }
    if (s_hardResets >= HARD_RESET_LIMIT) {
      s_state = RESTART_ESCALATION;
      esp_restart();
    }
  }
}
```

기존 7가지 로직이 각기 다른 timer/조건으로 병존하던 걸 **매 POST 결과에 단일 함수** 호출로 정리. 예측 가능. 무오발동 검증 완료 (필드 테스트 며칠).

## Arduino IDE 병행 유지

`arduino/15_a_modular/` — IDF 코드와 동일한 소스를 Arduino IDE 로도 컴파일 가능하게 유지. 이유:

- 하드웨어 팀은 Arduino IDE 익숙 (menu → upload). IDF 는 진입 장벽
- 급한 실험 (`arduino/hwteam_oldmod_test/`, `arduino/zz_buzzer_test/` 등) 은 Arduino IDE 로 5분 만에 sketch 하나 짜서 flash

즉 **개발 편의 (Arduino IDE) + 저수준 제어 (IDF from-source) 를 동시**에. 같은 로직을 두 build system 이 다 컴파일할 수 있게 config.h 조건부 몇 개.

## 지금 상태

- `idf_caltest/` = **golden reference** (필드 device 에 flash 되는 실행 binary 소스)
- `arduino/15_a_modular/` = Arduino IDE 병행본
- `arduino/13_4_aa_motion_aware_tracker/` = 이관 원본 (backward compat 참고)

`13_4_aa` 는 유지하되 새 patch 는 `idf_caltest` 우선. 이관 완료 후 `13_4_aa` deprecated 처리 예정 (아직 아니지만).

## 배운 것

1. **Arduino IDE 로 시작한 것은 옳았다** — 빠른 프로토, 낮은 진입장벽
2. **어느 순간 IDF 필요** — Serial blocking, RTC memory 세밀 제어, non-blocking CDC 등. 코드 커지고 사고 잦아지면 IDF 필수
3. **Big-bang 이관 X, Block 별 이관 O** — 5000줄 통째로 옮기려 하면 마감 안 됨. 작은 module (buzzer, hw_power, gps, ...) 단위로 잘라서 순차. 각 Block 별 실기 검증.
4. **arduino-esp32 as component 는 좋은 절충** — Arduino API 재사용 + IDF 저수준 접근 동시. Migration cost 매우 낮음.
5. **Fork (sss/aa) 는 초기엔 좋음, 나중엔 짐** — 공통 patch 두 번 반영. 이관 완료되면 통합.

## 다음

- [5. 서버 (Rust + axum + Timescale)](05-server.md)
- [8. 실전 사고](08-troubleshooting.md) — 사고 #1 (INT-WDT), #6 (부저↔LTE), #? (Serial blocking) 이 이 챕터의 근거
