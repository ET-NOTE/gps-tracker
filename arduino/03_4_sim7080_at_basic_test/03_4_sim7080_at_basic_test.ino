// 03_4 — SIM7080G LTE 모듈 단독 living-check (실내 OK).
//
// 목적: AT 명령에 OK 응답하는지만 확인 (네트워크 등록과 무관).
//   - 실내: SIM/안테나/네트워크 등록은 별개. AT 응답은 모듈 UART/전원 OK 면 무조건 옴.
//   - "device found" 수준 = "OK" 또는 "AT" echo 한 번이라도 들어오면 통과.
//
// 핀: PWR_EN=GPIO6 (LOW=ON, GPS 와 공유), PWRKEY=GPIO7, RX=GPIO2, TX=GPIO4, DTR=GPIO10, baud 115200.
//      (PCB rev 후 13_2 firmware 와 동일: ESP RX=GPIO2 ← SIM TX, ESP TX=GPIO4 → SIM RX)
//
// 전원 시퀀스:
//   1) PWR_EN LOW (VBAT 공급)
//   2) DTR LOW (low-power mode 비활성)
//   3) PWRKEY HIGH(idle) → LOW 1.5s → HIGH (전원 토글 펄스)
//   4) 5~10초 부팅 대기
//
// 출력 (시리얼 115200):
//   - 5초마다 "AT\r\n" 전송
//   - 모듈에서 들어오는 모든 바이트 echo
//   - 1초마다 헬스라인: 누적 bytes, OK 카운트, ERROR 카운트

#include <HardwareSerial.h>

#define PIN_PWR_EN  6
#define PIN_PWRKEY  7
#define PIN_DTR    10
#define PIN_LTE_RX  2   // ESP 받는 쪽 (SIM TX -> ESP RX)  ← rev (was 4)
#define PIN_LTE_TX  4   // ESP 보내는 쪽 (ESP TX -> SIM RX) ← rev (was 2)
#define LTE_BAUD   115200UL

HardwareSerial lte(1);

uint32_t totalBytes = 0;
uint32_t cntOK = 0;
uint32_t cntERROR = 0;
uint32_t cntATEcho = 0;
uint32_t lastByteMs = 0;

// 상태 (한글 종합용)
bool haveAnyResp = false;   // 응답 1바이트라도 받은 적
bool haveRDY     = false;   // RDY (모듈 부팅 완료 indicator)
bool haveCFUN    = false;   // +CFUN: 1 (full functionality)
bool haveCPIN    = false;   // +CPIN: READY (SIM 인식)

char line[200];
uint16_t lineLen = 0;

// 들어온 1줄 → 카운트 + 상태 + 한글 태그 반환
static const char* parseAndDiagnose(const char* l) {
  haveAnyResp = true;

  // "OK" — 가장 핵심 (단독 라인). strstr 로 잡으면 "OKAY" 등도 잡혀버려서 strcmp 정확하게.
  if (strcmp(l, "OK") == 0) {
    cntOK++;
    return "  ✅ OK — AT 명령 응답 정상";
  }
  if (strstr(l, "ERROR")) {
    cntERROR++;
    static char tag[96];
    snprintf(tag, sizeof(tag), "  ❌ ERROR — 명령 실패 (\"%s\")", l);
    return tag;
  }
  if (strncmp(l, "AT", 2) == 0) {
    cntATEcho++;
    return "  ↩  AT echo (모듈이 명령 수신함)";
  }
  if (strcmp(l, "RDY") == 0) {
    haveRDY = true;
    return "  🚀 RDY — 모듈 부팅 완료";
  }
  if (strncmp(l, "+CFUN:", 6) == 0) {
    haveCFUN = true;
    static char tag[96];
    snprintf(tag, sizeof(tag), "  📡 %s — 무선 기능 상태", l);
    return tag;
  }
  if (strncmp(l, "+CPIN:", 6) == 0) {
    if (strstr(l, "READY")) haveCPIN = true;
    static char tag[96];
    snprintf(tag, sizeof(tag), "  💳 %s — SIM 상태", l);
    return tag;
  }
  if (strncmp(l, "+CIEV:", 6) == 0)  return "  · +CIEV: 인디케이터 이벤트";
  if (strstr(l, "SMS Ready"))        return "  📨 SMS 서브시스템 준비";
  if (strstr(l, "Call Ready"))       return "  📞 통화 서브시스템 준비";
  if (l[0] == '+')                   return "  · URC (unsolicited)";
  return nullptr;   // 다른 라인은 태그 없이
}

