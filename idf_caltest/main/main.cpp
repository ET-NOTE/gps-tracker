// =================================================================
// 15_a_modular — 13_4_aa 구조적 리팩터.
//   목표: 사고 대응 패치 누적으로 얽힌 복구 경로(7개)/블로킹 구조를 모듈로 분리하고
//         단일 recovery state machine 으로 통합. 블록별 실기 검증하며 이관.
//   원본 golden reference: ../13_4_aa_motion_aware_tracker
//
//   Block 1 (done): config.h + buzzer.
//   Block 2 (done): hw_power — 공유 PWR_EN 레일 + PWRKEY.
//   Block 3 (done): gps — LC86G·NMEA·안테나·fix·drift·batch.
//   Block 4 (done*): motion — LIS3DH. wake OK. ※런타임 카운터 open item (motion.cpp).
//   Block 5 (done): lte — AT + bring-up + SIM.
//   Block 6 (done): lte HTTP keepalive + telemetry. POST 200 검증.
//   Block 7 (done): recovery — 복구 경로 통합 단일 state machine (무오발동 검증).
//   Block 8 (현재): sleep_mgr — deep sleep + wake 부기 + 정지 자동 sleep + timer-wake heartbeat.
//     검증: 정지 5분(또는 테스트 단축) → deep sleep → 모션 wake → 재bringup. wake 카운터.
//   ※ [정정 2026-07-14] 부저 = BUZZER_ENABLED 1(ON, 운영). 부저맵: 클린부팅 길게1 / 크래시 긴3 /
//     첫LTE성공 느린4 / 정상통신 짧은1 / POST실패 빠른4 / 모션wake 6 / sleep진입 2.
// =================================================================
#include <Arduino.h>        // ★ IDF 빌드: arduino-cli 는 자동추가, IDF 는 명시 필요
#include <Preferences.h>    // HW-DIAG: NVS 크래시 카운터 (INT-WDT RTC 소실에도 유지)
#include <esp_system.h>
#include "config.h"
#include "buzzer.h"
#include "hw_power.h"
#include "gps.h"
#include "motion.h"
#include "lte.h"
#include "telemetry.h"
#include "recovery.h"
#include "sleep_mgr.h"
#include "breadcrumb.h"
#include "loopwdt.h"

static uint32_t bootMs = 0;
static uint32_t nextPostAt = 0;
static bool diagPending = true;   // wake 후 첫 POST 에 diag{} 포함 (매 부팅 true — deep sleep 재부팅마다)

// 부저 마일스톤 가드 — RTC 보존 (deep sleep/wake 넘어 세션당 1회). 모션 wake 시 fix/post 재활성.
RTC_DATA_ATTR static bool buzzBoot      = false;
RTC_DATA_ATTR static bool buzzFirstFix  = false;
RTC_DATA_ATTR static bool buzzFirstPost = false;

// (2026-07-08 진단) reset-reason NVS 누적 — HWDIAG 진단본에서만 사용 (운영본 HWDIAG=0 이면 미사용).
#if HWDIAG_ENABLED
static uint32_t g_rstBr = 0, g_rstIw = 0, g_rstTw = 0, g_rstPn = 0, g_rstSw = 0, g_rstOt = 0, g_rstOtr = 0;
#endif

static uint16_t readVbatMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(PIN_BAT);
  return (uint16_t)((sum / 16) * BAT_DIV_RATIO);
}

