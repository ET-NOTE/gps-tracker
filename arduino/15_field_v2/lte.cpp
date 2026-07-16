#include "lte.h"
#include "config.h"
#include "hw_power.h"
#include "breadcrumb.h"
#include "loopwdt.h"
#include <HardwareSerial.h>
#include <ctype.h>

namespace lte {

static HardwareSerial serial(1);   // UART1 — LTE RX=2/TX=4
static String   lastResp;
static bool     ready_        = false;
static int      csq_          = -1;
static int      reg_          = -1;
static char     ip_[24]       = "-";
static uint16_t bringUpCount_ = 0;
static char     iccid_[24]    = "";
static char     imei_[20]     = "";
static char     imsi_[20]     = "";
static uint32_t firstAtOkMs_  = 0;
static int      modemVbatMv_  = -1;   // (2026-07-02) AT+CBC — 모뎀이 보는 VBAT (ESP divider 교차검증)

// HTTP keepalive + 서버 cmd 상태 (Block 6)
static bool     httpConfigured_ = false;
static bool     httpConnected_  = false;
static uint32_t postIntervalMs_ = POST_INTERVAL_DEFAULT_MS;
static bool     serverBeep_     = false;
static bool     serverReset_    = false;

// -----------------------------------------------------------------
static void drain() {
  while (serial.available()) {
    char c = (char)serial.read();
    lastResp += c;
    if (lastResp.length() > 2048) lastResp.remove(0, 1024);
  }
}

static bool healthy() {
  if (lastResp.indexOf("UNDER-VOLTAGE") >= 0) return false;
  if (lastResp.indexOf("POWER DOWN")    >= 0) return false;
  return true;
}

// AT 트랜잭션. expect=nullptr 면 timeout 까지 대기 후 true.
// ※ 원본의 esp_task_wdt_reset() feed 없음 — no-op 이라 제거 (2026-07-02).
static bool sendAT(const char *cmd, const char *expect, uint32_t timeoutMs) {
  lastResp = "";
  if (cmd && *cmd) {
    if (DBG) { Serial.print(F(">> ")); Serial.println(cmd); }
    serial.print(cmd); serial.print("\r\n");
  }
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    lwdt::feed();   // 정상 AT 대기는 hang 아님 — 워치독 오탐 방지
    drain();
    if (!healthy()) {
      if (DBG) { Serial.print(F("<< (UV abort) ")); Serial.println(lastResp); }
      return false;
    }
    if (expect && lastResp.indexOf(expect) >= 0) {
      if (DBG) { Serial.print(F("<< ")); Serial.println(lastResp); }
      return true;
    }
    delay(5);
  }
  if (DBG && cmd && *cmd) { Serial.print(F("<< (timeout) ")); Serial.println(lastResp); }
  return expect == nullptr;
}

static void waitUartIdle(uint32_t idleMs, uint32_t maxWaitMs) {
  uint32_t lastByte = millis(), t0 = millis();
  while (millis() - t0 < maxWaitMs) {
    while (serial.available()) { serial.read(); lastByte = millis(); }
    if (millis() - lastByte >= idleMs) return;
    delay(10);
  }
}

// SHBOD 후 '>' 프롬프트 대기 → body 전송 → OK.
static bool sendBodyAfterPrompt(const char *body, uint32_t len) {
  uint32_t t0 = millis();
  lastResp = "";
  while (millis() - t0 < 3000) {
    drain();
    if (lastResp.indexOf('>') >= 0) break;
    delay(5);
  }
  if (lastResp.indexOf('>') < 0) return false;
  serial.write((const uint8_t *)body, len);
  return sendAT("", "OK", SHBODY_MAXWAIT_MS);
}

