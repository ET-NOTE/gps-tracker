// =================================================================
// hwdiag_lte_buzz — LTE ON + 부저 ENABLE 진단본 (arduino, 2026-07-06)
//   INT-WDT 크래시 재현/관찰용. LTE(SIM7080) 구동 + 2초마다 POST(TX 부하),
//   부저로 크래시 알람(6회) / 클린전원(1회). NVS 크래시 카운터 + 배너 + 리셋원인 이름.
//   (GPS/모션/I2C/슬립은 안 씀 — LTE+부저에 집중한 진단 스케치.)
//
//   빌드/플래시 (arduino-cli, 모니터링 세션 FQBN):
//     arduino-cli compile -b esp32:esp32:esp32c3:CDCOnBoot=cdc arduino/hwdiag_lte_buzz
//     arduino-cli upload  -b esp32:esp32:esp32c3:CDCOnBoot=cdc -p COMxx arduino/hwdiag_lte_buzz
//   ※ arduino 기본 libs 는 CONFIG_RTC_CLK_CAL_CYCLES=576(크래시 잘 남) → 진단에 적합.
//   ※ 부저 알람이 주 신호(비프6=크래시재부팅, 비프1=클린전원). non-blocking CDC라
//     빠른 크래시-루프 중 시리얼 배너는 일부 드롭될 수 있음.
//
//   부저 맵: 6회=크래시(INT-WDT류) 재부팅,  1회(길게)=클린 전원인가.
// =================================================================
#include <Arduino.h>
#include <Preferences.h>
#include <esp_system.h>
#include "config.h"
#include "buzzer.h"
#include "hw_power.h"
#include "lte.h"
#include "loopwdt.h"

static uint32_t bootMs = 0;
static uint32_t upS() { return (millis() - bootMs) / 1000; }

// esp_reset_reason_t → 사람이 읽는 이름 (크래시 종류 구분: 클럭스톨 vs 전원)
static const char* resetName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:    return "POWERON(클린전원)";
    case ESP_RST_EXT:        return "EXT";
    case ESP_RST_SW:         return "SW";
    case ESP_RST_PANIC:      return "PANIC";
    case ESP_RST_INT_WDT:    return "INT_WDT(인터럽트워치독=클럭스톨)";
    case ESP_RST_TASK_WDT:   return "TASK_WDT(loop행)";
    case ESP_RST_WDT:        return "WDT(기타워치독)";
    case ESP_RST_DEEPSLEEP:  return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:   return "BROWNOUT(전압강하=전원불안정)";
    case ESP_RST_SDIO:       return "SDIO";
    case ESP_RST_USB:        return "USB";
    case ESP_RST_JTAG:       return "JTAG";
#ifdef ESP_RST_CPU_LOCKUP
    case ESP_RST_CPU_LOCKUP: return "CPU_LOCKUP";
#endif
    default:                 return "UNKNOWN/기타";
  }
}

void setup() {
  bootMs = millis();
  buzzer::init();                 // GPIO1 즉시 LOW (부저 boot-floating 방지)
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);       // non-blocking CDC (리더 없어도 hang 안 함)
  delay(1500);

  esp_reset_reason_t rr = esp_reset_reason();

  // ===== HW-DIAG: NVS 크래시 카운터 + 배너 + 부저 알람 (+리셋원인 이름) =====
  {
    Preferences pf; pf.begin("hwdiag", false);
    uint32_t crashes = pf.getUInt("crashes", 0);
    uint32_t boots   = pf.getUInt("boots", 0) + 1;
    bool isCrash = (rr != ESP_RST_POWERON && rr != ESP_RST_DEEPSLEEP
                    && rr != ESP_RST_USB && rr != ESP_RST_JTAG);
    if (rr == ESP_RST_POWERON) { crashes = 0; boots = 1; }
    else if (isCrash) crashes++;
    pf.putUInt("crashes", crashes); pf.putUInt("boots", boots); pf.end();
    Serial.println();
    Serial.println("========================================================");
    Serial.println("  LTE ON + BUZZER 진단본 | ESP32-C3 INT-WDT 재현/관찰");
    Serial.printf ("  reset=%d [%s]\n", (int)rr, resetName(rr));
    Serial.printf ("  boots=%lu   >>> CRASHES=%lu <<<\n",
                   (unsigned long)boots, (unsigned long)crashes);
    Serial.println(isCrash ? "  *** 방금 CRASH 로 재부팅됨 — 부저 6회 알람 (위 reset원인 확인) ***"
                   : (rr == ESP_RST_POWERON ? "  clean power-on (카운터 리셋, 부저 1회)" : "  boot"));
    Serial.println("  LTE 구동 + 2초마다 POST(TX). 크래시가 POST/TX 와 시간상관 있으면 = LTE/전원 의심.");
    Serial.println("========================================================");
    Serial.flush();
    if (isCrash) { buzzer::beep(6, 70, 70); buzzer::flush(); }           // 크래시 알람 6회
    else if (rr == ESP_RST_POWERON) { buzzer::beep(1, 600, 0); buzzer::flush(); }  // 클린 전원 1회
  }

  lwdt::arm();

  hw_power::init();
  Serial.println("[LTE+BUZZ] railOn");
  hw_power::railOn();
  lte::init();                    // UART + power-on
  Serial.println("[LTE+BUZZ] init done → LTE bringup + POST 부하 시작");
}

void loop() {
  lwdt::feed();
  buzzer::update();               // 부저 상태머신 진행 (non-blocking)
  static uint32_t postN = 0, lastPost = 0;

  // --- LTE 미등록: bringup 반복 ---
  if (!lte::ready()) {
    Serial.printf("[t=%lus] LTE bringUp 시도...\n", upS());
    if (lte::bringUp()) {
      lte::fetchSimInfo();
      Serial.printf("[t=%lus] LTE ONLINE  CSQ=%d REG=%d\n", upS(), lte::csq(), lte::reg());
    } else {
      Serial.printf("[t=%lus] LTE bringUp FAIL (CSQ=%d REG=%d)\n", upS(), lte::csq(), lte::reg());
      delay(1500);
    }
    return;
  }

  // --- LTE 부하: 2초마다 POST(TX) 반복 ---
  if (millis() - lastPost >= 2000) {
    lastPost = millis();
    postN++;
    lte::refresh();               // CSQ/REG 갱신
    char body[160];
    snprintf(body, sizeof(body),
             "{\"test\":\"lte+buzz\",\"t\":%lu,\"n\":%lu,\"csq\":%d,\"reg\":%d}",
             (unsigned long)upS(), (unsigned long)postN, lte::csq(), lte::reg());
    int st = -1;
    uint32_t t0 = millis();
    Serial.printf("[t=%lus] POST #%lu 시작 (TX) CSQ=%d ...\n", upS(), (unsigned long)postN, lte::csq());
    bool ok = lte::httpPost(body, &st);
    Serial.printf("[t=%lus] POST #%lu -> status=%d elapsed=%lums ok=%d conn=%d\n",
                  upS(), (unsigned long)postN, st, (unsigned long)(millis() - t0), (int)ok, (int)lte::httpConnected());
  }

  // 1초 하트비트 (크래시 시각 대조용 타임라인)
  static uint32_t lastHb = 0;
  if (millis() - lastHb >= 1000) {
    lastHb = millis();
    Serial.printf("[t=%lus] alive (LTE %s CSQ=%d REG=%d)\n",
                  upS(), lte::ready() ? "OK" : "--", lte::csq(), lte::reg());
  }
  delay(20);
}
