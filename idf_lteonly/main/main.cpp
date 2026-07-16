// =================================================================
// LTE-ONLY 임시 진단본 (2026-07-10) — 별도 프로젝트(idf_lteonly). idf_caltest 원본 불변.
//   목적: GPS/모션/I2C/슬립/telemetry/recovery 전부 제거, LTE(SIM7080) bringUp + 반복 POST(TX)만
//         구동. 크래시(RTC캘리/INT-WDT)가 LTE TX 와 시간상관 있는지 격리 확인.
//   유지: coredump(flash) · HWDIAG RST 카운터(br/iw/tw/pn/sw/ot) · STATUS/상세 로그.
//   ★[2026-07-11 HW팀 데모 PCB] railOn() 으로 PWR_EN=LOW 레일 ON (데모 PCB 는 GPIO6 게이팅).
//      railCycle/hardCycle 은 여전히 미호출(격리 유지). DTR=HIGH, PWRKEY idle HIGH.
//   ※ CAL_CYCLES 는 sdkconfig.defaults 값(=576, 크래시 잘 나는 설정) 유지.
// =================================================================
#include <Arduino.h>
#include <Preferences.h>
#include <esp_system.h>
#include "soc/rtc_cntl_reg.h"   // RTC_CNTL_BROWN_OUT_REG (HW팀 요구: BOD 비활성)
#include "config.h"
#include "buzzer.h"
#include "lte.h"
#include "hw_power.h"
#include "loopwdt.h"

static uint32_t bootMs = 0;
static uint32_t g_rstBr=0, g_rstIw=0, g_rstTw=0, g_rstPn=0, g_rstSw=0, g_rstOt=0, g_rstOtr=0;

static uint32_t upS() { return (millis() - bootMs) / 1000; }

