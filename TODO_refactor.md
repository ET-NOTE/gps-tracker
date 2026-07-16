# esp32c3-mini_gps 리팩터/진단 ToDo (15_a_modular)

_2026-07-02 벤치 + 사무실 walk. 2026-07-03 운행 2차·3차. 2026-07-06 운행 4차 + P5(railCycle)로 갱신._

## 🚗 운행 4차 결과 (2026-07-06 09:21~09:35, sss/USB, field-like OBSERVE 3분창, POST 15s, ~14분) — 요약
_config: sss field-like 프로파일(3분창/30s boot grace/50m drift/3분 no-gps grace, TIMER 5분). 무외부안테나(내장패치)._
- 🔴 **★출발 직전 "콜드 stuck" 재현 (09:16~09:20) — firmware 자가복구 전부 소진했는데도 복구 실패**: 밤샘 세션이 boot-stuck(no POST 5min)→모뎀 완전 무응답(`>> AT`→`<< timeout`, CSQ=-1 REG=-1). 복구 시퀀스 `PWRKEY 펄스 → hard cycle(railCycle)×2 → PWRKEY 재펄스` 전부 시도했으나 **모뎀 계속 무응답**. → **물리 전원차단(배터리+USB 완전분리) 10~15s 후 재투입 시 단번에 복구**(09:21 클린부팅 POST200). ⇒ **만성 "아침에 죽어있음"의 정체 = railCycle 2s 로는 SIM7080 VBAT 캡 방전이 안 돼 진짜 전원사이클이 안 되는 것.** → **P5 착수.**
- ✅ **물리 재부팅 후 실주행(09:21~09:35)은 거의 완벽**: POST 200 **45건** 연속, 실패(-1) **2건**(09:23~24 약1분 거친구간=P4 SHCONN not-allowed→**P4 복구가 자동으로 살려냄**, 이후 끝까지 200). POST 간격 median **17s**(설정 15s+전송 정확), **두절 ≥60s 0회**, **deep sleep 0회**(3분창 정상, 주행 중 오수면 없음), 크래시/재부팅 0, esc **bf=0 hr=0 ss=0** 끝까지, GPS sat **11~12**(무안테나인데 양호)·batch 15개 flush, heap 259048 안정.
- 💡 **판정: 주행 중 펌웨어는 매우 건강(3차 대비 안정)·P4 자동복구 실동작 확인. 진짜 문제는 딱 하나 — 콜드 stuck 복구불능(=P5).** esp_restart 는 CPU-only 라 모뎀 VBAT 을 못 끊음 → railCycle 이 유일한 모뎀 리셋 수단인데 그게 "진짜 전원사이클"이 아니었음.

## 🔴 P5 — railCycle 이 "진짜 전원사이클"이 아님 → 콜드 stuck 복구불능 (2026-07-06 착수)  ✅ 구현+플래시, 실효검증 대기
_운행4차 최대 수확. 모뎀 완전 무응답 시 railCycle 2s OFF 로는 SIM7080 VBAT 벌크 캡이 안 빠져 모듈이 power-off 문턱 아래로 안 내려감 → 죽은 stuck 상태 그대로 재부팅 → 무응답 지속. 물리 전원차단 10~15s 만 통함._
- [x] **수정 (config.h `PWR_CYCLE_OFF_MS` 2000→12000)**: railCycle OFF 유지시간을 물리차단급(캡 방전 충분)으로 연장. hardCycle 은 최후수단이라 드물게 발동 → 12s 블로킹 무방(bringup 이미 12~20s 블로킹, WDT 제거됨이라 트립 없음). ON 유지(2000)·PWRKEY 시퀀스 그대로.
- [x] **로그 가시화 (lte.cpp `hardCycle`)**: `[LTE] hard cycle (railOff 12s 방전 + power-on)` — 다음 콜드 stuck 때 실제 방전시간 로그 확인용.
- [x] **15_a_modular(sss) + 15_field_v2(aa) 양쪽 반영**. 컴파일 통과(둘 다 36%). **sss(COM15) 플래시·클린부팅 POST200 검증.**
- [ ] **aa(COM16) 플래시**: 지금 미연결 → 다음 연결 시 15_field_v2 재플래시(필드 만성증상 직결이라 우선).
- [ ] **실효검증**: 다음 콜드 stuck 발생 시 railCycle 12s 가 물리개입 없이 자가복구시키는지(로그에 `railOff 12s 방전` 후 POST200). ⚠️ 콜드 stuck 은 강제재현 어려움(밤샘/장시간 방치 후 간헐) → 필드/장시간 방치 관찰 필요.
- [ ] (백업안, 12s 로도 부족 시) 방전시간 hardResets 에스컬레이션(12→16→20s) or PWRKEY 롱프레스 power-off 선행.