// (P3 2026-07-03) 모뎀 생명신호 판별. AT 를 주기적으로 쏘며 maxWaitMs 동안 관찰.
//   MP_READY: AT+OK 확인(AT 채널 준비됨).  MP_BOOTING: 부팅 URC/바이트만 봄(살아있으나 AT 미동기).
//   MP_SILENT: 어떤 바이트도 없음(전원 off 추정).
enum ModemPresence { MP_SILENT, MP_BOOTING, MP_READY };
static ModemPresence probeModem(uint32_t maxWaitMs) {
  uint32_t t0 = millis(), lastPing = 0;
  bool sawByte = false, sawBootUrc = false;
  lastResp = "";
  while (millis() - t0 < maxWaitMs) {
    lwdt::feed();   // 모뎀 부팅 대기는 hang 아님 — 워치독 오탐 방지
    if (millis() - lastPing >= 800) {          // 주기적 AT ping (부팅 후 동기)
      serial.print("AT\r\n"); lastPing = millis();
    }
    size_t before = lastResp.length();
    drain();
    if (lastResp.length() > before) sawByte = true;
    if (lastResp.indexOf("OK") >= 0) return MP_READY;
    if (lastResp.indexOf("RDY") >= 0 || lastResp.indexOf("+CPIN:") >= 0 ||
        lastResp.indexOf("SMS Ready") >= 0)   sawBootUrc = true;
    delay(10);
  }
  return (sawBootUrc || sawByte) ? MP_BOOTING : MP_SILENT;
}

static void powerOn() {
  bc::set("lte_poweron");
  // hw_power::init() 이 DTR/PWRKEY idle, railOn() 이 전원 ON 을 이미 수행한 상태 가정.
  //
  // (P3 2026-07-03) 운행 로그 진단: bringup ~200s stuck 의 원인 = 모뎀이 부팅중 URC
  //   (+CPIN READY / SMS Ready)를 뿜는데 AT 는 아직 무응답 → 예전 코드가 AT timeout 만 보고
  //   pulsePwrKey() 했고, 켜진 SIM7080 의 PWRKEY 펄스는 전원 토글(=종료)이라 부팅↔종료 레이스로 stuck.
  //   ⇒ 생명신호(URC/AT/바이트)가 보이면 절대 펄스하지 않고 부팅 완료(AT OK)만 대기.
  //   ⇒ 완전 무응답(MP_SILENT, 전원 off 추정)일 때만 PWRKEY 1회. 두 번 펄스 금지.
  //   ⇒ 부팅중인데 끝내 AT 안 붙으면 펄스 대신 반환 → 상위 recovery 의 railCycle(전원 레일 재순환)이 정리.
  ModemPresence mp = probeModem(LTE_BOOT_PROBE_MS);
  if (mp == MP_READY) { DBGLN(F("[LTE] already on")); return; }
  if (mp == MP_BOOTING) {
    DBGLN(F("[LTE] alive/booting (URC seen) — waiting AT, no PWRKEY"));
    probeModem(LTE_BOOT_WAIT_MS);          // 부팅완료까지 AT 동기 시도(펄스 없음)
    return;
  }
  DBGLN(F("[LTE] silent → pulse PWRKEY (power-on)"));   // MP_SILENT: 전원 off 추정
  hw_power::pulsePwrKey();
  probeModem(LTE_BOOT_WAIT_MS);            // 켜지고 부팅 URC→AT OK 대기
}

// -----------------------------------------------------------------
void init() {
  serial.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);
  powerOn();
}

