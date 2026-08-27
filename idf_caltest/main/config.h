// =================================================================
// config.h — 전 핀 / 파라미터 / 빌드 플래그 단일 소스.
//   13_4_aa 리팩터 (2026-07-02). 모듈들은 오직 이 파일의 상수만 참조.
//   블록 이관이 진행되며 섹션이 추가됨 (Block 1: core + buzzer).
// =================================================================
#pragma once
#include <Arduino.h>

// ── 빌드 플래그 ───────────────────────────────────────────────────
//  · 모니터링 세션: FQBN esp32:esp32:esp32c3:CDCOnBoot=cdc + BUZZER_ENABLED 1
//  · 운영(배터리):  FQBN esp32:esp32:esp32c3 (CDCOnBoot=default) + BUZZER_ENABLED 0
#define BUZZER_ENABLED 1   // (2026-07-02) 능동 부저 활성. LTE POST 무해 재확인(2026-07-03). 운영/필드 ON 유지 결정.
// ⚠️[2026-08-14] 위 "무해 재확인"은 구보드 기준. 마그네틱 부저(GPIO1 직결)의 LTE 간섭은 진단 이력상
//   신PCB 에서 deterministic 이었고 firmware 로 차단 불가(플라이백 다이오드 = hardware fix 필수).
//   신PCB 양산분에 플라이백 반영이 확인되기 전까지는 신PCB 유닛에 BUZZER_ENABLED 0 권장.
#define WAKE_BEEP_COUNT 6  // (2026-07-03 사용자 결정) 모션 wake 시 부저 횟수 — aa 필드본과 통일(6회).

// ── 핀 (신 PCB rev, 2026-06-17~) ─────────────────────────────────
#define PIN_SDA        8
#define PIN_SCL        9
#define PIN_PWR_EN     6      // GPS + LTE 공유 전원 (분리 제어 불가 — hw_power 모듈이 격리)
#define PIN_PWRKEY     10     // [2026-07-30 신PCB 표준] PWRKEY=GPIO10 (NPN 베이스, HIGH=눌림). ※구배선=7 (PWRKEY↔DTR 스왑됨)
#define PIN_DTR        7      // [2026-07-30 신PCB 표준] DTR=GPIO7 (LOW=모듈 wake). ※구배선=10
#define PIN_BAT        3
#define PIN_LIS_INT    5
#define PIN_GPS_RX     20
#define PIN_GPS_TX     21
#define PIN_LTE_RX     2     // 신모듈 native [운영 수렴 기준: 신PCB + 신모뎀]. (구모듈 유닛은 4)
#define PIN_LTE_TX     4     // 신모듈 native.                                  (구모듈 유닛은 2)
#define PIN_BUZZER     1     // 액티브(마그네틱) 부저 — digitalWrite HIGH=on

// ── LTE 극성 (aa fork — 03_4 진단 확정값) ────────────────────────
// ★[2026-07-30 신PCB 표준 — HW팀 검증 스케치 반영] PWRKEY=GPIO10(NPN), DTR=GPIO7.
//   PWRKEY: NPN 베이스 구동이라 idle=LOW(release) / pulse=HIGH(눌림). 구배선(idle HIGH/pulse LOW)과 반대.
//   DTR: LOW=모듈 wake(sleep 방지). AT+CSCLK=0 로도 슬립 끄므로 극성 영향 최소.
#define LTE_DTR_IDLE      LOW    // 신PCB 표준: DTR=GPIO7, LOW=wake
#define LTE_PWRKEY_IDLE   LOW    // 신PCB 표준: NPN idle=LOW(release)
#define LTE_PWRKEY_PULSE  HIGH   // 신PCB 표준: NPN pulse=HIGH(press) — 부팅 펄스 시 HIGH 유지

// ── Baud / 네트워크 ──────────────────────────────────────────────
#define GPS_BAUD       9600         // aa LC86G default — "9600 유지 절대 원칙"
#define LTE_BAUD       115200
#define LTE_RX_BUF     1024         // HW팀 기대값(표준): UART RX 링버퍼 256→1024 (오버플로우 여유)
#define APN_NAME       "iot.1nce.net"
#define POST_URL_HOST  "http://gps.serial.kr"
#define POST_PATH      "/ingest"