## 🔴🔴 P6 — INT-WDT 크래시  ✅✅ 소프트 근본수정 검증됨: `CONFIG_RTC_CLK_CAL_CYCLES=0`
**★★[2026-07-06 검증 성공] `CONFIG_RTC_CLK_CAL_CYCLES=0`이 INT-WDT(내부 RC osc RTC-cal hang) 근본 제거.** ESP-IDF 5.5.4 from-source 빌드(`idf_caltest`, arduino-as-component)로 실증. **aa 같은단말: baseline(576)=34부팅/4분 INT-WDT crash-loop → CAL=0=INT-WDT 0.** (앞선 "HW라 소프트불가"는 arduino-cli 선컴파일 libs 한계였음.) 배포엔 IDF빌드체계 or 커스텀 libs or 외부크리스탈 필요. 상세·레시피=메모리 [[esp32c3-gps-lte-stuck-status]].
- **[진행중] TASK-WDT loop-hang 조사**: CAL=0 후 노출된 별개 버그(loop()60s hang, P6가 잡음, ~1/4분). 판별=백트레이스 일관성(같은위치=소프트버그/랜덤=HW스톨). coredump 로 위치 확인 중.
_(이하 — 하드웨어 근본 확정까지의 추적 경과, 참고용)_
## (구) INT-WDT — 하드웨어 근본까지의 추적
**★최종(2026-07-06): 크래시=내부 RC 오실레이터 RTC 캘리브레이션 hang→INT-WDT.** coredump ×3 일관(`enable_timer_group0_for_calibration`). **IDF4(2.0.17)·IDF5(3.3.10) 양쪽 다 발생(IDF4 ~4배 덜) = 소프트/코어 버그 아님, HW 레벨.** 부팅+런타임 둘 다(SLEEP_DISABLED 로도 지속), 앱 코드 무관(I2C/CDC/wake 전부 탈락). 자가복구(리부팅)됨. sss·aa 둘 다 battery+USB 동일상태→양쪽 동등. **레버=HW(RC osc/전원 안정성, 개발자 사안). 소프트는 빈도만↓.** 환경 복원 완료(3.3.10/config원복). 상세=메모리 [[esp32c3-gps-lte-stuck-status]].
_(이하 — 추적 경과, 참고용)_
**★[coredump 확정 2026-07-06] INT-WDT = 딥슬립 wake 시 setup 초기(부팅~2초) 시스템/타이머 계층 크래시.** sss 통계 `wake=timer 380 / wake=crash 81`(~17%). coredump(riscv-gdb): loopTask=`setup:99`(delay), 크래시 컨텍스트=systick ISR+`enable_timer_group0_for_calibration`(RTC 캘리, ISR 스택). **앱 코드(motion/gps/lte) 실행 前 → I2C·USB CDC 가설 최종 탈락.** 딥슬립 wake=완전 리셋=setup 재실행 → 운행 모션 wake 마다 크래시 창 재통과(필드 aa 크래시=이 mechanism, USB 불필요). **aa 벤치 "안정"=가만히=wake 안함=크래시 회피(고쳐진 것 아님).** 
- coredump 도구: `esp-coredump`+esptool read(0x3F0000/64KB)+riscv32-esp-elf-gdb(arduino 코어). ELF=헤더24B 스킵.
- 다음: wake-crash coredump 추가 수집→항상 같은 지점/skippable 확정 → 시스템레벨 대응(RTC clk src/코어버전/wake workaround) or wake빈도 감소. ⚠️esp_clk_init(setup 前)이면 RTC-flag setup 스킵 무효.
_(이하 — 앞선 추적 경과, 참고용. I2C/CDC 가설은 위 coredump 로 대체됨)_
## (구) 필드 원인 추적 경과 (2개 이슈 분리 시도 — coredump 로 대체됨)
**★정정(2026-07-06): 필드 INT-WDT 원인 미확정.** 두 개의 별개 이슈:
- **[이슈A — 해결] 옵저브 빌드 blocking-CDC 크래시**: sss(blocking CDC)가 로거 호스트 churn 시 INT-WDT 폭주(12:06~ 3분 18회). **`setTxTimeoutMs(0)` non-blocking 전환→무크래시.** 단 이건 **호스트 연결 시에만** 나는, 상당부분 내 로거가 자초한 버그. sss·aa 양쪽 non-blocking 수렴.
- **[이슈B — OPEN] aa 필드 INT-WDT (07-03~05)**: ★**재현 안 됨.** aa 필드본은 이미 non-blocking CDC + **운용중 USB 한 번도 안 꽂힘(호스트 없음, 동료 비개발자)** → **USB CDC churn 가설 탈락.** 즉 이슈A로 필드를 설명 못 함. 필드 크래시 원인 **여전히 미상.**
  - **유력 후보 = I2C (원 예측 복귀)**: 크래시 시각(07-03 22:46 cascade, 07-04/05 ~18:45)이 **모션-wake 시점 의심**(aa=모션-wake-only, 매 wake setup 재실행=Wire.begin/LIS). deep-sleep 후 I2C 버스 초기상태 wedge→INT-WDT 가설. **현재 aa 는 I2C 견고화본(100kHz+timeout+busRecover) 구동중 → 필드 재투입해 INT-WDT 재발 여부가 검증.**
  - 그 외 후보 미배제: GPS/LTE UART, deep-sleep/wake 경로.
  - churn 단독검증은 **보류**(필드에 호스트 자체가 없었으므로 무의미).