static void printStatus() {
  uint32_t up_s = (millis() - bootMs) / 1000;
  Serial.printf("[STATUS %lus wake=%s] %s vbat=%umV heap=%lu | LTE:%s CSQ=%d REG=%d IP=%s conn=%d bu=%u | esc(bf=%u hr=%u ss=%u) | GPS:%s sat=%d batch=%u | MOT t=%lu lis=%s",
    (unsigned long)up_s, sleep_mgr::wakeReason(), recovery::stateStr(),
    (unsigned)readVbatMv(), (unsigned long)ESP.getFreeHeap(),
    lte::ready() ? "OK" : "--", lte::csq(), lte::reg(), lte::ip(),
    (int)lte::httpConnected(), (unsigned)lte::bringUpCount(),
    (unsigned)recovery::bringFails(), (unsigned)recovery::hardResets(), (unsigned)recovery::softStreak(),
    gps::hasFix() ? "FIX" : "---", gps::satellites(), (unsigned)gps::batchCount(),
    (unsigned long)motion::events(), motion::ok() ? "ok" : "--");
  Serial.printf(" act=%lumg%s stay=%s", (unsigned long)motion::activityMg(),
    motion::active() ? "(MOVING)" : "", sleep_mgr::stayCause());   // stay = sleep 을 막는 현재 게이트
#if HWDIAG_ENABLED
  Serial.printf(" RST[br=%lu iw=%lu tw=%lu pn=%lu sw=%lu ot=%lu#%lu]",   // 진단: reset원인 누적 (ot#=기타 원시번호)
    (unsigned long)g_rstBr, (unsigned long)g_rstIw, (unsigned long)g_rstTw,
    (unsigned long)g_rstPn, (unsigned long)g_rstSw, (unsigned long)g_rstOt, (unsigned long)g_rstOtr);
#endif
  if (sleep_mgr::stationaryActive()) {
    Serial.printf(" | STAT %lu/%lus drift=%.1fm",
      (unsigned long)(sleep_mgr::stationaryHeldMs() / 1000),
      (unsigned long)(STATIONARY_WINDOW_MS / 1000), sleep_mgr::lastDriftM());
  }
  if (sleep_mgr::timerWakeMode()) Serial.print(F(" | TIMER_HB"));
  Serial.println();
}

static void doPost() {
  bc::set("do_post");
  static char body[8192];   // batch 최대 120 fix + diag 조각 → 원본과 동일 8KB
  uint8_t posted = telemetry::buildPayload(body, sizeof(body), bootMs, diagPending);
  if (DBG) { Serial.print(F("[POST body] ")); Serial.println(body); }

  int status = -1;
  uint32_t t0 = millis();
  bool ok = lte::httpPost(body, &status);
  bool ok200 = ok && status == 200;
  Serial.printf("[POST] elapsed=%lums status=%d ok=%d conn=%d posted=%u\n",
    (unsigned long)(millis() - t0), status, (int)ok, (int)lte::httpConnected(), posted);

  if (ok200 && posted > 0) gps::batchDrop(posted);
  recovery::notifyPostResult(ok200);
  if (ok200) diagPending = false;   // wake diag 는 첫 성공 POST 1회만
  // ★[2026-07-13 부저맵] 첫 LTE성공=4회(느린 200ms, 마일스톤) / 이후 정상통신=짧은삐1회(주기) / 실패=짧은삐4회(빠른 70ms)
  if (ok200) {
    if (!buzzFirstPost) { buzzFirstPost = true; buzzer::beep(4, 200, 120); buzzer::flush(1500); }  // 첫 성공 마일스톤(느린 4회)
    else                { buzzer::beep(1, 60, 0);   buzzer::flush(300); }                            // 정상통신 = 짧은삐 1회
  } else                { buzzer::beep(4, 70, 70);   buzzer::flush(700); }                            // 비정상통신 = 짧은삐 4회

  if (lte::consumeServerBeep())  { Serial.println(F("[BUZ] server cmd:beep")); buzzer::beep(5, 200, 100); buzzer::flush(); }
  if (lte::consumeServerReset()) { Serial.println(F("[LTE] server cmd:reset → hardCycle")); lte::hardCycle(); }

  if (ok200) sleep_mgr::onPostSuccess();   // timer-wake heartbeat 완료 시 여기서 re-sleep
}

