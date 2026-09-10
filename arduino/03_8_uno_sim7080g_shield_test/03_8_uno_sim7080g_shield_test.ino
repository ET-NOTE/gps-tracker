// =====================================================================
// 03_8 — UNO R3 + SIM7080G 쉴드 검사 (HW팀 전달용 · 한글 단계별 안내)
//
// 배선: D8 <- 모뎀 TX, D9 -> 모뎀 RX, D6 -> DTR, D7 -> PWRKEY (레벨변환 필수)
// 전원: 모뎀은 반드시 별도 3.3~4.2V / 500mA 이상 + UNO 와 GND 공통
//       (UNO 3.3V 핀 분배 금지 — 한도 50mA 라 모뎀 송신 순간 전원 붕괴 실측됨)
// 모니터: 115200 baud
//
// 검사 흐름(자동): [1/5] 모뎀 통신 → [2/5] 초기 설정 → [3/5] 유심 →
//                 [4/5] 망 등록 → [5/5] 서버 전송(gps.serial.kr, HTTP 200 판정)
// 실패 시 해당 단계에서 점검 힌트를 출력하고 자동 재시도한다.
//
// ※ 서버 전송은 device_uid="uno-shield-test" 로만 보내고 유심 번호(ICCID)는
//   싣지 않는다 → 운영 단말 데이터와 절대 섞이지 않음.
// =====================================================================
#include <Arduino.h>
#include <SoftwareSerial.h>
#include <string.h>

#if !defined(ARDUINO_AVR_UNO)
#error "Select Arduino UNO (arduino:avr:uno)."
#endif

const uint8_t PIN_DTR = 6;
const uint8_t PIN_PWRKEY = 7;
// idf_caltest 신PCB 와 동일한 NPN 드라이버 기준. 직결(active-LOW) 쉴드는 false 로.
const bool PWRKEY_ACTIVE_HIGH = true;
const uint32_t MODEM_BAUD = 9600;
SoftwareSerial modem(8, 9);  // (UNO RX, UNO TX)

char line[100];
uint8_t lineLength = 0;
bool discardLine = false;
uint8_t reply = 0;              // 0=대기, 1=OK, 2=ERROR
bool simReady = false, pdpActive = false;
uint32_t modemReboots = 0;
int rssi = 99, regStat = -1, httpStatus = -1;
uint8_t stage = 1;              // 1~5 진행, 6=검사 완료(유지 감시)
uint32_t lastPollMs = 0, lastNoteMs = 0, regStartMs = 0;

// ── 수신/파싱 (화면 출력 없음 — 판정에 필요한 값만 뽑는다) ───────────────
static void receiveLines() {
  while (modem.available()) {
    const char c = (char)modem.read();
    if (c == '\r' || c == '\n') {
      if (!discardLine && lineLength) {
        line[lineLength] = '\0';
        int a, b;
        if (sscanf(line, "+CSQ: %d,%d", &a, &b) == 2) rssi = a;
        if (sscanf(line, "+CEREG: %d,%d", &a, &b) == 2) regStat = b;
        if (!strncmp(line, "+SHREQ:", 7)) {
          const char *comma = strchr(line, ',');
          if (comma) httpStatus = atoi(comma + 1);
        }
        if (!strncmp(line, "+APP PDP: 0,ACTIVE", 18)) pdpActive = true;
        if (!strncmp(line, "+CPIN:", 6)) {
          const char *v = line + 6;
          while (*v == ' ') ++v;
          simReady = !strcmp(v, "READY");
        }
        if (!strcmp(line, "OK")) reply = 1;
        else if (!strcmp(line, "ERROR") || !strncmp(line, "+CME ERROR:", 11) ||
                 !strncmp(line, "+CMS ERROR:", 11)) reply = 2;
        if (!strcmp(line, "RDY")) {   // 모뎀이 스스로 재부팅됨 — 전원 부족의 대표 증상
          simReady = false; pdpActive = false;
          ++modemReboots;
          // 극한 브라운아웃 시 RDY 연사(초당 수십 회) → 화면 도배 방지: 경고는 3초당 1회만
          static uint32_t lastWarnMs = 0;
          if (millis() - lastWarnMs < 3000) { lineLength = 0; discardLine = false; continue; }
          lastWarnMs = millis();
          Serial.print(F("[경고] 모뎀이 재부팅됨 (누적 "));
          Serial.print(modemReboots);
          Serial.print(F("회, 가동 "));
          Serial.print(millis() / 1000UL);
          Serial.println(F("초) — 전원 용량 부족 의심. 별도 전원(3.3~4.2V, 500mA 이상) 확인"));
        }
      }
      lineLength = 0; discardLine = false;
    } else if (!discardLine) {
      if (lineLength < sizeof(line) - 1) line[lineLength++] = c;
      else discardLine = true;
    }
  }
}