_(이하 추적 경과 — 참고용)_
_동료 "계속 재부팅" 신고 → 서버 events.data 조회. 07-03 18:00 이후 aa=우리 15_field_v2(07-03본). 진짜 실패=INT-WDT 크래시(07-03 3연발 cascade, 07-04·07-05 각 ~4h offline 후 INT-WDT 로만 복구). brownouts=0(전원문제 아님). 오늘 아침 aa "재부팅" 3건은 내 진단행위(USB×2+POWERON)._
- [x] **INT-WDT 를 sss(15_a_modular, USB, blocking CDC)서 벤치 라이브 재현**: `reset=INT-WDT` `rst:0x8(TG1WDT_SYS_RST)` **Saved PC=0x40380060=`_vector_table`**(addr2line) = **인터럽트 컨텍스트 wedge**. 우리 코드 런타임 ISR 없음(모션 폴링) → **페리페럴 드라이버 ISR(I2C Wire·USB CDC·UART) 의심.** 간헐(1회후 12분 안정, 루프 아님).
- [x] **[C3 HW] INT-WDT→RWDT 시스템리셋이 RTC 소실(boots=1)** → 크래시마다 P0 에스컬레이션 카운터+breadcrumb 소실(치명적 함의).
- [x] **[reset_cause 진단]** sleep_mgr `[SLEEP] wake=%s reset=%s` 추가 — USB 재연결 아티팩트 vs 진짜 리셋 구분. 다음 크래시 원인 직접 확인.
- [x] **[P6 안전망] loop task 하드웨어 워치독 (A, 사용자 승인)**: 신규 `loopwdt.h`(lwdt::arm/feed, `_armed` 가드=로그오염 방지). setup 조기 arm(panic=1, timeout 60s), feed=loop-top+sendAT+probeModem+sleep settle. IDF5 API. **양쪽(15_a_modular+15_field_v2) 반영·컴파일 36%·플래시·sss 로그오염 0 검증.** ⚠️ INT-WDT(인터럽트)는 HW 가 이미 리셋 → P6 는 인터럽트-ON main-loop hang 용 별개 보험(07-02 에 no-op 라 제거했던 task-WDT 를 제대로 재무장).
- [x] **[P6-I2C 방어강화 착수 2026-07-06, 유력후보 선손봄]** motion.cpp/config.h 양쪽: ①`Wire.setClock 400kHz→100kHz`(`LIS_I2C_HZ`, 배선 신호무결성 마진 — 모션 폴은 1B/50ms 라 속도 무관) ②`Wire.setTimeOut(50ms)`(버스 hang 시 드라이버 무한대기 차단) ③`busRecover()`(SDA stuck 시 SCL 9펄스 언스틱+STOP) 를 reinit 전에 선행. **컴파일·플래시·`lis_ok:true`(100kHz 정상 인식)·모션 무회귀 확인.** ⏳ **효과(INT-WDT 감소) 검증 = 연장 관측 필요**(INT-WDT 는 sss 기준 ~12분 1회 간헐이라 즉시 증명 불가). sss 를 벤치 상시 로깅하며 크래시 빈도 추적.
- [ ] **★INT-WDT 풀 백트레이스 확보**(I2C 견고화로도 안 잡히면) — coredump-to-flash 활성화(arduino-cli 제약 조사) or sss 재현순간 panic 레지스터덤프 → 범인 ISR(I2C/USB/UART) 확정.
- [ ] (선택) 에스컬레이션 카운터/breadcrumb NVS 백업(INT-WDT RTC 소실 대응).
- [ ] aa(field_v2)는 non-blocking CDC 라 크래시가 시리얼로 드롭 → 진단은 sss(blocking CDC)에서. aa 는 필드검증 유닛.