// ── 배터리 ───────────────────────────────────────────────────────
#define BAT_DIV_RATIO     2.0f
#define LOW_BATT_BEEP_MV  3500

// ── 전원 레일 (hw_power) 타이밍 ───────────────────────────────────
//  PWR_EN LOW=ON / HIGH=OFF. GPS(L86)+LTE(SIM7080) 공유 — 분리 제어 불가.
#define PWR_INRUSH_SETTLE_MS  300    // railOn 후 GPS inrush 안정 대기 (그 후 LTE PWRKEY 시점 분리)
// ★[운행4차 2026-07-06] railCycle OFF 2s→12s. 모뎀 완전 무응답(콜드 stuck) 시 2s 차단으론
//   SIM7080 VBAT 캡이 안 빠져 "진짜 전원 사이클"이 안 됨 → railCycle 2회+PWRKEY 로도 복구 실패,
//   물리 전원차단 10~15s 만에 복구됨(실증). 그 물리차단급 방전시간을 railCycle 에 부여.
//   (hardCycle 은 최후수단이라 드물게 발동 → 12s 블로킹 무방. bringup 이미 12~20s 블로킹.)
#define PWR_CYCLE_OFF_MS      12000  // railCycle: OFF 유지 (VBAT 캡 방전 — 콜드 stuck 해제엔 물리차단급 필요)
#define PWR_CYCLE_ON_MS       2000   // railCycle: ON 후 안정
#define PWRKEY_PULSE_MS       1500   // PWRKEY 펄스 폭 (SIM7080 전원 토글)
#define PWRKEY_PRE_MS         100    // 펄스 전 idle 유지

// ── GPS (gps 모듈) ───────────────────────────────────────────────
#define GPS_HISTORY_N   16     // drift 판정용 fix ring buffer. ※16×10s push = 실효 lookback 160s —
                               //   recentDrift 에 5분 window 를 넘겨도 실제로는 최근 160s 만 평가됨.
                               //   (의도적 유지: ring 확대 시 정지→sleep 수렴이 그만큼 늦어짐)
#define BATCH_BUF_N     120    // POST 사이 fix 누적 (retry 시 손실 방지). RAM ~1.4KB.
#define GPS_INIT_SETTLE_MS  1500   // LC86G 부팅 안정화 후 PAIR 명령
// fix freshness — sticky-fix 방어 (age + sat + hdop 로 stale 좌표 거름)
#define GPS_FIX_MAX_AGE_MS  10000
#define GPS_FIX_MIN_SAT     3
#define GPS_FIX_MAX_HDOP    500    // 5.00 (hdop.value() 단위 = 1/100)
#define GPS_BATCH_MIN_SAT   4      // batch 에 넣을 fresh fix 기준
#define GPS_BATCH_MAX_AGE_MS 5000
#define GPS_BATCH_DEDUP_MS  1000   // 같은 fix 1s 이내 중복 배제
#define GPS_HIST_PUSH_MS    10000  // drift history push 주기
#define ANT_REQUERY_MS      30000UL // [2026-07-14] 안테나 ANTSTATUS 주기 재쿼리(30s) — L86은 부팅시 1회만 emit → live 탈착 감지용

// ── LTE (lte 모듈) 타이밍 ────────────────────────────────────────
#define LTE_REG_WAIT_MS       90000UL   // 등록(CEREG 1/5) 대기 상한
#define LTE_CNACT_TIMEOUT_MS  20000UL   // PDP(CNACT) 활성 대기
#define LTE_BRINGUP_RETRY_MS  30000UL   // bringup 재시도 간격 (Block 5 임시 — Block 7 recovery 가 대체)
#define REG_POLL_FAST_MS      2000UL    // (2026-07-08 non-blocking bringUp) 등록대기 중 CEREG 폴 간격
#define POST_INTERVAL_DEFAULT_MS  15000UL   // (2026-07-03 운행3차: 30s→15s, 부담체크) POST 주기 (서버 cmd 로 5~300s 조정, RAM only)
#define POST_INTERVAL_MIN_S       5
#define POST_INTERVAL_MAX_S       300
#define SHBODY_MAXWAIT_MS         10000     // SHBOD body 전송 후 OK 대기
#define SHREQ_TIMEOUT_MS          10000     // SHREQ POST 응답 대기
#define SHCONN_TIMEOUT_MS         10000     // SHCONN 연결 대기
// (P3 2026-07-03) 모뎀 부팅 탐지 — powerOn 이 PWRKEY 펄스 전 "이미 켜짐/부팅중" 판별용.
//   생명신호(부팅 URC/AT OK/바이트) 있으면 펄스 금지(켜진 SIM7080 PWRKEY 펄스=전원토글=종료 → 부팅↔종료 레이스).
#define LTE_BOOT_PROBE_MS         3000      // 초기 생명신호 탐지 창 (짧게)
#define LTE_BOOT_WAIT_MS          12000     // 부팅 완료(AT OK)까지 대기 상한 (SIM7080 cold boot ~5-8s)

