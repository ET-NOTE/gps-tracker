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
#define WAKE_BEEP_COUNT 6  // (2026-07-03 사용자 결정) 모션 wake 시 부저 횟수 — aa 필드본과 통일(6회).

// ── 핀 (신 PCB rev, 2026-06-17~) ─────────────────────────────────
#define PIN_SDA        8
#define PIN_SCL        9
#define PIN_PWR_EN     6      // GPS + LTE 공유 전원 (분리 제어 불가 — hw_power 모듈이 격리)
#define PIN_PWRKEY     7
#define PIN_DTR        10
#define PIN_BAT        3
#define PIN_LIS_INT    5
#define PIN_GPS_RX     20
#define PIN_GPS_TX     21
#define PIN_LTE_RX     2     // 신 PCB: ESP RX ← SIM TX (RX/TX swap)
#define PIN_LTE_TX     4     // 신 PCB: ESP TX → SIM RX
#define PIN_BUZZER     1     // 액티브(마그네틱) 부저 — digitalWrite HIGH=on

// ── LTE 극성 (aa fork — 03_4 진단 확정값) ────────────────────────
#define LTE_DTR_IDLE      LOW    // SIM7080 datasheet default
#define LTE_PWRKEY_IDLE   LOW
#define LTE_PWRKEY_PULSE  HIGH

// ── Baud / 네트워크 ──────────────────────────────────────────────
#define GPS_BAUD       9600         // aa LC86G default — "9600 유지 절대 원칙"
#define LTE_BAUD       115200
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
//   물리 전원차단 10~15s 만에 복구됨(실증). "아침에 죽어있는" 만성 필드 증상의 정체 = 이 콜드 stuck.
//   (hardCycle 은 최후수단이라 드물게 발동 → 12s 블로킹 무방. bringup 이미 12~20s 블로킹.)
#define PWR_CYCLE_OFF_MS      12000  // railCycle: OFF 유지 (VBAT 캡 방전 — 콜드 stuck 해제엔 물리차단급 필요)
#define PWR_CYCLE_ON_MS       2000   // railCycle: ON 후 안정
#define PWRKEY_PULSE_MS       1500   // PWRKEY 펄스 폭 (SIM7080 전원 토글)
#define PWRKEY_PRE_MS         100    // 펄스 전 idle 유지

// ── GPS (gps 모듈) ───────────────────────────────────────────────
#define GPS_HISTORY_N   16     // drift 판정용 fix ring buffer
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

// ── LTE (lte 모듈) 타이밍 ────────────────────────────────────────
#define LTE_REG_WAIT_MS       90000UL   // 등록(CEREG 1/5) 대기 상한
#define LTE_CNACT_TIMEOUT_MS  20000UL   // PDP(CNACT) 활성 대기
#define LTE_BRINGUP_RETRY_MS  30000UL   // bringup 재시도 간격 (Block 5 임시 — Block 7 recovery 가 대체)
#define POST_INTERVAL_DEFAULT_MS  30000UL   // POST 주기 (서버 cmd 로 5~300s 조정, RAM only)
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
#define STUCK_RESTART_TIMEOUT_MS  (5UL*60*1000UL)   // stuck 지속 → esp_restart (ceiling)
#define BOOT_STUCK_RESTART_MS     (5UL*60*1000UL)   // 부팅 후 성공 POST 0 → esp_restart
#define BRINGUP_FAIL_HARD         3                 // 연속 bringup 실패 → hardCycle
#define HARD_RESET_LIMIT          2                 // hardCycle 반복 상한 → esp_restart
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
#define SLEEP_DISABLED             0                  // 1=자동 sleep 비활성 (운행관찰용 임시). 평소 0.
#define SLEEP_TEST                 0                  // 1=벤치 sleep/wake 검증용 단축값 (운영 전 0 원복!)
#define OBSERVE_MODE               0                  // FIELD(aa): 운영 sleep 스케줄 (정지 5분→deep sleep, 운영 timer값). 관찰용 sss 는 1.
#define GPS_STALE_MS               60000UL            // 이보다 오래된 fix = GPS unavailable
#define STATIONARY_MIN_FIXES       3                  // (P2 2026-07-03) 정지 확신에 필요한 window 내 최소 fix 수. 미만이면 GPS 무근거로 보고 모션 quiet 로만 판단(저계수 fix 오탐 방지).
#if SLEEP_TEST || OBSERVE_MODE
  #define STATIONARY_WINDOW_MS      30000UL           // (관찰/test) 30s
  #define STATIONARY_BOOT_GRACE_MS  15000UL           // (관찰/test) 15s
  #define GPS_DRIFT_THRESHOLD_M     1000.0f           // (관찰/test) 실내 GPS 노이즈가 window 리셋 안 하게
  #define NO_GPS_SLEEP_GRACE_MS     20000UL           // (관찰/test) GPS 없어도 20s quiet 면 sleep