## 🚗 운행 3차 결과 (2026-07-03 17:54~19:22, sss/USB, OBSERVE_MODE, POST 15s, 88분) — 요약
_수정 반영본(P0~P4·모션HPM=00·정지판정·부저·RTC안테나). sss 외부안테나 없음(aa로 옮김)._
- ✅ **안정성 완벽**: 크래시 0(재부팅 57회 전부 rr=8 딥슬립), 브라운아웃 0(UNDER-VOLTAGE 0), **heap 259048~259376 328B/88분=누수 0**, OVER-VOLTAGE 180=USB아티팩트.
- ✅ **P4/복구 작동**: POST 200 **209건**, hardCycle **1회**뿐, reactivate→pdp=1 다수 → **SHCONN 실패 전부 회복**. 최악 두절 138s·157s 2건 모두 자가복구(영구 stuck 아님). POST 간격 중앙값 25s, ≥60s 4회/≥120s 2회.
- 🎯 **핵심: 주행 중 false-sleep 57회가 SHCONN 폭주(222회)를 증폭**. sleep 사유 60회=`gps=stale drift=0 fixes=0`(GPS부재+모션30s quiet). 3중 원인: ①sss 외부안테나 無→GPS 80% no-fix→이동 교차확인 불가 ②모션 감지되나(MOT max245, 31%>0) 부드러운 주행에 30s+ quiet 구간 ③OBSERVE 30s창이 즉시 sleep. **매 wake 재bringup→SHCONN 재격돌.**
- 💡 **대부분 테스트조건 아티팩트**: sss/OBSERVE/무안테나=최악. 필드본 aa(정지5분창+외부안테나)면 false-sleep 급감→SHCONN 폭주도 급감 예상. **단 사용자 결정: aa 전환 대신 sss 를 발전시켜 aa수준 확보(필요시 안테나 sss 로 이전).**
- **개선 레버**: ①sss 에 외부안테나 부여 or 정지창 확대(→GPS/모션 교차확인) ②모션 THS 재검토(순항 진동 놓침 여지, 단 정차 오검출 위험) ③SHCONN 근본은 sleep 재bringup 감소로 자동완화.

## 🚗 운행 2차 결과 (2026-07-03 09:16~09:32, sss/USB, OBSERVE_MODE, ~16분) — 요약
- ✅ **크래시/브라운아웃 0** (재부팅 6회 전부 reset_reason=8 딥슬립 wake), **데이터 손실 0** (batch 최대 82 → 버퍼 120으로 버팀, 한번에 55 flush), **heap 누수 0** (259048~259392), UNDER-VOLTAGE 0.
- ✅ **P0/P1/P1.5 방어로직 전부 실동작 검증**: 출발 시 bringup stuck(~200s) → 보존된 esc(bf=3) → railCycle → POST 200 자가복구. P1 "60s 무응답(REG=5) → data 재활성" 2회, P1.5 "SHCONN fail → reactivate" 2회 정상.
- 🔴 **THE 두절 = `SHCONN operation not allowed` 만연** (거의 매 사이클). REG=5·CSQ 정상인데 데이터소켓만 거부 → **DB "통신 두절"의 정체**. POST 200 간격(=두절)이 최대 **121초**, 그 외 56~92초 다수. → **P4 로 근본수정 착수.**
- 🟠 **증폭요인**: OBSERVE_MODE 30s 정지판정 + 8s timer wake + 모션 under-count + drift=0(창 30s에 fix 0~1개라 계산불가) → **주행 중인데 6번중 4번 timer sleep→wake**, 매 wake 재bringup+SHCONN 재격돌. 필드 aa본(timer wake OFF·5분창·모션전용)에선 완화되나 SHCONN 자체는 여전.

## 🔴 P0 — 유력 root cause  ✅ 구현+정상회귀 검증 완료 (2026-07-02)
_escalation-across-sleep 실동작은 실패주입/운행 시 최종 확인._