// ── recovery (복구 state machine, Block 7) ───────────────────────
//  원본 복구 경로 1·3·4·5·6 을 단일 결정기로 통합 (매 tick 단일 액션).
#define STUCK_POST_TIMEOUT_MS     60000UL           // 마지막 성공 POST 후 무응답 → soft
#define STUCK_RESTART_TIMEOUT_MS  (30UL*60*1000UL)   // [필드본] 30분 완화 (운영 5분 → 30분). 잦은 재부팅루프 제거+안전망 유지.
#define BOOT_STUCK_RESTART_MS     (30UL*60*1000UL)   // [필드본] 부팅후 무POST 재시작 30분 완화 (운영 5분 → 30분)
#define BRINGUP_FAIL_HARD         3                 // 연속 bringup 실패 → hardCycle
#define HARD_RESET_LIMIT          10                // [필드본] hardCycle→esp_restart 상한 완화 (운영 2 → 10). 30분 시간상한이 주로 작동.
#define HARDCYCLE_MIN_INTERVAL_MS (2UL*60*1000UL)   // (③ 2026-07-08) hardCycle 최소간격 2분 — 인러시 반복 억제(무신호 지역 브라운아웃 방지)
#define SOFT_TO_HARD_STREAK       2                 // soft 반복 → hardCycle
#define DATA_RETRY_LIMIT          2                 // (P1) REG OK 인데 POST 실패 시 CFUN 전에 data-plane 재활성 횟수
#define REG_POLL_MS               10000UL           // REG 모니터 주기
#define REG_LOST_MS               30000UL           // REG 상실 지속 → soft

// ── loop task 하드웨어 워치독 (P6, 2026-07-06) ──────────────────
//  loop()이 라이브러리/HW 경로에서 멈추면(07-04/05 수시간 offline) 잡는 안전망.
//  정상 블로킹(bringup/httpPost)은 sendAT/probeModem/loop-top/sleep 진입 feed 로 커버 → 오탐 없음.
//  timeout 은 feed 안 되는 최장 구간(railCycle 12s 등) + 여유. 초과 = 진짜 hang → panic reset → recovery.
#define LOOP_WDT_ENABLED          1
#define LOOP_WDT_TIMEOUT_MS       60000UL           // 60s 무진전 → panic reset (기존 "수시간 방치" 종결)

// ── sleep_mgr (Block 8) ──────────────────────────────────────────
#define SLEEP_DISABLED             0                  // [sss 안정형 운영본] 절전 ON (모션-aware). 진단본=1(절전OFF).
#define SLEEP_TEST                 0                  // 1=벤치 sleep/wake 검증용 단축값 (운영 전 0 원복!)
#define OBSERVE_MODE               0                  // 관찰본(sss)=1(3분창/로그유지), 운영본(aa)=0(운영 5분창). [2026-07-08 aa 최종본=0]
// (2026-07-08) HW-DIAG 크래시 디버그 게이트 — CRASHES 카운터(NVS)+배너+긴삐3회 크래시부저+클린전원부저.
//   관찰/디버그본=1, 최종 운영본=0(제거 → 앱 정상 부저 마일스톤 동작). ★최종본 = HWDIAG_ENABLED 0 + OBSERVE_MODE 0
#define HWDIAG_ENABLED             0                  // [sss 안정형 운영본] 크래시카운터/배너/부저 OFF → 앱 정상 부저 마일스톤 동작. 진단본=1.
#define GPS_STALE_MS               60000UL            // 이보다 오래된 fix = GPS unavailable
#define STATIONARY_MIN_FIXES       3                  // (P2 2026-07-03) 정지 확신에 필요한 window 내 최소 fix 수. 미만이면 GPS 무근거로 보고 모션 quiet 로만 판단(저계수 fix 오탐 방지).
#if SLEEP_TEST
  #define STATIONARY_WINDOW_MS      30000UL           // (벤치 test) 30s
  #define STATIONARY_BOOT_GRACE_MS  15000UL           // (벤치 test) 15s
  #define GPS_DRIFT_THRESHOLD_M     1000.0f           // (벤치 test) 실내 GPS 노이즈가 window 리셋 안 하게
  #define NO_GPS_SLEEP_GRACE_MS     20000UL           // (벤치 test) GPS 없어도 20s quiet 면 sleep