static void listenFor(uint32_t duration) {
  const uint32_t start = millis();
  while (millis() - start < duration) receiveLines();
}

// AT 명령 전송(화면 출력 없음). 반환 1=OK, 2=ERROR, 0=무응답
static uint8_t command(const __FlashStringHelper *cmd, uint32_t timeout) {
  listenFor(80);
  lineLength = 0; discardLine = false; reply = 0;
  modem.print(cmd);
  modem.print('\r');
  const uint32_t start = millis();
  while (millis() - start < timeout) {
    receiveLines();
    if (reply) return reply;
  }
  listenFor(300);   // 지연 응답 격리 — 다음 명령의 OK 로 오인 방지
  return 0;
}

// ── [1/5] 모뎀 통신 확보 ─────────────────────────────────────────────
static bool tryBaud(uint32_t rate) {
  modem.end(); modem.begin(rate);
  if (command(F("AT"), 1200) != 1) return false;
  if (rate == MODEM_BAUD) return true;
  command(F("AT+IPR=9600"), 1200);
  modem.end(); modem.begin(MODEM_BAUD);
  return command(F("AT"), 1500) == 1;
}

static bool stageModem() {
  Serial.println(F("[1/5] 모뎀 통신 확인 중…"));
  for (uint8_t i = 0; i < 4; ++i) if (command(F("AT"), 900) == 1) {
    Serial.println(F("[1/5] 모뎀 통신: 정상"));
    return true;
  }
  Serial.println(F("[1/5] 응답 없음 — 통신 속도 자동 탐색"));
  const uint32_t rates[] = {9600, 115200, 19200, 38400, 57600};
  for (uint8_t i = 0; i < 5; ++i) if (tryBaud(rates[i])) {
    Serial.println(F("[1/5] 모뎀 통신: 정상 (속도 동기화됨)"));
    return true;
  }
  Serial.println(F("[1/5] 여전히 무응답 — 전원 스위치(PWRKEY) 신호로 켜는 중… (약 14초)"));
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? LOW : HIGH);
  listenFor(100);
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? HIGH : LOW);
  listenFor(1500);
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? LOW : HIGH);
  const uint32_t start = millis();
  while (millis() - start < 12000UL) {
    receiveLines();
    if (command(F("AT"), 900) == 1) {
      Serial.println(F("[1/5] 모뎀 통신: 정상 (전원 켜짐)"));
      return true;
    }
  }
  for (uint8_t i = 0; i < 5; ++i) if (tryBaud(rates[i])) {
    Serial.println(F("[1/5] 모뎀 통신: 정상 (전원 켜짐 + 속도 동기화)"));
    return true;
  }
  Serial.println(F("[1/5] 실패: 모뎀 무응답 — 점검: ① 모뎀 전원(별도 3.3~4.2V/500mA, GND 공통) ② 배선(D8<-모뎀TX, D9->모뎀RX) ③ 레벨변환 회로. 10초 후 재시도"));
  return false;
}

// ── [2/5] 초기 설정 ─────────────────────────────────────────────────
static void stageConfig() {
  Serial.println(F("[2/5] 모뎀 초기 설정 중…"));
  uint8_t fail = 0;
  if (command(F("ATE0"), 2000) != 1) ++fail;
  if (command(F("AT+IFC=0,0"), 2000) != 1) ++fail;
  if (command(F("AT+IPR=9600"), 2000) != 1) ++fail;
  if (command(F("AT+CMEE=2"), 2000) != 1) ++fail;
  if (command(F("AT+CSCLK=0"), 2000) != 1) ++fail;
  if (fail == 0) Serial.println(F("[2/5] 초기 설정: 완료"));
  else {
    Serial.print(F("[2/5] 초기 설정: 일부 실패("));
    Serial.print(fail);
    Serial.println(F("건) — 계속 진행. 반복되면 모뎀 재부팅(전원) 여부 확인"));
  }
}