- [x] **recovery 에스컬레이션 카운터 deep sleep 리셋 버그**
  - 수정: `bringFails_/hardResets_/softStreak_` 를 `RTC_DATA_ATTR` 승격 (deep sleep/crash 보존, POWERON 만 0, 성공 시 코드가 명시 리셋). 타임스탬프(lastSuccessMs/stuckSinceMs)는 millis 기반이라 재부팅 무의미 → 세션 로컬 유지.
  - 검증: 정상 online 사이클서 esc 오발동 0, sleep 정상.

- [x] **LTE 미등록/recovery 중엔 stationary sleep 보류**
  - 수정: checkStationary 에 가드 — `!lte::ready()` 이고 마지막성공(없으면 부팅)후 경과 < `RECOVERY_STAY_AWAKE_MS`(운영5분/test90s) 면 sleep 보류(깨어서 재시도). 초과 시 배터리 보호 sleep 허용 → 다음 wake 는 RTC 카운터로 에스컬레이션 이어감.
  - 검증: online 시 sleep 정상 진입(가드 미적용) 확인. not-ready 시 깨어있기는 실패주입서 확인 예정.

## 🟠 P1 — 관찰된 stuck 메커니즘  ✅ 구현+정상회귀 검증 (2026-07-02, 실동작은 운행/실패주입 확인)

- [x] **"reg=5 but conn=0"** — 진단: 60s 무응답 시 곧바로 CFUN softReset = 등록 멀쩡한데 통째로 날리는 과대응.
  - 수정: recovery ONLINE stuck watchdog 을 **REG 분기**로. `lte::refresh()` 후 REG OK(1/5) 면 `lte::reactivateData()`(SHDISC+CNACT 재활성, **CFUN 안 함**) ×`DATA_RETRY_LIMIT`(2) 먼저 → 그래도/REG상실이면 softReset → hardCycle → (5분)restart. dataStreak_ RTC 카운터, 성공/bringup 시 리셋.
- [x] **softReset 후 REG=0 재등록 stuck** — 수정: `softReset()` 에 `AT+COPS=0`(자동 operator 재선택/재스캔) 추가로 재등록 촉진.
  - 남은 조사(운행 시): reactivate/COPS 가 실제로 회복 앞당기는지, 안 되면 hardCycle 더 빨리 갈지.

## 🔴 P3 — bringup PWRKEY 토글 레이스  ✅ 구현+벤치검증 완료 (2026-07-03)
- 📌 **모뎀 half-alive / AT-dead stuck**: power-on 후 모뎀이 `+CPIN: READY`/`SMS Ready`(콜드부트 URC)를 뿜는데도 우리 `AT` 폴링엔 무응답. bringup 이 AT-timeout 만 보고 **모뎀이 막 부팅완료된 그 순간 `pulse PWRKEY`** → SIM7080 켜진 상태 PWRKEY 는 **전원 토글(종료 유발)** → 부팅↔종료 엇갈리는 레이스로 ~200s stuck.
  - 실측 타임라인: `>> AT`(23s)→`<< timeout`(24s)→**`+CPIN: READY`(24s, 모뎀 방금 준비됨)**→`[LTE] pulse PWRKEY`(24s, 하필 이때 토글)→반복.
  - **회복 경로 확인**: P0 로 보존된 esc(bf=3) → `hardCycle(railCycle)` 에스컬레이션 → 모뎀 clean 재부팅 → 등록/PDP → **POST 200** (09:18:41). **railCycle 이 half-alive/AT-dead 유효 복구책**임을 확인. **P0 없었으면 railCycle 못 가서 영구 stuck.**
  - [x] **수정 (lte.cpp `powerOn`)**: `probeModem(maxWaitMs)` 도입 — AT 를 0.8s 간격 **반복 핑**하며 관찰. MP_READY(AT OK)/MP_BOOTING(URC·바이트만)/MP_SILENT(무바이트) 3판정. **생명신호 있으면 PWRKEY 절대 금지**(URC/바이트=살아있음), 부팅완료(AT OK, 상한 LTE_BOOT_WAIT_MS=12s) 대기. **MP_SILENT(전원 off 추정)일 때만 PWRKEY 1회.** 두 번 펄스 금지. 부팅중 끝내 AT 안 붙으면 펄스 대신 반환 → recovery railCycle 이 정리. config.h `LTE_BOOT_PROBE_MS 3000` / `LTE_BOOT_WAIT_MS 12000` 추가.
  - [x] **벤치검증 (2026-07-03 09:53~)**: power-on-reset + 딥슬립 wake(콜드부트) 경로 모두 `already on` 안전판정 → **`pulse PWRKEY` 0회, 에스컬레이션 0회, POST200 매 사이클(부팅~POST ~10-12s)**. 예전 단발 AT 시도가 부팅창 놓쳐 오펄스하던 걸 반복핑이 제거. 회귀 없음.
  - [ ] **운행/실동작 확인**: half-alive(~200s) 재발 시 오실레이션 없이 railCycle 로 빠르게 정리되는지(벤치선 half-alive 강제 어려움).