// 모듈이 이미 켜져있는지 AT 응답으로 확인. 1.5s 안에 "OK" 들어오면 true.
// ⚠️ PWRKEY 는 토글이라 이미 켜진 모듈에 펄스 = OFF 됨. 반드시 사전 체크.
static bool isModuleAlreadyOn() {
  // RX 버퍼 비우기
  while (lte.available()) (void)lte.read();
  lte.print("AT\r\n");
  uint32_t t0 = millis();
  char buf[64]; size_t blen = 0;
  while (millis() - t0 < 1500) {
    while (lte.available()) {
      int c = lte.read();
      if (c < 0) break;
      if (blen < sizeof(buf) - 1) buf[blen++] = (char)c;
    }
    buf[blen] = 0;
    if (strstr(buf, "OK")) return true;
  }
  return false;
}

static void pulsePwrKey() {
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, HIGH);
  delay(100);
  digitalWrite(PIN_PWRKEY, LOW);
  delay(1500);
  digitalWrite(PIN_PWRKEY, HIGH);
}

static void powerOnSequence() {
  // 13_1 의 setup → ltePowerOn 시퀀스 그대로 미러링.
  // 핵심: 강제 cycle (HIGH→LOW) 안 함. fresh first-time 은 LOW 만으로 충분.

  // (a) PWR_EN LOW — VBAT 공급 (toggle X)
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);
  Serial.println(F("[PWR] (a) PWR_EN -> LOW (VBAT)"));

  // (b) DTR LOW — low-power 비활성
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, LOW);
  Serial.println(F("[PWR] (b) DTR -> LOW"));

  // (c) 모듈 internal power 안정화 시간 (13_1 의 LIS3DH init 등 다른 작업이 차지하는 ~500ms 대용)
  delay(500);

  // (d) PWRKEY idle HIGH
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, HIGH);
  delay(200);

  // (e) UART 먼저 시작 — "이미 켜졌나" 체크 가능하게
  lte.begin(LTE_BAUD, SERIAL_8N1, PIN_LTE_RX, PIN_LTE_TX);

  if (isModuleAlreadyOn()) {
    Serial.println(F("[PWR] (e) 모듈이 이미 켜져있음 (AT 응답 OK) — PWRKEY skip"));
    return;
  }

  // (f) PWRKEY 펄스
  Serial.println(F("[PWR] (f) PWRKEY pulse"));
  pulsePwrKey();

  // (g) 5초 drain (13_1 패턴) — 부팅 메시지 폭주 흡수
  Serial.println(F("[PWR] (g) 부팅 메시지 drain 5s..."));
  uint32_t t0 = millis();
  while (millis() - t0 < 5000) {
    while (lte.available()) (void)lte.read();
    delay(5);
  }

  // (h) 다시 AT 한 번
  while (lte.available()) (void)lte.read();
  lte.print("AT\r\n");
  delay(2000);
}