// ── [3/5] 유심 확인 ─────────────────────────────────────────────────
static bool stageSim() {
  Serial.println(F("[3/5] 유심(SIM) 확인 중…"));
  simReady = false;
  command(F("AT+CPIN?"), 5000);
  if (!simReady) {
    Serial.println(F("[3/5] 실패: 유심 인식 안 됨 — 점검: ① 유심 장착 방향/접점 ② 모뎀 재부팅 직후면 5초 뒤 재시도됨"));
    return false;
  }
  Serial.println(F("[3/5] 유심 인식: 정상 (PIN 잠금 없음)"));
  if (command(F("AT+CCID"), 3000) == 1) Serial.println(F("[3/5] 유심 카드번호 조회: 성공"));
  else Serial.println(F("[3/5] 유심 카드번호 조회: 실패 (인식은 정상 — 참고용)"));
  return true;
}

// ── [4/5] 망 등록 (진입 시 1회 안내, 이후 폴링은 loop 에서) ──────────────
static void pollNetwork() {
  command(F("AT+CSQ"), 2000);
  command(F("AT+CEREG?"), 2000);
}

// ── [5/5] 서버 전송 시험 ──────────────────────────────────────────────
static bool waitPrompt(uint32_t timeout) {   // AT+SHBOD 의 '>' 프롬프트(개행 없이 도착)
  const uint32_t start = millis();
  while (millis() - start < timeout) {
    if (modem.available() && (char)modem.read() == '>') return true;
  }
  return false;
}
static uint8_t waitReply(uint32_t timeout) {
  lineLength = 0; discardLine = false; reply = 0;
  const uint32_t start = millis();
  while (millis() - start < timeout) { receiveLines(); if (reply) return reply; }
  return 0;
}
static void stageServer() {
  Serial.println(F("[5/5] 서버 전송 시험 시작 (gps.serial.kr)"));
  Serial.println(F("[5/5] 데이터망(인터넷) 연결 중… (최대 30초)"));
  pdpActive = false;
  command(F("AT+CNACT=0,0"), 5000);
  command(F("AT+CNCFG=0,1,\"iot.1nce.net\""), 3000);
  command(F("AT+CNACT=0,1"), 20000);
  listenFor(6000);
  command(F("AT+CNACT?"), 3000);
  if (!pdpActive) Serial.println(F("[5/5] 데이터망 연결 확인 안 됨 — 그대로 서버 연결을 시도해 봄"));
  else Serial.println(F("[5/5] 데이터망 연결: 성공"));
  command(F("AT+SHDISC"), 1500);
  command(F("AT+SHCONF=\"URL\",\"http://gps.serial.kr\""), 3000);
  command(F("AT+SHCONF=\"BODYLEN\",1024"), 2000);
  command(F("AT+SHCONF=\"HEADERLEN\",350"), 2000);
  command(F("AT+SHSSL=0,\"\""), 2000);
  Serial.println(F("[5/5] 서버 연결 중…"));
  if (command(F("AT+SHCONN"), 15000) != 1) {
    Serial.println(F("[5/5] 실패: 서버 연결 안 됨 — 점검: ① 데이터망 연결 ② 유심 요금제(데이터) ③ 신호 세기"));
    return;
  }
  command(F("AT+SHCHEAD"), 2000);
  command(F("AT+SHAHEAD=\"Content-Type\",\"application/json\""), 2000);
  const char body[] = "{\"device_uid\":\"uno-shield-test\",\"ts\":1,\"vbat_mv\":3300}";
  Serial.println(F("[5/5] 시험 데이터 전송 중…"));
  modem.print(F("AT+SHBOD=")); modem.print((int)strlen(body)); modem.print(F(",10000\r"));
  if (!waitPrompt(3000)) { Serial.println(F("[5/5] 실패: 전송 준비 단계에서 멈춤(프롬프트 없음)")); return; }
  modem.print(body);
  if (waitReply(10000) != 1) { Serial.println(F("[5/5] 실패: 본문 전송이 접수되지 않음")); return; }
  httpStatus = -1;
  command(F("AT+SHREQ=\"/ingest\",3"), 12000);
  listenFor(10000);
  if (httpStatus == 200) {
    Serial.println(F("[5/5] 성공: 서버 응답 HTTP 200 — gps.serial.kr 수신 확인"));
    Serial.println(F("===== 검사 전체 통과: 모뎀·유심·망 등록·서버 전송 모두 정상 ====="));
  } else {
    Serial.print(F("[5/5] 실패: 서버 응답 코드="));
    Serial.print(httpStatus);
    Serial.println(F(" (200 이어야 정상) — 반복되면 개발팀에 문의"));
  }
  command(F("AT+SHDISC"), 3000);
}