## 🔴 P4 — SHCONN "operation not allowed" 근본수정 (2026-07-03 착수)  ⏳ 구현 완료, 검증 대기
_운행 2차의 지배적 두절. 진단: handover 로 CNACT 베어러가 조용히 죽는데 확인 없이 SHCONN 을 쏨 → 죽은 베어러 위 SHCONN 은 무조건 "operation not allowed". 재연결(SHSTATE=0) 경로도 SHDISC 없이 SHCONN → 잔류 세션으로 not-allowed._
- [x] **`bearerActive()`** 추가 — `AT+CNACT?` 파싱해 베어러 실활성(0,1,<non-zero ip>) 확인.
- [x] **`connectHttp()`** 로 SHCONN 견고화: ①베어러 확인(죽었으면 즉시 reactivateData) ②SHCONF 보장 ③매 연결 전 SHDISC(잔류 세션 정리) ④SHCONN. 실패 시 fresh 베어러로 **같은 호출 내 1회 재시도**(30s watchdog 대기 없이 두절 단축). 2회 실패면 return false(batch 무손실, 다음 사이클).
- [x] `httpPost` 리팩터 — config/connect 를 헬퍼로 분리, keepalive(SHSTATE) 유지.
- [x] 컴파일 통과 (36% flash). sss(COM15) 플래시 완료.
- [x] **벤치 회귀검증 통과** (2026-07-03 09:45): 벤치에서 SHCONN not-allowed 재현됨 → connectHttp(CNACT? 확인→SHDISC→SHCONN) 로 ~1s 내 POST 200 도달, 이후 keepalive 안정. 회귀 없음(heap/전압 정상). ※ SHDISC 가 세션 없을 때 not-allowed 반환은 무해(예상).
- [ ] **운행 3차 실효검증**: SHCONN not-allowed 시 두절이 실제로 짧아지는지(베어러 선확인+즉시 재시도 효과). ⚠️ 벤치(안정 베어러)에선 not-allowed 재현 안 될 수 있음 → 실주행 필요.

## 🚗 운행 1차 결과 (2026-07-02 18:31~18:50, sss/USB, SLEEP_DISABLED, ~20분)
- ✅ **크래시/재부팅 0**, REG=5 전구간 유지, CSQ 9~31(99 없음), GPS sat≤12 fix 지속, POST 200 34건, heap 안정.
- 📌 **진짜 두절 포착 = SIM7080 `AT+SHCONN → +CME ERROR: operation not allowed`** (REG=5·CSQ30 정상인데 데이터소켓 거부, ~87s). SHDISC 만으론 안 풀리고 **CNACT(PDP) 재활성** 필요. batch 88까지 폭증했으나 버퍼(120)로 **무손실**, 자체 회복.
- ⚠️ **과전압은 USB 아티팩트**: OVER-VOLTAGE 90회(readings 100%>4700mV)인데 SHCONN 실패는 1회 → **트리거 아님**. sss USB(~4.85V)가 모뎀 VBAT 과전압. **배터리 aa(~4.0V)엔 없음.** → **진짜 필드 두절은 배터리(aa)로 관찰해야 신뢰** (USB는 과전압+brownout/CDC 모드 가림).

## ✅ P1.5 — SHCONN "operation not allowed" 회복 (2026-07-02, bench 회귀검증)
- [x] `httpPost` SHCONN 실패 시 **즉시 `reactivateData()`(CNACT 재활성)** → 다음 POST 가 fresh 베어러로 재시도(60s watchdog 대기 단축). data 무손실은 batch 버퍼.
  - 실동작(operation not allowed 재발 시 회복 단축)은 배터리 운행서 확인 예정.
- [x] **telemetry `cbc_mv` 추가** — AT+CBC(모뎀 VBAT, 3-field "bcs,bcl,mV"). ESP divider(vbat_mv) 교차검증. refresh(10s)서 조회, expect="OK"(값 도착 전 매칭 race 회피). sss 실측 4867 vs ESP 4826 근접.

## 🟡 P2 — 이관/튜닝/정리