bool bringUp() {
  bc::set("lte_bringup");
  if (!sendAT("AT", "OK", 2000)) return false;
  if (firstAtOkMs_ == 0) firstAtOkMs_ = millis();
  sendAT("ATE0", "OK", 1000);
  sendAT("AT+CMEE=2", "OK", 1000);
  sendAT("AT+CPIN?", "READY", 5000);
  sendAT("AT+CGNSPWR=0", "OK", 2000);

  if (sendAT("AT+CSQ", "+CSQ:", 1500)) {
    int p = lastResp.indexOf("+CSQ:");
    csq_ = lastResp.substring(p + 5).toInt();
  }

  uint32_t t0 = millis();
  while (millis() - t0 < LTE_REG_WAIT_MS) {
    if (sendAT("AT+CEREG?", "OK", 2000)) {
      int p = lastResp.indexOf("+CEREG:");
      if (p >= 0) {
        int comma = lastResp.indexOf(',', p);
        if (comma >= 0) {
          reg_ = lastResp.substring(comma + 1).toInt();
          if (reg_ == 1 || reg_ == 5) break;
        }
      }
    }
    Serial.printf("[LTE] waiting reg… csq=%d reg=%d (%lus)\n",
      csq_, reg_, (unsigned long)((millis() - t0) / 1000));
    delay(2000);
  }
  if (reg_ != 1 && reg_ != 5) return false;

  sendAT("AT+CNACT=0,0", "OK", 3000);
  delay(300);
  String c = String("AT+CNCFG=0,1,\"") + APN_NAME + "\"";
  sendAT(c.c_str(), "OK", 2000);
  bool pdp = sendAT("AT+CNACT=0,1", "ACTIVE", LTE_CNACT_TIMEOUT_MS);

  if (sendAT("AT+CNACT?", "+CNACT:", 2000)) {
    int p = lastResp.indexOf("+CNACT: 0,");
    if (p >= 0) {
      int sp = p + 10;
      if (lastResp.substring(sp, sp + 1).toInt() == 1) pdp = true;
    }
    int q1 = lastResp.indexOf('"');
    int q2 = lastResp.indexOf('"', q1 + 1);
    if (q1 > 0 && q2 > q1) {
      String ip = lastResp.substring(q1 + 1, q2);
      ip.toCharArray(ip_, sizeof(ip_));
      if (ip.length() > 0 && ip != "0.0.0.0") pdp = true;
    }
  }

  ready_ = pdp;
  if (pdp) bringUpCount_++;
  return pdp;
}

void refresh() {
  if (sendAT("AT+CSQ", "+CSQ:", 1500)) {
    int p = lastResp.indexOf("+CSQ:");
    if (p >= 0) csq_ = lastResp.substring(p + 5).toInt();
  }
  if (sendAT("AT+CEREG?", "+CEREG:", 1500)) {
    int p = lastResp.indexOf("+CEREG:");
    if (p >= 0) { int c = lastResp.indexOf(',', p); if (c > 0) reg_ = lastResp.substring(c + 1).toInt(); }
  }
  // AT+CBC — 모뎀 VBAT. SIM7080 실측 "+CBC: <bcs>,<bcl>,<mV>" (예: 0,100,4808).
  //   ※ expect="OK" 로 대기 — "+CBC:" 매칭 시점엔 값이 아직 안 도착해 빈 파싱되는 race 회피.
  if (sendAT("AT+CBC", "OK", 1500)) {
    int p = lastResp.indexOf("+CBC:");
    if (p >= 0) {
      String s = lastResp.substring(p + 5);
      int lc = s.lastIndexOf(',');          // 3-field 이면 마지막 필드가 전압
      String num = (lc >= 0) ? s.substring(lc + 1) : s;
      num.trim();
      float v = num.toFloat();
      if (v > 0) modemVbatMv_ = (v < 100) ? (int)(v * 1000) : (int)v;   // volts→mV or mV
    }
  }
}

// (P1 2026-07-02) 등록 유지한 채 data-plane 만 복구. "reg=5 but conn=0" 대응 — CFUN 안 함.
bool reactivateData() {
  bc::set("lte_reactivate");
  DBGLN(F("[LTE] data 재활성 (PDP/SHCONN, CFUN 안 함)"));
  resetHttpKeepalive();
  sendAT("AT+SHDISC", nullptr, 1500);
  sendAT("AT+CNACT=0,0", "OK", 3000);
  delay(300);
  String c = String("AT+CNCFG=0,1,\"") + APN_NAME + "\"";
  sendAT(c.c_str(), "OK", 2000);
  bool pdp = sendAT("AT+CNACT=0,1", "ACTIVE", LTE_CNACT_TIMEOUT_MS);
  if (sendAT("AT+CNACT?", "+CNACT:", 2000)) {
    int p = lastResp.indexOf("+CNACT: 0,");
    if (p >= 0) { int sp = p + 10; if (lastResp.substring(sp, sp + 1).toInt() == 1) pdp = true; }
    int q1 = lastResp.indexOf('"');
    int q2 = lastResp.indexOf('"', q1 + 1);
    if (q1 > 0 && q2 > q1) {
      String ip = lastResp.substring(q1 + 1, q2);
      ip.toCharArray(ip_, sizeof(ip_));
      if (ip.length() > 0 && ip != "0.0.0.0") pdp = true;
    }
  }
  Serial.printf("[LTE] reactivate → pdp=%d ip=%s\n", (int)pdp, ip_);
  return pdp;   // ready_ 는 건드리지 않음 (등록 유지, 온라인 상태 지속)
}