void setup() {
  bootMs = millis();
  setCpuFrequencyMhz(40);                      // ★[2026-07-13] CPU 40MHz (XTAL 직결, 전류/전력 트랜지언트↓)
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);   // ★[HW팀 요구] BOD(브라운아웃 검출기) 비활성
  buzzer::init();                 // GPIO1 즉시 LOW (부저 boot-floating 방지)
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);       // non-blocking CDC (리더 없어도 hang 안 함)
  delay(1500);
  Serial.printf("\n[CFG] CPU=%luMHz | BOD=disabled | MODEM_PWR_DELAY=%lums | CAL=576\n",
                (unsigned long)getCpuFrequencyMhz(), (unsigned long)MODEM_PWR_DELAY_MS);

  esp_reset_reason_t rr = esp_reset_reason();

  // ===== HW-DIAG: NVS 크래시 카운터 + per-reason(br/iw/tw/pn/sw/ot) + 배너 + 부저 =====
  {
    Preferences pf; pf.begin("hwdiag", false);
    uint32_t crashes = pf.getUInt("crashes", 0);
    uint32_t boots   = pf.getUInt("boots", 0) + 1;
    bool isCrash = (rr != ESP_RST_POWERON && rr != ESP_RST_DEEPSLEEP
                    && rr != ESP_RST_USB && rr != ESP_RST_JTAG && rr != ESP_RST_SW);
    if (rr == ESP_RST_POWERON) { crashes = 0; boots = 1; }
    else if (isCrash) crashes++;
    pf.putUInt("crashes", crashes); pf.putUInt("boots", boots);
    if (rr == ESP_RST_POWERON) {
      pf.putUInt("br",0); pf.putUInt("iw",0); pf.putUInt("tw",0);
      pf.putUInt("pn",0); pf.putUInt("sw",0); pf.putUInt("ot",0); pf.putUInt("otr",0);
    } else {
      const char* k = nullptr;
      switch (rr) {
        case ESP_RST_BROWNOUT: k="br"; break;   // 브라운아웃(전원)
        case ESP_RST_INT_WDT:  k="iw"; break;   // INT-WDT(클럭스톨)
        case ESP_RST_TASK_WDT: k="tw"; break;   // Task-WDT
        case ESP_RST_PANIC:    k="pn"; break;   // panic
        case ESP_RST_SW:       k="sw"; break;   // SW
        case ESP_RST_DEEPSLEEP: case ESP_RST_USB: case ESP_RST_JTAG: break;
        default: k="ot"; pf.putUInt("otr",(uint32_t)rr); break;  // 기타(UNKNOWN 등) + 원시번호
      }
      if (k) pf.putUInt(k, pf.getUInt(k,0)+1);
    }
    g_rstBr=pf.getUInt("br",0); g_rstIw=pf.getUInt("iw",0); g_rstTw=pf.getUInt("tw",0);
    g_rstPn=pf.getUInt("pn",0); g_rstSw=pf.getUInt("sw",0); g_rstOt=pf.getUInt("ot",0); g_rstOtr=pf.getUInt("otr",0);
    pf.end();
    Serial.println();
    Serial.println("========================================================");
    Serial.println("  LTE-ONLY 임시 진단본 | ESP32-C3 (LTE만 구동, GPS/모션/슬립 없음)");
    Serial.printf ("  reset=%d boots=%lu  >>> CRASHES=%lu <<<\n", (int)rr,(unsigned long)boots,(unsigned long)crashes);
    Serial.printf ("  RST[br=%lu iw=%lu tw=%lu pn=%lu sw=%lu ot=%lu#%lu]\n",
                   (unsigned long)g_rstBr,(unsigned long)g_rstIw,(unsigned long)g_rstTw,
                   (unsigned long)g_rstPn,(unsigned long)g_rstSw,(unsigned long)g_rstOt,(unsigned long)g_rstOtr);
    Serial.println(isCrash ? "  *** 방금 CRASH 로 재부팅됨 (긴삐 3회) ***"
                   : (rr==ESP_RST_POWERON ? "  clean power-on (카운터 리셋)" : "  boot"));
    Serial.println("  LTE bringUp + 2s POST(TX) 반복. 크래시가 POST/TX 와 겹치면 = LTE/전원 상관 ↑");
    Serial.println("========================================================");
    Serial.flush();
    if (isCrash) { buzzer::beep(3,500,250); buzzer::flush(2200); }           // 크래시 = 긴삐 3회 (flush 2200: 3회 다 울리게)
    else if (rr==ESP_RST_POWERON) { buzzer::beep(1,600,0); buzzer::flush(); } // 클린 전원 1회
  }

  lwdt::arm();

  // ★[콜드 스트레서 분산 2026-07-13] 모뎀 railOn 을 늦춰 ESP 부팅+RTC캘리 취약창과 시간분리.
  //   콜드-스타트 크래시 루프 = 첫 ~수초에 (RTC캘리)×(모뎀 인러시+어태치)×(충전IC) 겹침 → 지연으로 분산.
  //   WDT 재부팅에도 같은 지연 적용 → 연쇄 루프 차단 기대. (신모듈 auto-boot라 railOn=모뎀기동 트리거)
#if MODEM_PWR_DELAY_MS > 0
  Serial.printf("[LTE-ONLY] 모뎀 전원 지연 %lums (부팅/RTC캘리 안정 후 railOn)...\n", (unsigned long)MODEM_PWR_DELAY_MS);
  Serial.flush();
  { uint32_t t0d = millis(); while (millis() - t0d < (uint32_t)MODEM_PWR_DELAY_MS) { lwdt::feed(); delay(100); } }