- [x] **🎯 자이로(LIS3DH) 모션 카운터 under-count — 근본원인 규명+수정+벤치검증 완료 (2026-07-03)**
  - **진짜 원인**: `CTRL_REG2=0xC1`(HPF **HPM=11 autoreset**)가 인터럽트 데이터 경로 전체를 **freeze** — INT1_SRC(src=0x15 고정)·OUT 레지스터·INT1 핀 전부 갱신 정지. 흔들어도 high-event 안 뜨고 IA=0/pin=1 → events 0~3 굶음. (문턱 문제가 **아니었음**. THS 낮춰도 0. 원본 13_4_aa 동일 config = 만성 under-count 근본원인.)
  - **수정 (motion.cpp)**: CTRL_REG2 `0xC1→0x01`(HPF **HPM=00 normal**, REFERENCE 로 중력제거, autoreset 제거). + THS `0x08→0x04`(64mg), DUR `0x06→0x02`(40ms), 카운트/freshness 를 IA 뿐 아니라 순간 high-event(`LIS_HI_EVT_MASK 0x2A`)로도 갱신.
  - **검증(벤치)**: 정지 MOT=0(오검출 0, src=0x15) / 살짝 흔들기 16s → **MOT +65**(기존 수분간 0~3). IA=1·pin=0 어서트 확인. deep-sleep wake(INT1 핀 직결) 무영향·오히려 개선. 운영빌드(진단 off/sleep on) POST200·pulse 0 정상.
  - **특성화(HPF off 실측 mg)**: 정지노이즈~35 / 살짝~50-114 / 중간~346 / 세게~411.
  - **진단도구**: `MOTION_RAW_DEBUG`(config, 운영 0) — 1이면 INT1_SRC/핀 또는 (HPF off 시)OUT 원시 mg 로깅.
  - [ ] 운행 3차서 주행 진동이 실제로 카운트되는지(정지 오판 사라지는지) 최종 확인.
- [x] **정지판정 fix-부족 오탐 방지 — 수정+벤치검증 완료 (2026-07-03)**
  - **버그**: `if (n>=3 && drift>th) reset` — window 내 fix<3 이면 이동체크가 거짓이라 이동 중에도 정지로 흘러감(gpsAvail=true인데 저계수 fix).
  - **수정 (sleep_mgr.cpp)**: `gpsConfident = gpsAvail && n>=STATIONARY_MIN_FIXES(3)` 일 때만 drift 로 판정. 부족(fix<3 또는 stale)이면 GPS 무근거로 보고 **모션 quiet 지속(NO_GPS_SLEEP_GRACE)만으로 판단**. sleep reason/telemetry 도 gpsConfident 반영(라벨 confident/weak-fix/stale). config `STATIONARY_MIN_FIXES 3`.
  - **이중 안전**: 모션 카운터 수정(HPM=00) 후 주행이면 상위 `motion::quiet` 체크서 이미 리셋 → GPS 근거 없이는 성급히 sleep 안 함.
  - **검증**: 벤치(실내 fixes=0) 정상 정지 시 여전히 `stationary_lis_only` 로 sleep(회귀 없음), 라벨 정상. 실효(주행 저계수 fix 오탐 제거)는 운행 3차 확인.
- [x] **부저 정책 결정 (2026-07-03)**: 능동 부저 확정·LTE POST 무해 재확인 → **ON 유지**. 사용자 결정으로 **sss 모션 wake 2→6회로 aa 필드본과 통일**(`WAKE_BEEP_COUNT 6`). **+ sleep 진입 2비프 신규 추가**(sleep_mgr enterDeepSleep, wake 6과 구분). 비프맵: cold boot 긴1 / **sleep 진입 2** / 모션wake 6 / 첫fix 3 / 첫POST 4 / 서버cmd 5. (timer wake 무음.)
  - **버그 아님 확인**: sss 에서 wake/sleep 부저 안 들린 건 OBSERVE 8s timer 가 디바이스를 거의 항상 awake 로 유지 → 흔들어도 wake 이벤트 없음. 5분 timer 로 재우고 흔드니 로그 `wake=motion` + 6비프 실동작 확정. (검증용 5분 timer 는 8s 로 원복.)
