# 15_a_modular — 아키텍처 & 리팩터 문서

esp32c3-mini_gps LTE/GPS 트래커. 원본 `13_4_aa_motion_aware_tracker`(단일 .ino 2114줄)를
모듈로 분리·재구성한 버전. _작성 2026-07-02._

---

## 1. 배경 — 왜 리팩터했나

원본 `13_4_aa` 는 기능적으로는 현장 단련됐으나:
- **단일 파일 2114줄**, 전역 가변 상태 다수, 함수 경계는 있으나 관심사 혼재.
- **사고 대응 패치 누적** → 복구(recovery) 경로가 **7개**로 얽혀 서로 같은 플래그를 다르게 조작
  (bringup 재시도 / POST fail streak / 60s stuck / REG lost / 서버 cmd:reset / boot-stuck / timer-wake guard).
  → "지금 뭘 하고 있는지" 추적 불가, 이중 리셋·오발동 위험.
- **죽은 코드**: `esp_task_wdt_reset()` feed(「A안」)가 실제로는 no-op(loop task 미등록)이면서 로그만 오염,
  legacy 안테나 스캐너(신 HW 에선 매칭 안 됨), 주석 트리거 등.
- **블로킹 구조**: sendAT/bringUp 이 loop 를 수십 초 블로킹.
- **진단 불가**: 현장에선 DB 로그만 봤기 때문에 **LTE POST 이전에 죽는 stuck** 은 원리상 관측 불가.

목표: 관심사 분리 + 복구 로직 단일화 + 진단 계측 추가. **블록(모듈) 단위로 이관하며 매 단계 실기 검증.**

---

## 2. 모듈 아키텍처

| 모듈 | 책임 | 핵심 인터페이스 |
|---|---|---|
| `config.h` | 전 핀·파라미터·빌드플래그 **단일 소스** | (매크로) |
| `breadcrumb` | 마지막 실행 단계 RTC 기록 (crash/stuck 위치) | `set()`, `last()` |
| `buzzer` | 능동 부저 non-blocking FSM | `init/beep/update/flush` |
| `hw_power` | **GPS+LTE 공유 PWR_EN 레일** + PWRKEY (HW 결합 격리) | `railOn/railOff/railCycle/pulsePwrKey` |
| `gps` | LC86G NMEA·안테나·fix freshness·drift history·batch | `feed/hasFix/getFix/recentDrift/batch*` |
| `motion` | LIS3DH init·**폴링 카운트**·I2C 헬스/reinit·wake 소스 | `init/tick/quiet/clearLatch/events` |
| `lte` | AT 계층·bring-up·HTTP keepalive·SIM·**복구 프리미티브** | `init/bringUp/httpPost/reactivateData/softReset/hardCycle/refresh` |
| `telemetry` | 모듈 상태 → 서버 JSON payload (순수 view) | `buildPayload/buildSleepPayload/deviceUid` |
| `recovery` | **LTE 연결 수명주기 + 복구 단일 state machine** | `init/tick/notifyPostResult/online` |
| `sleep_mgr` | deep sleep·wake 부기·정지 자동 sleep·wake bounce·timer-hb | `begin/checkStationary/enterDeepSleep/wakeReason` |
| `15_a_modular.ino` | 얇은 오케스트레이터 (setup 시퀀스 + loop tick) | `setup/loop` |

### 의존 방향 (단방향)
```
config.h  ← (모두)
breadcrumb ← lte, recovery, sleep_mgr, telemetry, main
buzzer     ← main
hw_power   ← lte, sleep_mgr, main
gps        ← telemetry, sleep_mgr, main
motion     ← telemetry, sleep_mgr, main
lte        ← recovery, sleep_mgr, telemetry, main   (내부: hw_power, breadcrumb)
telemetry  ← main, sleep_mgr                         (읽기: gps/motion/lte/sleep_mgr/recovery)
recovery   ← main, sleep_mgr                         (내부: lte, breadcrumb)
sleep_mgr  ← main                                    (내부: motion/gps/hw_power/lte/telemetry/recovery)
```
데이터 모듈(gps/motion/lte)은 서로 모름. 상위(telemetry/recovery/sleep_mgr)가 이들을 조합.

### loop() 오케스트레이션
```
gps::feed()            // NMEA 수집·파싱·batch
motion::tick()         // 폴링 모션 카운트·I2C 헬스
recovery::tick()       // LTE 연결 수명주기 + 복구 (단일 결정기)
if (online && due) doPost()   // telemetry build → lte::httpPost → recovery::notifyPostResult
sleep_mgr::checkStationary()  // 정지 판정 → deep sleep
sleep_mgr::timerWakeTick()
printStatus(); buzzer::update()
```
"data(POST)" 와 "connectivity(recovery)" 를 분리 — recovery 는 연결만 책임지고,
POST 는 main 이 수행 후 결과만 통지.