bool softReset() {
  bc::set("lte_softreset");
  DBGLN(F("[LTE] soft reset (CFUN 0→1 + COPS=0)"));
  sendAT("AT+CFUN=0", "OK", 3000);
  delay(500);
  bool ok = sendAT("AT+CFUN=1", "OK", 5000);
  delay(1000);
  sendAT("AT+COPS=0", "OK", 2000);   // (P1) 자동 operator 재선택 → 재등록 촉진 (CFUN 후 REG=0 stuck 완화)
  ready_ = false; csq_ = -1; reg_ = -1;
  resetHttpKeepalive();   // CFUN cycle → SHCONN 끊김
  return ok;
}

void hardCycle() {
  bc::set("lte_hardcycle");
  Serial.printf("[LTE] hard cycle (railOff %.0fs 방전 + power-on)\n", PWR_CYCLE_OFF_MS / 1000.0);
  hw_power::railCycle();
  powerOn();
  ready_ = false;
  resetHttpKeepalive();   // 모듈 power-cycle → HTTP state 전부 초기화
}

// -----------------------------------------------------------------
static void extractDigits(const String &src, char *out, size_t cap, size_t minLen, size_t maxLen) {
  out[0] = 0;
  size_t n = src.length(), i = 0;
  while (i < n) {
    while (i < n && !isxdigit((int)src[i])) i++;
    size_t start = i;
    while (i < n && isxdigit((int)src[i])) i++;
    size_t len = i - start;
    if (len >= minLen) {
      size_t take = (len > maxLen) ? maxLen : len;
      if (take >= cap) take = cap - 1;
      for (size_t j = 0; j < take; j++) out[j] = src[start + j];
      out[take] = 0;
      return;
    }
  }
}

void fetchSimInfo() {
  if (iccid_[0] && imei_[0]) return;
  if (iccid_[0] == 0) {
    sendAT("AT+CICCID", "OK", 2000); extractDigits(lastResp, iccid_, sizeof(iccid_), 18, 22);
    if (iccid_[0] == 0) { sendAT("AT+CCID", "OK", 2000);  extractDigits(lastResp, iccid_, sizeof(iccid_), 18, 22); }
    if (iccid_[0] == 0) { sendAT("AT+QCCID", "OK", 2000); extractDigits(lastResp, iccid_, sizeof(iccid_), 18, 22); }
  }
  if (imei_[0] == 0) { sendAT("AT+CGSN", "OK", 2000); extractDigits(lastResp, imei_, sizeof(imei_), 14, 16); }
  if (imsi_[0] == 0) { sendAT("AT+CIMI", "OK", 2000); extractDigits(lastResp, imsi_, sizeof(imsi_), 14, 16); }
  Serial.printf("[SIM] iccid=%s imei=%s imsi=%s\n", iccid_, imei_, imsi_);
}

// ── HTTP (Block 6) ───────────────────────────────────────────────
void resetHttpKeepalive() {
  httpConfigured_ = false;
  httpConnected_  = false;
}

// (P4 2026-07-03) CNACT? 파싱 → 베어러가 실제 활성(0,1,<non-zero ip>)인지 확인.
//   운행 로그 진단: SHCONN "operation not allowed" 의 주원인 = handover 로 CNACT 베어러가
//   조용히 죽었는데 CNACT? 확인 없이 SHCONN 을 쏨. 죽은 베어러 위 SHCONN 은 무조건 거부.
static bool bearerActive() {
  if (!sendAT("AT+CNACT?", "+CNACT:", 2000)) return false;
  int p = lastResp.indexOf("+CNACT: 0,");
  if (p < 0) return false;
  if (lastResp.substring(p + 10, p + 11).toInt() != 1) return false;   // status 0,<1>
  int q1 = lastResp.indexOf('"', p);
  int q2 = lastResp.indexOf('"', q1 + 1);
  if (q1 > 0 && q2 > q1) {
    String ip = lastResp.substring(q1 + 1, q2);
    return (ip.length() > 0 && ip != "0.0.0.0");
  }
  return false;
}