void setup() {
  bootMs = millis();
  buzzer::init();   // ★ 최상단: GPIO1 즉시 LOW (능동 부저 boot-floating buzz 방지)
  bc::set("setup");
  Serial.begin(115200);
  // ★[2026-07-06] 옵저브 빌드도 non-blocking CDC 로 전환(field 와 동일). 이유: blocking CDC 는
  //   로거(리더) 스톨 시 Serial.print 가 영구 블록→CDC-full stuck, 그리고 호스트 재연결 churn 이
  //   USB CDC 인터럽트 경로 INT-WDT 크래시 폭주를 유발(12:06 sss 18회/3분, aa non-blocking 은 0).
  //   대가: 리더 없을 때 로그 drop. 단일 펌웨어 수렴 방향과도 일치.
  Serial.setTxTimeoutMs(0);
  delay(2000);   // USB CDC 안정화 대기
  Serial.println();
  Serial.println(F("=== 15_a_modular — Block 8: sleep_mgr (non-blocking CDC) ==="));
#if KC_TEST_BUILD
  Serial.println(F("*********************************************************"));
  Serial.println(F("*  KC TEST BUILD — 콜박스 시험용 (운영 배포 금지!)          *"));
  Serial.println(F("*  sleep/부저/WDT/복구 OFF · PDP/POST skip · COPS=0       *"));
  Serial.printf ("*  band-lock: CAT-M=%s NB-IOT=%s catm_only=%d\n", KC_BAND_CATM, KC_BAND_NBIOT, (int)KC_CATM_ONLY);
  Serial.println(F("*********************************************************"));
#endif

  esp_reset_reason_t rr = esp_reset_reason();
  Serial.printf("[BOOT] reset_reason=%d\n", (int)rr);

  // ================= HW-DIAG (HW팀 관측용) =================
  //  INT-WDT 재현본. NVS 크래시 카운터(INT-WDT 가 RTC 지워도 유지) + 배너 + 부저 알람.
  //  크래시 재부팅 → 긴삐3회 알람 + CRASHES 증가. HW 수정 후 알람/증가 멈추면 = 해결.
  //  (2026-07-08) HWDIAG_ENABLED 로 게이트 — 최종 운영본(=0)은 이 블록 제거.
#if HWDIAG_ENABLED
  {
    Preferences pf; pf.begin("hwdiag", false);
    uint32_t crashes = pf.getUInt("crashes", 0);
    uint32_t boots   = pf.getUInt("boots", 0) + 1;
    bool isCrash = (rr != ESP_RST_POWERON && rr != ESP_RST_DEEPSLEEP
                    && rr != ESP_RST_USB && rr != ESP_RST_JTAG
                    && rr != ESP_RST_SW);   // (B 2026-07-08) +SW제외: recovery esp_restart(SW)는 복구재시작이지 크래시 아님 → 긴삐3회·CRASHES 카운터에서 제외 (진짜 INT-WDT/PANIC/BROWNOUT만 크래시)
    if (rr == ESP_RST_POWERON) { crashes = 0; boots = 1; }               // 전원인가 시 카운터 리셋
    else if (isCrash) crashes++;
    pf.putUInt("crashes", crashes); pf.putUInt("boots", boots);
    // (2026-07-08 진단) per-reset-reason NVS 누적 — 배터리 재부팅도 USB 없이 기록. POWERON 시 리셋.
    if (rr == ESP_RST_POWERON) {
      pf.putUInt("br",0); pf.putUInt("iw",0); pf.putUInt("tw",0);
      pf.putUInt("pn",0); pf.putUInt("sw",0); pf.putUInt("ot",0); pf.putUInt("otr",0);
    } else {
      const char* k = nullptr;
      switch (rr) {
        case ESP_RST_BROWNOUT: k = "br"; break;   // 브라운아웃(전원)
        case ESP_RST_INT_WDT:  k = "iw"; break;   // INT-WDT(클럭스톨)
        case ESP_RST_TASK_WDT: k = "tw"; break;   // Task-WDT(loop행)
        case ESP_RST_PANIC:    k = "pn"; break;   // panic
        case ESP_RST_SW:       k = "sw"; break;   // SW(recovery esp_restart)
        case ESP_RST_DEEPSLEEP: case ESP_RST_USB: case ESP_RST_JTAG: break;  // 정상 리셋 무시
        default: k = "ot"; pf.putUInt("otr", (uint32_t)rr); break;  // ★기타의 원시 reset_reason 번호 기록
      }
      if (k) pf.putUInt(k, pf.getUInt(k, 0) + 1);
    }
    g_rstBr=pf.getUInt("br",0); g_rstIw=pf.getUInt("iw",0); g_rstTw=pf.getUInt("tw",0);
    g_rstPn=pf.getUInt("pn",0); g_rstSw=pf.getUInt("sw",0); g_rstOt=pf.getUInt("ot",0); g_rstOtr=pf.getUInt("otr",0);
    pf.end();
    Serial.println();
    Serial.println("========================================================");
    Serial.println("  HW-DIAG BUILD | ESP32-C3 INT-WDT 재현본 (HW팀 관측용)");
    Serial.printf ("  reset=%d  boots=%lu   >>> CRASHES=%lu <<<\n",
                   (int)rr, (unsigned long)boots, (unsigned long)crashes);
    Serial.println(isCrash ? "  *** 방금 CRASH(INT-WDT류)로 재부팅됨 — 부저 알람 ***"
                   : (rr == ESP_RST_POWERON ? "  clean power-on (카운터 리셋)" : "  normal wake"));
    Serial.println("  HW 수정 후 CRASHES 가 안 오르고 알람이 멈추면 = 해결");
    Serial.println("========================================================");
    Serial.flush();
    if (isCrash) { buzzer::beep(3, 500, 250); buzzer::flush(2200); }     // ★ 크래시 알람 = 긴 삐 3회 (flush 2200: 3회 다 울리게)
    else if (rr == ESP_RST_POWERON) { buzzer::beep(1, 600, 0); buzzer::flush(); }  // 클린 전원 = 길게 1회
    buzzBoot = true;   // ★ 앱의 잔여 콜드부팅음 억제 → 부저 신호는 HW-DIAG 것만 (크래시=긴삐3, 클린=길게1)
  }
#endif  // HWDIAG_ENABLED
  // =========================================================

#if !HWDIAG_ENABLED
  // ★[2026-07-13] 크래시 부저 유지 (HWDIAG 디버그 카운터/배너 없이도) — HWDIAG 블록 없을 때만.
  {
    bool isCrash = (rr != ESP_RST_POWERON && rr != ESP_RST_DEEPSLEEP
                    && rr != ESP_RST_USB && rr != ESP_RST_JTAG && rr != ESP_RST_SW);
    if (isCrash) { buzzer::beep(3, 500, 250); buzzer::flush(2200); }         // 크래시 = 긴 삐 3회 (flush 2200)
    else if (rr == ESP_RST_POWERON) { buzzer::beep(1, 600, 0); buzzer::flush(); }  // 클린 전원 = 길게 1회
    buzzBoot = true;   // 앱 콜드부팅음 억제 (크래시/전원 부저가 대신)
  }
#endif

  lwdt::arm();   // ★ 조기 무장: setup(bringup 포함)도 감시 + feed 가 등록된 task 를 씀(로그오염 방지)

  analogReadResolution(12);

  hw_power::init();
  Serial.println(F("[PWR] railOn"));
  hw_power::railOn();

  bc::set("mot_init");
  Serial.println(F("[MOT] init"));  motion::init();
  sleep_mgr::begin(bootMs);          // wake/reset 부기 + bounce 필터 (motion 이후)

  // 부저 마일스톤 — 모션 wake 6회. (콜드부팅=길게1/크래시=긴3/전원=길게1 은 위 부팅 블록서 처리 →
  //   buzzBoot 항상 true 라 예전의 else-if 콜드부팅 beep 은 죽은 코드였음 → 제거. fix#9)
  if (strcmp(sleep_mgr::wakeReason(), "motion") == 0) {
    buzzFirstFix = false; buzzFirstPost = false;   // wake 마다 fix/post 비프 재활성
    buzzer::beep(WAKE_BEEP_COUNT, 60, 60);          // 모션 wake: 6회
    buzzer::flush();
  }

  bc::set("gps_init");
  Serial.println(F("[GPS] init"));  gps::init(bootMs);

  Serial.println(F("[LTE] power-on (bringUp 은 recovery)"));
  lte::init();
  recovery::init(bootMs);

  nextPostAt = millis() + 2000;
  printStatus();
}

void loop() {
  lwdt::feed();   // loop 진전 신호 (AT 대기루프·sleep 진입서도 별도 feed)
  gps::feed();
  motion::tick();
  if (gps::consumeFirstFixEvent()) {
    Serial.println(F("[GPS] first fix event"));
    if (!buzzFirstFix) { buzzFirstFix = true; buzzer::beep(3, 80, 80); buzzer::flush(); }
  }

  recovery::tick();

#if KC_TEST_BUILD
  // KC 시험 모드: POST 없음 (콜박스에 데이터 세션 없음 — SHCONN 시도는 실패 소음만 만듦)
#else
  if (recovery::online() && (int32_t)(millis() - nextPostAt) >= 0) {
    doPost();
    nextPostAt = millis() + lte::postIntervalMs();
  }
#endif

  sleep_mgr::checkStationary();   // 정지 5분 → deep sleep
  sleep_mgr::timerWakeTick();     // timer-wake 2분 guard

  static uint32_t lastStatusMs = 0;
  if (millis() - lastStatusMs > STATUS_PRINT_MS) {
    lastStatusMs = millis();
    printStatus();
  }
  buzzer::update();
  delay(10);
}