#elif OBSERVE_MODE
  // (2026-07-03 운행3차 후) sss 필드-유사 관찰 프로파일 — 주행 중 false-sleep 방지.
  //   운행3차: OBSERVE 30s창이 GPS부재+모션30s-quiet 에 즉시 sleep→매 wake SHCONN 폭주. → 필드급 타이밍으로.
  #define STATIONARY_WINDOW_MS      (3UL*60*1000UL)   // 정지 3분 지속돼야 sleep (주행/신호대기엔 안 잠)
  #define STATIONARY_BOOT_GRACE_MS  30000UL           // 부팅 직후 30s 정지판정 보류
  #define GPS_DRIFT_THRESHOLD_M     50.0f             // 실주행 drift 감지(이동이면 window 리셋)
  #define NO_GPS_SLEEP_GRACE_MS     (3UL*60*1000UL)   // GPS 없어도 모션 3분 quiet 이어야 sleep
#else
  #define STATIONARY_WINDOW_MS      (5UL*60*1000UL)   // 정지 유지 → deep sleep
  #define STATIONARY_BOOT_GRACE_MS  60000UL           // 부팅 직후 정지판정 보류
  #define GPS_DRIFT_THRESHOLD_M     50.0f             // 정지 판정 drift 임계
  #define NO_GPS_SLEEP_GRACE_MS     (10UL*60*1000UL)  // GPS 없을 때 LIS 단독 sleep 유예
#endif
// ★[관찰 토글] timer heartbeat wake 활성. 0 = 모션 wake only(주기적 wake 없음, 증상관찰용). SLEEP_DISABLED 과 같은 맥락.
#define TIMER_WAKE_ENABLED         1                  // [2026-08-14 운영 복원] 10분 timer HB 재활성 — sleep 중
                                                      //   LIS 고장/장기 무모션 시 유일한 안전망 + 주차중 dark 방지.
                                                      //   (0 은 sss 증상관찰 전용이었음 — 운영본에 남아있던 것 정정)
#if OBSERVE_MODE
  #define TIMER_WAKE_INTERVAL_US   (5ULL*60*1000000ULL)   // (운행3차 후) sleep 시 5분 fallback wake(dark 방지·로거 재접속). was 8s(thrash 원인).
#else
  #define TIMER_WAKE_INTERVAL_US   (10ULL*60*1000000ULL)  // 운영: deep sleep 10분 timer wake
#endif
#define TIMER_WAKE_MAX_MS          120000UL           // timer-wake heartbeat 2분 guard
// (P0 2026-07-02) LTE 미등록/recovery 중 stationary sleep 보류 상한.
//   이 시간 내에는 깨어서 bringup 재시도+에스컬레이션 지속(정지 stuck 회피).
//   초과 시엔 배터리 보호 위해 sleep 허용 (이후 wake 는 RTC 카운터로 에스컬레이션 이어감).
#if OBSERVE_MODE || SLEEP_TEST
  #define RECOVERY_STAY_AWAKE_MS   90000UL            // (test) 90s
#else
  #define RECOVERY_STAY_AWAKE_MS   (5UL*60*1000UL)    // 운영 5분