#endif
  // PWR_EN=LOW 로 공유 레일 ON (데모 PCB 는 GPIO6 게이팅 → railOn 필요; 하드ON 보드면 중복무해).
  hw_power::railOn();   // PWR_EN LOW + inrush settle (GPS+LTE 공유 레일 ON)
  pinMode(PIN_DTR,    OUTPUT); digitalWrite(PIN_DTR,    LTE_DTR_IDLE);    // 데모=HIGH(ACTIVE)
  pinMode(PIN_PWRKEY, OUTPUT); digitalWrite(PIN_PWRKEY, LTE_PWRKEY_IDLE); // idle HIGH
  Serial.println("[LTE-ONLY] railOn(PWR_EN=LOW) + DTR(HIGH)/PWRKEY(idle HIGH) → lte::init()");
  lte::init();   // UART begin + powerOn(probe + 필요시 PWRKEY 펄스)
  Serial.println("[LTE-ONLY] init done → bringUp + POST(TX) 부하 시작");
}

void loop() {
  lwdt::feed();
  static uint32_t postN=0, lastPost=0, lastStatus=0;

  // --- 미등록: bringUp 반복 (hardCycle 은 호출 안 함 = GPIO6 안 건드림) ---
  if (!lte::ready()) {
    lte::refresh();   // [데모 진단 2026-07-11] 등록 전에도 CSQ/REG/CBC(VBAT) 갱신 → 배터리 VBAT 관측
    Serial.printf("[t=%lus] LTE bringUp... (CSQ=%d REG=%d vbat=%dmV) RST[br=%lu iw=%lu tw=%lu pn=%lu sw=%lu ot=%lu#%lu]\n",
                  upS(), lte::csq(), lte::reg(), lte::modemVbatMv(),
                  (unsigned long)g_rstBr,(unsigned long)g_rstIw,(unsigned long)g_rstTw,
                  (unsigned long)g_rstPn,(unsigned long)g_rstSw,(unsigned long)g_rstOt,(unsigned long)g_rstOtr);
    if (lte::bringUp()) { lte::fetchSimInfo(); Serial.printf("[t=%lus] LTE ONLINE CSQ=%d REG=%d\n", upS(), lte::csq(), lte::reg()); }
    else delay(1200);
    return;
  }

  // --- LTE 부하: 2초마다 POST(TX) ---
  if (millis() - lastPost >= 2000) {
    lastPost = millis(); postN++;
    lte::refresh();               // CSQ/REG/CBC 갱신
    char body[160];
    snprintf(body, sizeof(body), "{\"test\":\"lte-only\",\"t\":%lu,\"n\":%lu,\"csq\":%d,\"reg\":%d}",
             (unsigned long)upS(),(unsigned long)postN,lte::csq(),lte::reg());
    int st=-1; uint32_t t0=millis();
    Serial.printf("[t=%lus] POST #%lu TX 시작 CSQ=%d ...\n", upS(),(unsigned long)postN,lte::csq());
    bool ok = lte::httpPost(body, &st);
    Serial.printf("[t=%lus] POST #%lu status=%d elapsed=%lums ok=%d conn=%d\n",
                  upS(),(unsigned long)postN,st,(unsigned long)(millis()-t0),(int)ok,(int)lte::httpConnected());
    // ★[2026-07-13 부저맵] 정상통신(POST200)=짧은삐1회(주기적) / 비정상=짧은삐4회
    if (ok && st == 200) { buzzer::beep(1, 60, 0);  buzzer::flush(300); }
    else                 { buzzer::beep(4, 80, 80); buzzer::flush(800); }
  }

  // --- STATUS 1초 (크래시 타임라인 + RST 카운터 상시) ---
  if (millis() - lastStatus >= 1000) {
    lastStatus = millis();
    Serial.printf("[STATUS %lus] LTE:%s CSQ=%d REG=%d cbc=%dmV | RST[br=%lu iw=%lu tw=%lu pn=%lu sw=%lu ot=%lu#%lu]\n",
                  upS(), lte::ready()?"OK":"--", lte::csq(), lte::reg(), lte::modemVbatMv(),
                  (unsigned long)g_rstBr,(unsigned long)g_rstIw,(unsigned long)g_rstTw,
                  (unsigned long)g_rstPn,(unsigned long)g_rstSw,(unsigned long)g_rstOt,(unsigned long)g_rstOtr);
  }
  delay(20);
}