#else
  #define STATIONARY_WINDOW_MS      (5UL*60*1000UL)   // 정지 유지 → deep sleep
  #define STATIONARY_BOOT_GRACE_MS  60000UL           // 부팅 직후 정지판정 보류
  #define GPS_DRIFT_THRESHOLD_M     50.0f             // 정지 판정 drift 임계
  #define NO_GPS_SLEEP_GRACE_MS     (10UL*60*1000UL)  // GPS 없을 때 LIS 단독 sleep 유예
#endif
#if OBSERVE_MODE
  #define TIMER_WAKE_INTERVAL_US   (8ULL*1000000ULL)      // 관찰: sleep 8s 후 자동 wake (dark 방지)
#else
  #define TIMER_WAKE_INTERVAL_US   (10ULL*60*1000000ULL)  // 운영: deep sleep 10분 timer wake
#endif
#define TIMER_WAKE_MAX_MS          120000UL           // timer-wake heartbeat 2분 guard
// (FIELD aa) 모션 wake ONLY — deep sleep 중 timer wake 비활성. 깨어있음=진짜 모션(의미있는 신호).
//   ⚠️ trade-off: LIS 가 차량 진동 놓치면 영구 sleep 가능. 모션 튜닝(HPM=00) 후 개선됨. 관찰 필요.
#define TIMER_WAKE_ENABLED         0
// (P0 2026-07-02) LTE 미등록/recovery 중 stationary sleep 보류 상한.
//   이 시간 내에는 깨어서 bringup 재시도+에스컬레이션 지속(정지 stuck 회피).
//   초과 시엔 배터리 보호 위해 sleep 허용 (이후 wake 는 RTC 카운터로 에스컬레이션 이어감).
#if OBSERVE_MODE || SLEEP_TEST
  #define RECOVERY_STAY_AWAKE_MS   90000UL            // (test) 90s
#else
  #define RECOVERY_STAY_AWAKE_MS   (5UL*60*1000UL)    // 운영 5분
#endif
#define WAKE_BOUNCE_OBSERVE_MS     1000UL             // 모션 wake 후 진동 관찰
#define WAKE_BOUNCE_LOW_RATIO      0.55f              // INT LOW 비율 초과 = 지속진동 → re-sleep

// ── Motion (LIS3DH, motion 모듈) ─────────────────────────────────
#define LIS_MOT_THS            0x04    // 64mg (2026-07-03 튜닝: 128mg→64mg. 정지노이즈~35mg 위, 살짝~주행 진동 포착. 흔들기 특성화: 살짝~50-114mg/중간~346/세게~411)
#define LIS_MOT_DUR            0x02    // 40ms @50Hz (120→40ms: 주행 범프 놓침 방지. 高이벤트 비트 병용)
#define MOTION_RAW_DEBUG       0       // (P2 진단) 1=인터럽트 경로(INT1_SRC/핀) 로깅. 검증/운영은 0.
#define LIS_EDGE_FILTER_MS     100     // ISR 디바운스
#define MOTION_QUIET_MS        30000UL // 이 시간 이벤트 0 = "조용함"
#define LIS_HEALTH_POLL_MS     50      // INT1_SRC 헬스 폴 주기
#define LIS_BAD_STREAK_REINIT  20      // 연속 0xFF 20회(=1s) → I2C reinit
// ── I2C(Wire) 견고화 (P6-I2C, 2026-07-06) ──
//  INT-WDT(인터럽트 컨텍스트 wedge) 유력후보 = I2C 버스에러. 400kHz→100kHz(배선 마진↑),
//  Wire 버스 timeout(무한 대기 방지), reinit 시 SCL 9펄스 bus-recovery(SDA stuck 언스틱).
#define LIS_I2C_HZ             100000  // was 400000 — 신호무결성 마진 (모션 폴은 1B/50ms 라 속도 무관)
#define LIS_I2C_TIMEOUT_MS     50      // Wire.setTimeOut — 버스 hang 시 드라이버 무한대기 차단

// ── 진단 출력 ────────────────────────────────────────────────────
#define STATUS_PRINT_MS   1000UL

#define DBG  1
#define DBGLN(...)  do { if (DBG) Serial.println(__VA_ARGS__); } while (0)
#define DBGP(...)   do { if (DBG) Serial.print(__VA_ARGS__); } while (0)