// SHCONF/SHSSL — host 고정이라 세션당 1회. 성공 시 httpConfigured_ 는 호출측이 세팅.
static bool configureHttp() {
  char cmd[96];
  sendAT("AT+CGNSPWR=0", "OK", 1000);
  waitUartIdle(200, 1000);
  sendAT("AT+SHDISC", nullptr, 800);            // 잔류 연결 정리
  waitUartIdle(200, 1000);
  snprintf(cmd, sizeof(cmd), "AT+SHCONF=\"URL\",\"%s\"", POST_URL_HOST);
  if (!sendAT(cmd, "OK", 2000)) return false;
  sendAT("AT+SHCONF=\"BODYLEN\",4096",  "OK", 2000);
  sendAT("AT+SHCONF=\"HEADERLEN\",350", "OK", 2000);
  sendAT("AT+SHSSL=0,\"\"", "OK", 2000);
  return true;
}

// (P4) SHCONN 견고화: ①베어러 실활성 확인(죽었으면 재활성) ②SHCONF 보장 ③잔류 SHDISC
//   ④SHCONN. "operation not allowed" 면 fresh 베어러로 같은 호출 내 1회 재시도(30s 대기 없이
//   두절 단축). 2회 실패면 return false — batch 버퍼가 무손실 보장, 다음 사이클 재시도.
static bool connectHttp() {
  for (int attempt = 0; attempt < 2; attempt++) {
    if (!bearerActive()) {
      DBGLN(F("[POST] bearer down → reactivateData"));
      if (!reactivateData()) return false;      // 재활성 실패 → 다음 사이클
      httpConfigured_ = false;                  // 재활성이 SHDISC/CNACT 재설정 → SHCONF 재적용 필요
    }
    if (!httpConfigured_) {
      if (!configureHttp()) return false;
      httpConfigured_ = true;
    }
    sendAT("AT+SHDISC", nullptr, 800);          // 매 연결 전 잔류 세션 정리 (not-allowed 예방)
    waitUartIdle(150, 800);
    bc::set("lte_shconn");                      // (crash 위치 특정) SHCONN 진입 — 오전 stuck 지점
    if (sendAT("AT+SHCONN", "OK", SHCONN_TIMEOUT_MS)) {
      httpConnected_ = true;
      return true;
    }
    DBGLN(F("[POST] SHCONN fail → 베어러 재활성 후 재시도"));
    reactivateData();
    httpConfigured_ = false;
  }
  return false;
}