---

## 3. 개선 사항 (원본 대비)

| # | 개선 | 상태 |
|---|---|---|
| 1 | **WDT no-op feed 제거** (`esp_task_wdt_reset` 6곳) — 아무것도 보호 못 하며 로그만 오염하던 것 | ✅ 검증 |
| 2 | **죽은 코드 제거** — legacy 안테나 스캐너, 주석 'a' sleep 트리거 | ✅ |
| 3 | **복구 7경로 → 단일 state machine** (`recovery`) — 매 tick 단일 액션, 오발동 0 검증 | ✅ 검증 |
| 4 | **HTTP keepalive 재사용** — 2번째 POST 는 SHREQ 만 (6.2s→1.5s) | ✅ 검증 |
| 5 | **모션 카운터 폴링 전환** — 엣지-ISR starvation 버그 회피 (원본 잠재버그) | ⚠️ 튜닝 open |
| 6 | **telemetry 원본수준 확장** — awake/at_ms/reset_cause/last_op/**cbc_mv**, l80(ttff/heading), stationary{11}, diag{}, fixes[] | ✅ 검증 |
| 6b | **[P1.5] SHCONN "operation not allowed" 회복** — httpPost SHCONN 실패 시 즉시 reactivateData(CNACT 재활성). 운행서 이 두절 포착 | ✅ 회귀검증 (실동작 실측대기) |
| 6c | **cbc_mv** — AT+CBC(모뎀 VBAT) telemetry 추가, ESP divider 교차검증 | ✅ 검증 |
| 7 | **부저 stretched-beep 수정** — 마일스톤 beep 뒤 flush + deep sleep gpio_hold + boot 즉시 LOW | ✅ 검증 |
| 8 | **breadcrumb(last_op)** + reset_cause — crash/stuck 위치 특정 | ✅ (계측) |
| 9 | **sleep_enter POST** — deep sleep 진입 이벤트 서버 전송 | ✅ 검증 |
| 10 | **[P0] 에스컬레이션 카운터 RTC 승격** + 미등록 중 sleep 보류 | ✅ 회귀검증 (실동작 실측 대기) |
| 11 | **[P1] REG 분기 복구** — reg OK 면 data-plane 만(`reactivateData`, CFUN 안 함), softReset 에 COPS=0 | ✅ 회귀검증 (실동작 실측 대기) |

---

## 4. 기존 문제 대비 기대 해결도

| 원본 증상 | 해결 수단 | 기대 | 신뢰도 |
|---|---|---|---|
| WDT 로그 홍수 / 「A안」 무효 | #1 제거 | 완전 해결 | 높음(검증) |
| 복구 경로 얽힘 → 이중 리셋·오발동 | #3 단일 state machine | 완전 해결 | 높음(검증) |
| keepalive 미작동 의심 | #4 | 해결 | 높음(검증) |
| **정지+신호상실 시 영구 stuck** (sleep 이 에스컬레이션 리셋) | #10 P0 | **해결 기대** | 중(실측 대기) |
| **reg=5 but conn=0** → CFUN 과대응 → REG=0 재등록 stuck | #11 P1 | **완화/해결 기대** | 중(실측 대기) |
| 부저 5s 반복 buzz | #7 | 완전 해결 | 높음(검증) |
| crash 위치 불명(사무실서도 발생) | #8 breadcrumb | 원인 특정 가능해짐 | 높음(계측) |
| DB 로만 봐서 pre-LTE stuck 안 보임 | 시리얼 관찰 하네스(drive_capture) | 관측 가능해짐 | 높음 |

**요약**: WDT·복구경로·keepalive·부저는 **이 리팩터만으로 해결**. 만성 **30분 두절**의 유력 원인 2개(P0 정지-stuck, P1 conn=0 과대응)는 **수정 반영됐고 정상 회귀는 확인**했으나, **실효는 운행 실측으로 최종 확정 필요**.

---

## 5. 잠재적 문제 / 리스크

- **랩탑 관찰의 사각지대**: USB 급전 + CDC 모니터가 붙으면 **배터리 brownout** 과 **CDC 버퍼 블로킹**(원본 최상단 경고) 두 실패모드가 **가려짐**. 추가로 **USB(~4.85V)가 SIM7080 VBAT 과전압** 유발(OVER-VOLTAGE 상시) — 배터리(~4.0V)엔 없는 아티팩트. → **필드 두절은 배터리로 관찰해야 신뢰.** (cbc_mv/vbat_mv 로 확인 가능.)
- **관찰된 진짜 두절**: SIM7080 `SHCONN "operation not allowed"`(REG/신호 정상인데 데이터소켓 거부) — P1.5 로 즉시 PDP 재활성 대응. 실효는 배터리 운행 실측 대기.
- **GPS 외부안테나 `ANTSTATUS=OPEN`**: L86-M33 이 DC 전류 미검출(패시브 or 바이어스 미급전). fix 는 내장 패치로 동작. **SW 불가 = HW bias-tee 사안.** 진단·증명법 → `../../GPS_ANTENNA.md`. (gps.cpp 에 `[GPS raw-ant]` 진단 로깅 존재.) → 이 두 계열 stuck 은 배터리 단독 + CDC-disabled 조건에서만 재현/검증 가능. (오늘 관찰은 신호/bringup/로직/crash 계열만 커버.)
- **P1 reactivateData/COPS 실효 미확정**: 약신호에서 CFUN 없이 PDP 재활성이 실제로 conn 을 살리는지, COPS=0 가 REG=0 stuck 을 앞당겨 푸는지 미검증.
- **P0 stay-awake trade-off**: 신호상실 시 최대 5분 깨어서 재시도 → **배터리 소모 증가**. (정지 stuck 회피와의 trade-off. 5분 상한 후엔 sleep 허용.)
- **모션 카운터 under-count**: 폴링으로도 벤치 손흔들기 카운트가 약함(THS/DUR 튜닝 필요). quiet 판정이 조기 sleep 유발 가능하나 **GPS drift 교차검증이 완화**. deep-sleep wake(하드웨어 INT) 자체는 정상.
- **batch vs BODYLEN**: body 8KB 이나 SHCONF BODYLEN 4096 → batch 를 3800B 로 캡(초과분 다음 cycle). 극단적 실패 누적 시에도 안전하나, 장기 두절 후 backlog 전송이 여러 cycle 로 분산됨.
- **부저↔LTE**: 능동 부저라 back-EMF 가정은 부정확할 수 있고 부저 ON 으로 POST 200 정상 확인됨. 단 운영 정책은 미결정.
- **OBSERVE_MODE 빌드**: 현재 관찰용(30s 정지 sleep + 8s auto-wake, drift 임계 1000). 운영 전 반드시 원복.

---

## 6. 미확정 패턴 (운행 실측 시 파악 예정)

- **사무실에서도 났다는 "크리티컬 크래시"**: walk 5분엔 미재현. 장시간/운행 시 발생하면 `reset_cause`(PANIC/INT-WDT/BROWNOUT) + `last_op`(breadcrumb) 로 **어느 단계에서 죽는지** 특정.
- **지하주차장 통과 → 시동 → 30분 두절의 정확한 트리거 시퀀스**: wake(motion) → bringup → 어디서 멈추는지 연속 캡처.
- **P0/P1 수정이 실제 30분 두절을 없애는지**: 운행 중 신호존 전환에서 escalation-across-sleep, reactivate/COPS 회복이 실동작하는지.
- **배터리 단독(brownout) / CDC-disabled 조건의 stuck**: 랩탑 관찰로는 못 봄 — 별도 조건 필요.

---

## 7. 남은 ToDo → `../../TODO_refactor.md` 참조

요약: 운행 실측(P0/P1 실동작 + pre-LTE stuck/crash 재현), P2(모션 튜닝·부저 정책·임시 스케치 정리), 운영 flash 원복.

---

## 8. 빌드 / 플래그 / 원복

- **모니터링 빌드(현재)**: FQBN `esp32:esp32:esp32c3:CDCOnBoot=cdc`, `BUZZER_ENABLED 1`, `OBSERVE_MODE 1`, `SLEEP_TEST 0`.
- **운영 flash 전 원복**: `OBSERVE_MODE 0`, `SLEEP_TEST 0`, `CDCOnBoot=default`(배터리 CDC 블로킹 회피), 부저 정책 결정.
- 라이브러리: TinyGPSPlus. 코어: esp32:esp32.
- 관찰 로거: `../../drive_logger.py` (Python pyserial — auto-reconnect, 호스트 타임스탬프, UTF-8, 라인 flush; `logs/serial_*.log`). 구 `drive_capture.ps1` 은 백업.

---

## 9. 검증 현황

| 구분 | 항목 |
|---|---|
| ✅ 벤치 검증 완료 | 모듈 분리, WDT 제거, 복구 state machine 무오발동, keepalive, telemetry 확장, 부저 수정, sleep→motion wake→re-sleep 사이클, sleep_enter POST, 신호복귀 자동회복+batch 무손실, P0/P1 정상회귀 |
| ⏳ 실측 대기(운행) | P0 escalation-across-sleep 실동작, P1 reactivate/COPS 회복 실효, pre-LTE stuck/crash 재현·위치특정 |
| ⚠️ 미커버(조건 필요) | 배터리 brownout stuck, CDC-disabled 블로킹 stuck (랩탑 관찰로 가려짐) |