// ── 진입점 ───────────────────────────────────────────────────────────
void setup() {
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, HIGH);   // ★HIGH 기본 — LOW 는 모뎀 전원붕괴 순간 UNO 까지 멈춤(실측)
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? LOW : HIGH);
  Serial.begin(115200);
  modem.begin(MODEM_BAUD);
  Serial.println();
  Serial.println(F("===== SIM7080G 쉴드 검사 (UNO) — 한글 안내판 ====="));
  Serial.println(F("[안내] 자동 순서: 1.모뎀통신 2.초기설정 3.유심 4.망등록 5.서버전송"));
  Serial.println(F("[안내] 키: r=처음부터 다시, s=유심/망 재확인, p=서버 재시험, 1/0=DTR HIGH/LOW"));
  Serial.println(F("[안내] 모뎀 전원은 별도 3.3~4.2V 500mA 이상 + GND 공통이어야 함"));
  listenFor(300);
}

void loop() {
  receiveLines();
  const uint32_t now = millis();

  if (stage == 1) {
    if (stageModem()) { stage = 2; }
    else { listenFor(10000); }
    return;
  }
  if (stage == 2) { stageConfig(); stage = 3; return; }
  if (stage == 3) {
    if (stageSim()) {
      stage = 4;
      regStat = -1; rssi = 99;
      regStartMs = now; lastPollMs = 0; lastNoteMs = 0;
      Serial.println(F("[4/5] 망 등록 대기 시작 (5초 간격 확인, 상태는 15초마다 표시)"));
    } else listenFor(5000);
    return;
  }
  if (stage == 4) {
    if (now - lastPollMs >= 5000) { lastPollMs = now; pollNetwork(); }
    if (regStat == 1 || regStat == 5) {
      Serial.print(F("[4/5] 망 등록: 성공"));
      Serial.println(regStat == 5 ? F(" (로밍)") : F(" (홈망)"));
      stage = 5;
      return;
    }
    if (now - lastNoteMs >= 15000) {
      lastNoteMs = now;
      Serial.print(F("[4/5] 망 등록 대기 중… (신호 CSQ="));
      Serial.print(rssi);
      Serial.print(rssi == 99 ? F("=미검출") : F(""));
      Serial.print(F(", 경과 "));
      Serial.print((now - regStartMs) / 1000UL);
      Serial.println(F("초)"));
      if (regStat == 3) Serial.println(F("[4/5] 등록 거절 응답 — 점검: 유심 개통 상태/로밍 허용"));
      if (rssi == 99 && now - regStartMs > 60000UL)
        Serial.println(F("[4/5] 신호가 계속 미검출 — 점검: ① 안테나 장착 ② 모뎀 전원(재부팅 경고 여부) ③ 실내 음영"));
    }
    return;
  }
  if (stage == 5) { stageServer(); stage = 6; return; }

  // stage 6 — 검사 완료 후 유지 감시: 60초마다 등록 상태만 조용히 확인
  if (now - lastPollMs >= 60000) {
    lastPollMs = now;
    pollNetwork();
    if (regStat != 1 && regStat != 5)
      Serial.println(F("[감시] 망 등록이 풀림 — 재등록 대기 (반복되면 전원/안테나 확인)"));
  }

  if (Serial.available()) {
    const char key = (char)Serial.read();
    if (key == 'r') { stage = 1; Serial.println(F("[안내] 처음부터 다시 검사")); }
    else if (key == 's') { stage = 3; Serial.println(F("[안내] 유심/망 재확인")); }
    else if (key == 'p') { stageServer(); }
    else if (key == '1' || key == '0') {
      digitalWrite(PIN_DTR, key == '1' ? HIGH : LOW);
      Serial.print(F("[안내] DTR(D6)="));
      Serial.println(key == '1' ? F("HIGH") : F("LOW (주의: 모뎀 전원붕괴 시 UNO 도 멈출 수 있음)"));
    }
  }
}