#endif
#define WAKE_BOUNCE_OBSERVE_MS     1000UL             // 모션 wake 후 관찰창
// [2026-08-14 bounce 개편] 구 판정(INT LOW 비율>0.55=지속진동→re-sleep) 폐기 — 지속 진동은 실주행일 수
//   있어, re-sleep 하면 즉시 모션 wake 가 다시 걸려 sleep↔wake churn(레일 인러시 반복·추적 지연) 위험.
//   신 판정 = "외로운 범프만 re-sleep": 관찰창 동안 INT 재어서트 없음 + raw |Δ| 최대 < ACTIVITY_THS
//   둘 다 만족할 때만 re-sleep. 그 외(주행/애매)는 정상 기동해 추적.
#define WAKE_BOUNCE_MAX_STREAK     3                  // 연속 bounce re-sleep 상한 — 초과 시 1회 정상 기동(오판 escape)
#define SLEEP_PRE_SETTLE_MAX_MS    3000UL             // sleep 진입 前 INT settle 게이트(연속 HIGH 300ms). 실패=진동중=진입 취소

// ── Motion (LIS3DH, motion 모듈) ─────────────────────────────────
#define LIS_MOT_THS            0x08    // 128mg [2026-07-14 사용자: wake 민감도 2배 둔화 64→128mg] — 살짝(50-114mg) 무시, 중간(346)/세게(411)만 wake. (INT1_THS ±2g 16mg/LSb × 8)
#define LIS_MOT_DUR            0x02    // 40ms @50Hz (120→40ms: 주행 범프 놓침 방지. 高이벤트 비트 병용)
#define MOTION_RAW_DEBUG       0       // (P2 진단) 1=인터럽트 경로(INT1_SRC/핀) 로깅. 검증/운영은 0.
#define LIS_EDGE_FILTER_MS     100     // ISR 디바운스
#define MOTION_QUIET_MS        30000UL // 이 시간 이벤트 0 = "조용함" (구 방식, activity 로 대체)
// (2026-07-08) 모션 "활동량(activity)" — 지속 진동(주행/터널) vs 단발 노이즈(정지 실내) 분리.
//   raw 자력 |Δ| 의 EMA(mg). 정지노이즈~35mg / 살짝~50-114 / 주행 지속. 임계 위=움직임=sleep 금지.
#define ACTIVITY_SAMPLE_MS      100    // raw 샘플 주기(10Hz)
#define MOTION_ACTIVITY_THS_MG  40     // 이 이상 EMA = 움직임(주행/터널). 정지노이즈 위. ★필드 튜닝 대상
#define LIS_HEALTH_POLL_MS     50      // INT1_SRC 헬스 폴 주기
#define LIS_BAD_STREAK_REINIT  20      // 연속 0xFF 20회(=1s) → I2C reinit
// ── I2C(Wire) 견고화 (P6-I2C, 2026-07-06) ──
//  INT-WDT(인터럽트 컨텍스트 wedge) 유력후보 = I2C 버스에러. 400kHz→100kHz(배선 마진↑),
//  Wire 버스 timeout(무한 대기 방지), reinit 시 SCL 9펄스 bus-recovery(SDA stuck 언스틱).
#define LIS_I2C_HZ             100000  // was 400000 — 신호무결성 마진 (모션 폴은 1B/50ms 라 속도 무관)
#define LIS_I2C_TIMEOUT_MS     50      // Wire.setTimeOut — 버스 hang 시 드라이버 무한대기 차단
// [2026-08-14 "정지인데 sleep 미진입" 대책] activity EMA 오염원 차단 3종 + LIS 자가복구.
//   정지 노이즈(~35mg)와 임계(40mg) 마진이 5mg 뿐이라, 부저 진동/I2C 글리치가 EMA 를 임계 위로
//   밀면 stationary window 가 주기적으로 리셋되어 영영 sleep 에 못 들어감.
#define MOTION_REPROBE_MS      30000UL // init 실패 시 LIS 주기 재탐지 — 실패 방치 = sleep 영구 비활성(배터리)
#define MOTION_MAG_MIN_MG      200     // rawMag 타당범위(중력≈1000mg) 밖 = 단일축 I2C 글리치로 간주, 샘플 스킵
#define MOTION_MAG_MAX_MG      4000    //   (fix#11 은 전바이트 0xFF 만 걸렀음 — 부분 글리치 사각 보완)
#define MOTION_D_CLAMP_MG      250     // 샘플 1개의 |Δ| 상한 — 글리치 1개로 EMA 가 임계(40) 못 넘게 (250/8=31)
#define BUZZ_RINGDOWN_MS       200     // 부저 OFF 후 PCB 잔진동 무시 창 — POST 비프의 activity 오염 차단