- [x] **last_op breadcrumb 지점 보강 (2026-07-03)**: setup `mot_init`/`gps_init` + POST 하위 `lte_shconn`(오전 stuck 지점)/`lte_shbod`/`lte_shreq` 추가 → 크래시/행 위치를 POST 세부단계까지 특정(RTC 보존→다음 부팅 telemetry).
- [x] **임시 테스트 스케치 = 기록용 보존** (삭제 X): `zz_buzzer_test`(GPIO1 LOW/FLOAT/HIGH 격리), `zz_buzzer_sleep_test`(gpio_hold 래치 실증). 능동 부저 진단 근거.
- [x] **GPS 안테나 OPEN 규명** → **`GPS_ANTENNA.md`** 참조. 모듈=L86-M33(내장 패치+외부 액티브 지원). 원시 `$GPTXT,01,01,02,ANTSTATUS=OPEN` = DC 전류 미검출(패시브 or 바이어스 미급전). fix 는 내장 패치로 추정. **소프트웨어 불가 = HW bias-tee 사안** (증명법: 안테나 커넥터 중심핀 DC=0V). 
  - [ ] HW 개발자 멀티미터 측정 결과 대기 (중심핀 DC 전압). / gps.cpp `[GPS raw-ant]` 진단 로깅 in-code (안테나 확정 후 제거 결정).
  - [ ] (선택) telemetry antenna 라벨 "OPEN"→"no-current" 정리.

## 🟢 운영 flash 전 원복 (체크리스트)

- [ ] `config.h`: `OBSERVE_MODE 0`, `SLEEP_TEST 0`, `MOTION_RAW_DEBUG 0`, `SLEEP_DISABLED 0`, `BUZZER_ENABLED 1`(ON 결정). `WAKE_BEEP_COUNT 6`.
- [ ] FQBN: `esp32:esp32:esp32c3` (CDCOnBoot=**default**) — 배터리 운영
- [ ] STATIONARY_WINDOW 등 운영값 확인 (5분/10분 timer)

## 🔵 추후 라운드 (운행 시 재개)

- [~] **운행 중 pre-LTE stuck 관찰**: **`drive_logger.py`** (Python 상시 로거 — auto-reconnect, 호스트 타임스탬프, UTF-8, 라인 flush. `python drive_logger.py COM15 115200`). **1차(sss/USB, 20분)·2차(sss/USB, 16분) 완료 → SHCONN operation not allowed 두절 만연 포착(최대 121s), 크래시 0. → P4 착수.** 
  - [ ] **운행 3차 = P4 실효검증** (sss/USB): SHCONN not-allowed 시 두절이 실제로 짧아지는지. 벤치는 안정 베어러라 handover-베어러사망 케이스 미재현 → 실주행 필수.
  - [ ] **배터리 aa로 운행** (USB 과전압/brownout/CDC 가림 없이). 지하주차장 통과·시동·30분 지속으로 진짜 필드 두절/crash 재현 + breadcrumb.
  - ⚠️ 랩탑 USB급전+CDC모니터는 배터리 brownout·CDC 블로킹 실패모드 가림 → 신호/bringup/로직/crash 계열만.
- [x] **aa 필드본 재스냅샷 완료 (2026-07-03) → `arduino/15_field_v2`**: 최신 15_a_modular(P0/P1/P1.5/CBC/P3/P4 + 모션 HPM=00 + 정지판정 + breadcrumb + 부저맵 boot1/sleep2/wake6/fix3/post4/srv5)을 FIELD 설정으로 스냅샷. 필드 diff: `OBSERVE_MODE 0`(정지5분→sleep), `TIMER_WAKE_ENABLED 0`(모션 wake only, sleep_mgr 게이트), `Serial.setTxTimeoutMs(0)`(non-blocking CDC). FQBN `esp32:esp32:esp32c3:CDCOnBoot=cdc`. **aa(COM16) 플래시·검증: 부팅·LIS OK·GPS 9600 통신·`antenna=OK`(LED수리 반영)·LTE bringup 정상.** (구 15_field_v1 는 기록 보존.)
- [ ] **recovery 실패주입 정식 검증**: A=LTE 안테나 뽑기 / B=나쁜 호스트 빌드 (P0 수정 후 escalation 정상 진행 확인).
- [ ] 사무실 정지 상태 장시간 방치 → 간헐 크래시 재현 (breadcrumb 로 위치). walk 5분엔 크래시 0건.

## ✅ 완료 (참고)
Block 1~8 모듈 리팩터, WDT no-op 제거, 복구 7경로→단일 state machine, keepalive, telemetry 원본수준 확장(+diag/stationary/last_op), sleep_enter POST, 부저 stretched-beep 수정(flush)+gpio_hold, 신호복귀 자동회복+batch 무손실 검증.