void setup() {
  Serial.begin(115200);
  delay(5000);
  Serial.println();
  Serial.println(F("=== 03_4 SIM7080G basic AT response check ==="));
  Serial.printf("PWR_EN=GPIO%d  PWRKEY=GPIO%d  DTR=GPIO%d  RX=GPIO%d  TX=GPIO%d  baud=%lu\n",
                PIN_PWR_EN, PIN_PWRKEY, PIN_DTR, PIN_LTE_RX, PIN_LTE_TX, LTE_BAUD);
  Serial.println(F("실내에서 SIM/네트워크 무관 — UART 응답만 검증."));

  powerOnSequence();   // 안에서 lte.begin() + 이미-켜짐 체크까지 끝

  Serial.println(F("[UART] AT 명령 5초 주기 전송."));
  Serial.println();
  lastByteMs = millis();
}

void loop() {
  uint32_t now = millis();

  // 수신 — 라인 단위
  while (lte.available()) {
    int c = lte.read();
    if (c < 0) break;
    totalBytes++;
    lastByteMs = now;

    if (c == '\n' || c == '\r') {
      if (lineLen > 0) {
        line[lineLen] = 0;
        // 라인별 raw + 한글 태그는 노이즈 커서 주석 처리.
        // 종합 라인 ([종합] ...) 만으로 충분. 필요 시 아래 2줄 주석 해제.
        // Serial.printf("[LTE] %s\n", line);
        const char* tag = parseAndDiagnose(line);   // 카운트/상태 업데이트는 유지
        (void)tag;
        // if (tag) Serial.println(tag);
        lineLen = 0;
      }
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = (char)c;
    } else {
      lineLen = 0;
    }
  }

  // 5초마다 AT 전송 (TX 로그는 주석 — 노이즈)
  static uint32_t lastAT = 0;
  if (now - lastAT >= 5000) {
    lastAT = now;
    // Serial.println(F("[TX ] AT"));
    lte.print("AT\r\n");
  }

  // 1초마다 헬스라인 + 한글 종합
  static uint32_t lastLog = 0;
  if (now - lastLog >= 1000) {
    lastLog = now;
    uint32_t silentSecs = (now - lastByteMs) / 1000;

    // 원본 카운터 (engineer 용)
    Serial.printf("[%lus] bytes=%lu  OK=%lu  ERROR=%lu  AT_echo=%lu  silent=%lus\n",
                  now / 1000UL,
                  (unsigned long)totalBytes,
                  (unsigned long)cntOK, (unsigned long)cntERROR,
                  (unsigned long)cntATEcho,
                  (unsigned long)silentSecs);

    // 한글 종합
    Serial.print(F("[종합] "));
    if (!haveAnyResp) {
      uint32_t up = now / 1000;
      if (up < 12)        Serial.print(F("⏳ 부팅 대기 중"));
      else if (up < 30)   Serial.printf("⏳ 응답 대기 (%lus 경과)", (unsigned long)up);
      else                Serial.printf("❌ %lus 동안 응답 없음 — PWRKEY/전원/배선/baud 확인", (unsigned long)up);
    } else {
      // UART/AT 응답
      if (cntOK > 0)              Serial.printf("✅ UART OK | ✅ AT 응답 (OK %lu회)", (unsigned long)cntOK);
      else if (cntATEcho > 0)     Serial.printf("✅ UART OK | ⏳ AT echo 만 (OK 아직)");
      else                        Serial.print(F("✅ UART OK | ⏳ OK 응답 대기"));

      // 부팅 indicator
      if (haveRDY)                Serial.print(F(" | 🚀 RDY 받음"));
      // SIM 상태
      if (haveCPIN)               Serial.print(F(" | 💳 SIM READY"));
      // 에러
      if (cntERROR > 0)           Serial.printf(" | ❌ ERROR %lu회", (unsigned long)cntERROR);
    }
    Serial.println();

    if (silentSecs >= 30 && totalBytes == 0) {
      Serial.println(F(">>> 30s 동안 0 바이트 — 모듈 응답 없음."));
      Serial.println(F("    원인 후보: PWRKEY 펄스 실패 / 전원 부족 / RX·TX 배선 / baud 불일치"));
    }
  }
}