// ── 진단 출력 ────────────────────────────────────────────────────
#define STATUS_PRINT_MS   1000UL

#define DBG  1
#define DBGLN(...)  do { if (DBG) Serial.println(__VA_ARGS__); } while (0)
#define DBGP(...)   do { if (DBG) Serial.print(__VA_ARGS__); } while (0)

// =================================================================
// ★ KC 인증(콜박스) 시험용 빌드 — for_kc.txt 체크리스트 대응 (2026-08-27)
//   콜박스(기지국 시뮬레이터, PLMN 001/01 + 시험용 USIM)는 RRC 등록까지만 세우고
//   PDP/데이터 세션은 안 붙는 경우가 많다. 운영 펌웨어의 "POST 실패 → 복구 에스컬레이션
//   (railCycle 12s 전원차단 → esp_restart)" 이 그대로 돌면 시험 중 모뎀이 주기적으로
//   꺼졌다 켜져 측정 불가 → 시험 반나절 날림. KC_TEST_BUILD=1 이면:
//     · 재부팅/전원사이클/워치독 전부 OFF — 모뎀 항상 ON, 등록 유지 폴만
//     · PDP/POST 스킵 — 등록(reg=1|5)만으로 ONLINE 취급 (콜박스가 RRC 전력제어로 TX 올림)
//     · AT+COPS=0 명시 (수동 PLMN 고정 잔재 차단 — 시험용 PLMN 에 붙어야 함)
//     · AT+CBANDCFG 밴드 락 + 응답 캡처 출력 (인증범위 증빙: 선언서 + 설정로그 + 캡처)
//     · sleep/부저 OFF (시험 중 deep sleep 진입·GPIO1 노이즈원 차단)
//   ⚠️ 운영 배포 전 반드시 0 원복! (TIMER_WAKE_ENABLED 교훈과 동일한 토글 함정 주의)
//   ⚠️ CBANDCFG 는 모듈 NVRAM 저장 — 시험 후 다른 밴드 필요 시 docs/kc_test_build.md 의
//      복원 커맨드로 해제. (단, 밴드 제한으로 인증받으면 양산 펌웨어도 락 유지가 원칙)
// =================================================================
#define KC_TEST_BUILD   0     // ★ 1 = KC 시험 빌드 (운영 배포 전 0 원복 필수!)

#if KC_TEST_BUILD
  // 인증 대상 밴드 락 — 시험소 견적 확정 후 조정. 실측(2026-08-27, device 3005) = Cat-M1 B5.
  //   복수 밴드는 콤마: "5,8" / "5,3" 등. NB-IoT 미인증이면 NB 목록을 비우지 말고 동일 밴드로
  //   락(모듈이 빈 목록 거부) + CNMP/CMNB 로 Cat-M only 강제.
  #define KC_BAND_CATM    "5"        // Cat-M1 인증 밴드 (인증표: B5/B8/B3 중 선택)
  #define KC_BAND_NBIOT   "5"        // NB-IoT 인증 밴드 (인증표: B5/B3 중 선택)
  #define KC_CATM_ONLY    1          // 1 = AT+CMNB=1(Cat-M only) — NB 미인증 시. 0 = 둘 다(CMNB=3)
  // 운영 플래그 강제 오버라이드 (재정의 경고 없이 #undef 후 재정의)
  #undef  BUZZER_ENABLED
  #define BUZZER_ENABLED   0         // GPIO1 부저 노이즈원 차단 (EMI + LTE 간섭 이력)
  #undef  SLEEP_DISABLED
  #define SLEEP_DISABLED   1         // deep sleep 금지 — 시험 내내 모뎀/보드 ON 유지
  #undef  LOOP_WDT_ENABLED
  #define LOOP_WDT_ENABLED 0         // task WDT panic reset OFF (문서 요구: 워치독 비활성)
#endif