bool httpPost(const char *body, int *statusOut) {
  bc::set("lte_post");
  char cmd[96];
  *statusOut = -1;

  if (!sendAT("AT", "OK", 1500)) { DBGLN(F("[POST] module unresponsive")); return false; }

  // keepalive 가정 vs 실제 conn sync (SIM7080G 가 매 SHREQ 후 auto-disconnect 하는 경우 대비)
  if (httpConnected_) {
    sendAT("AT+SHSTATE?", "+SHSTATE:", 1500);
    if (lastResp.indexOf("+SHSTATE: 1") < 0 && lastResp.indexOf("+SHSTATE:1") < 0) {
      DBGLN(F("[POST] SHSTATE 0 — server-side close, reconnect"));
      httpConnected_ = false;
    }
  }
  // (P4 2026-07-03) 연결이 없으면 견고 연결 시퀀스로. connectHttp() 가 베어러 확인 +
  //   SHCONF 보장 + 잔류 SHDISC + SHCONN(2회 재시도)를 처리. 실패 시 batch 무손실 후 다음 사이클.
  if (!httpConnected_) {
    if (!connectHttp()) return false;
  }

  sendAT("AT+SHCHEAD", "OK", 2000);
  sendAT("AT+SHAHEAD=\"Content-Type\",\"application/json\"", "OK", 2000);

  size_t len = strlen(body);
  snprintf(cmd, sizeof(cmd), "AT+SHBOD=%u,10000", (unsigned)len);
  if (DBG) { Serial.print(F(">> ")); Serial.println(cmd); }
  bc::set("lte_shbod");                        // (crash 위치 특정) body 전송 단계
  serial.print(cmd); serial.print("\r\n");
  if (!sendBodyAfterPrompt(body, len)) {
    DBGLN(F("[POST] SHBOD fail"));
    sendAT("AT+SHDISC", "OK", 3000);
    resetHttpKeepalive();
    return false;
  }

  snprintf(cmd, sizeof(cmd), "AT+SHREQ=\"%s\",3", POST_PATH);
  bc::set("lte_shreq");                         // (crash 위치 특정) POST 요청/응답 대기 단계
  if (!sendAT(cmd, "+SHREQ:", SHREQ_TIMEOUT_MS)) {
    DBGLN(F("[POST] SHREQ fail"));
    sendAT("AT+SHDISC", "OK", 3000);
    resetHttpKeepalive();
    return false;
  }

  int p  = lastResp.indexOf("+SHREQ:");
  int c1 = lastResp.indexOf(',', p);
  int c2 = lastResp.indexOf(',', c1 + 1);
  if (c1 > 0 && c2 > c1) *statusOut = lastResp.substring(c1 + 1, c2).toInt();
  DBGP(F("[POST] HTTP ")); DBGLN(*statusOut);

  // 응답 body → 서버 cmd (beep/reset 은 플래그로, main 이 처리)
  if (c2 > c1) {
    int rlen = lastResp.substring(c2 + 1).toInt();
    if (rlen > 0 && rlen < 512) {
      char rc[40];
      snprintf(rc, sizeof(rc), "AT+SHREAD=0,%d", rlen);
      if (sendAT(rc, "+SHREAD:", 5000)) {
        uint32_t t0 = millis();
        while (millis() - t0 < 500) { drain(); delay(10); }
        if (lastResp.indexOf("\"cmd\":\"beep\"")  >= 0 || lastResp.indexOf("\"cmd\": \"beep\"")  >= 0) serverBeep_  = true;
        if (lastResp.indexOf("\"cmd\":\"reset\"") >= 0 || lastResp.indexOf("\"cmd\": \"reset\"") >= 0) serverReset_ = true;
        int pi = lastResp.indexOf("\"post_interval_s\":");
        if (pi < 0) pi = lastResp.indexOf("\"post_interval_s\" :");
        if (pi >= 0) {
          int colon = lastResp.indexOf(':', pi);
          if (colon > 0) {
            int sec = lastResp.substring(colon + 1).toInt();
            if (sec >= POST_INTERVAL_MIN_S && sec <= POST_INTERVAL_MAX_S) {
              postIntervalMs_ = (uint32_t)sec * 1000UL;
              Serial.printf("[POST] interval ← %ds (server cmd)\n", sec);
            }
          }
        }
      }
    }
  }
  return true;   // SHDISC 안 함 — keepalive (다음 SHREQ 즉시 재사용)
}

bool     httpConnected()  { return httpConnected_; }
uint32_t postIntervalMs() { return postIntervalMs_; }
bool consumeServerBeep()  { bool b = serverBeep_;  serverBeep_  = false; return b; }
bool consumeServerReset() { bool b = serverReset_; serverReset_ = false; return b; }

// -----------------------------------------------------------------
bool     ready()        { return ready_; }
int      csq()          { return csq_; }
int      reg()          { return reg_; }
const char* ip()        { return ip_; }
uint16_t bringUpCount() { return bringUpCount_; }
uint32_t firstAtOkMs()  { return firstAtOkMs_; }
int      modemVbatMv()  { return modemVbatMv_; }
const char* iccid()     { return iccid_; }
const char* imei()      { return imei_; }
const char* imsi()      { return imsi_; }

} // namespace lte
