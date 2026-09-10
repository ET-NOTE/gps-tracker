// =====================================================================
// 03_9 — UNO R3 + SIM7080G 쉴드 + DHT11 온습도 야간 로거 (한글 안내)
//
// 배선: D8 <- 모뎀 TX, D9 -> 모뎀 RX, D6 -> DTR, D7 -> PWRKEY (03_8 과 동일)
//       DHT11: 신호 -> D2, VCC -> 5V, GND -> GND (4핀 소자는 10k 풀업 권장)
// 전원: UNO 배럴잭에 7~12V DC 어댑터 필수 (PC USB 단독 급전 금지 — 03_8 실측)
// 모니터: 115200 baud
//
// 동작: 부팅 → 모뎀/유심/망 등록/데이터망/서버 연결 후,
//       15초마다 DHT11 을 읽어 gps.serial.kr /dht 로 HTTP POST.
//       조회: https://gps.serial.kr/diagnostic (최신값 우선, KST)
//
// 무인(야간) 복구: 전송 연속 실패 → 서버 재연결 → 망부터 재확인,
//                모뎀 재부팅(RDY) 감지 → 처음부터 자동 재기동.
// ※ device_uid="uno-dht11-test" 고정, ICCID 미전송 (운영 데이터와 격리)
// =====================================================================
#include <Arduino.h>
#include <SoftwareSerial.h>
#include <string.h>

#if !defined(ARDUINO_AVR_UNO)
#error "Select Arduino UNO (arduino:avr:uno)."
#endif

const uint8_t PIN_DHT = 2;
const uint8_t PIN_DTR = 6;
const uint8_t PIN_PWRKEY = 7;
const bool PWRKEY_ACTIVE_HIGH = true;
const uint32_t MODEM_BAUD = 9600;
const uint32_t SEND_INTERVAL_MS = 15000UL;   // HTTP 주기 (사용자 지정 15초)
SoftwareSerial modem(8, 9);  // (UNO RX, UNO TX)

char line[100];
uint8_t lineLength = 0;
bool discardLine = false;
uint8_t reply = 0;              // 0=대기, 1=OK, 2=ERROR
bool simReady = false, pdpActive = false;
uint32_t modemReboots = 0, rebootsSeen = 0;
int rssi = 99, regStat = -1, httpStatus = -1;
uint8_t stage = 1;              // 1모뎀 2설정 3유심 4망 5서버연결 6주기전송
uint32_t lastPollMs = 0, lastNoteMs = 0, regStartMs = 0, lastSendMs = 0;
uint32_t sendOk = 0, sendFail = 0;
uint8_t consecFail = 0;

// ── 수신/파싱 (03_8 과 동일 — 화면 출력 없음) ───────────────────────────
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
        if (!strcmp(line, "RDY")) {
          simReady = false; pdpActive = false;
          ++modemReboots;
          static uint32_t lastWarnMs = 0;
          if (millis() - lastWarnMs < 3000) { lineLength = 0; discardLine = false; continue; }
          lastWarnMs = millis();
          Serial.print(F("[경고] 모뎀이 재부팅됨 (누적 "));
          Serial.print(modemReboots);
          Serial.println(F("회) — 전원(어댑터) 확인. 처음부터 자동 재기동"));
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
  listenFor(300);
  return 0;
}

// ── DHT11 읽기 (라이브러리 없이 — 읽는 4ms 동안만 인터럽트 정지) ─────────
static uint16_t pulseCycles(uint8_t level) {   // level 유지 시간(루프 횟수), 0=시간초과
  uint16_t n = 0;
  while (digitalRead(PIN_DHT) == level) if (++n >= 6000) return 0;
  return n;
}

static bool dhtRead(int16_t &t10, int16_t &h10) {
  uint8_t data[5] = {0, 0, 0, 0, 0};
  pinMode(PIN_DHT, OUTPUT);
  digitalWrite(PIN_DHT, LOW);
  delay(20);                          // 시작 신호 >= 18ms
  noInterrupts();
  pinMode(PIN_DHT, INPUT_PULLUP);
  delayMicroseconds(45);
  if (!pulseCycles(LOW) || !pulseCycles(HIGH)) { interrupts(); return false; }
  for (uint8_t i = 0; i < 40; ++i) {
    const uint16_t lowC = pulseCycles(LOW);    // 기준 50us
    const uint16_t highC = pulseCycles(HIGH);  // 0비트 ~27us, 1비트 ~70us
    if (!lowC || !highC) { interrupts(); return false; }
    data[i / 8] <<= 1;
    if (highC > lowC) data[i / 8] |= 1;
  }
  interrupts();
  if ((uint8_t)(data[0] + data[1] + data[2] + data[3]) != data[4]) return false;
  h10 = data[0] * 10 + (data[1] < 10 ? data[1] : 0);
  t10 = data[2] * 10 + ((data[3] & 0x7F) < 10 ? (data[3] & 0x7F) : 0);
  return true;
}

// ── 단계 1~4 (03_8 과 동일 로직) ─────────────────────────────────────
static bool tryBaud(uint32_t rate) {
  modem.end(); modem.begin(rate);
  if (command(F("AT"), 1200) != 1) return false;
  if (rate == MODEM_BAUD) return true;
  command(F("AT+IPR=9600"), 1200);
  modem.end(); modem.begin(MODEM_BAUD);
  return command(F("AT"), 1500) == 1;
}

static bool stageModem() {
  Serial.println(F("[준비1] 모뎀 통신 확인 중…"));
  for (uint8_t i = 0; i < 4; ++i) if (command(F("AT"), 900) == 1) {
    Serial.println(F("[준비1] 모뎀 통신: 정상"));
    return true;
  }
  const uint32_t rates[] = {9600, 115200, 19200, 38400, 57600};
  for (uint8_t i = 0; i < 5; ++i) if (tryBaud(rates[i])) {
    Serial.println(F("[준비1] 모뎀 통신: 정상 (속도 동기화)"));
    return true;
  }
  Serial.println(F("[준비1] 무응답 — 전원 스위치(PWRKEY) 신호로 켜는 중…"));
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? LOW : HIGH);
  listenFor(100);
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? HIGH : LOW);
  listenFor(1500);
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? LOW : HIGH);
  const uint32_t start = millis();
  while (millis() - start < 12000UL) {
    receiveLines();
    if (command(F("AT"), 900) == 1) {
      Serial.println(F("[준비1] 모뎀 통신: 정상 (전원 켜짐)"));
      return true;
    }
  }
  Serial.println(F("[준비1] 실패: 모뎀 무응답 — 어댑터/배선 확인. 10초 후 재시도"));
  return false;
}

static void stageConfig() {
  command(F("ATE0"), 2000);
  command(F("AT+IFC=0,0"), 2000);
  command(F("AT+CMEE=2"), 2000);
  command(F("AT+CSCLK=0"), 2000);
  Serial.println(F("[준비2] 모뎀 초기 설정: 완료"));
}

static bool stageSim() {
  simReady = false;
  command(F("AT+CPIN?"), 5000);
  if (!simReady) {
    Serial.println(F("[준비3] 유심 인식 안 됨 — 5초 후 재시도"));
    return false;
  }
  Serial.println(F("[준비3] 유심 인식: 정상"));
  return true;
}

static void pollNetwork() {
  command(F("AT+CSQ"), 2000);
  command(F("AT+CEREG?"), 2000);
}

// ── 서버 연결 (PDP + HTTP 연결 유지) ─────────────────────────────────
static bool waitPrompt(uint32_t timeout) {
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

static bool stageConnect() {
  Serial.println(F("[준비5] 데이터망 + 서버 연결 중…"));
  pdpActive = false;
  command(F("AT+CNACT=0,0"), 5000);
  command(F("AT+CNCFG=0,1,\"iot.1nce.net\""), 3000);
  command(F("AT+CNACT=0,1"), 20000);
  listenFor(6000);
  command(F("AT+CNACT?"), 3000);
  command(F("AT+SHDISC"), 1500);
  command(F("AT+SHCONF=\"URL\",\"http://gps.serial.kr\""), 3000);
  command(F("AT+SHCONF=\"BODYLEN\",1024"), 2000);
  command(F("AT+SHCONF=\"HEADERLEN\",350"), 2000);
  command(F("AT+SHSSL=0,\"\""), 2000);
  if (command(F("AT+SHCONN"), 15000) != 1) {
    Serial.println(F("[준비5] 서버 연결 실패 — 10초 후 재시도"));
    return false;
  }
  command(F("AT+SHCHEAD"), 2000);
  command(F("AT+SHAHEAD=\"Content-Type\",\"application/json\""), 2000);
  Serial.println(F("[준비5] 서버 연결: 성공 — 15초 주기 전송 시작"));
  return true;
}

// ── 주기 전송 ────────────────────────────────────────────────────────
static void printHms(uint32_t s) {
  Serial.print(s / 3600UL); Serial.print(F("시간 "));
  Serial.print((s / 60UL) % 60UL); Serial.print(F("분"));
}

static bool sendOnce() {
  int16_t t10 = 0, h10 = 0;
  bool sensorOk = dhtRead(t10, h10) && h10 > 0;   // 습도 0% = 전원 직후 무효 샘플(DHT11 특성)
  if (!sensorOk) { delay(1200); sensorOk = dhtRead(t10, h10) && h10 > 0; }   // 최소 간격 후 1회 재시도
  if (!sensorOk) {
    Serial.println(F("[센서] DHT11 읽기 실패 — 배선(신호=D2, 5V, GND)/풀업 확인. 이번 회차 건너뜀"));
    return true;   // 센서 실패는 통신 실패로 치지 않음
  }

  char body[120];
  snprintf(body, sizeof(body),
           "{\"device_uid\":\"uno-dht11-test\",\"temp_c\":%d.%d,\"hum_pct\":%d.%d,\"up_ms\":%lu}",
           t10 / 10, t10 % 10, h10 / 10, h10 % 10, (unsigned long)millis());

  httpStatus = -1;
  modem.print(F("AT+SHBOD=")); modem.print((int)strlen(body)); modem.print(F(",10000\r"));
  if (!waitPrompt(3000)) return false;
  modem.print(body);
  if (waitReply(10000) != 1) return false;
  command(F("AT+SHREQ=\"/dht\",3"), 12000);
  listenFor(8000);
  if (httpStatus != 200) return false;

  ++sendOk;
  Serial.print(F("[전송] 온도 "));
  Serial.print(t10 / 10); Serial.print('.'); Serial.print(t10 % 10);
  Serial.print(F("도 / 습도 "));
  Serial.print(h10 / 10);
  Serial.print(F("% → 서버 수신 확인 (성공 "));
  Serial.print(sendOk);
  Serial.print(F("회 / 실패 "));
  Serial.print(sendFail);
  Serial.print(F("회, 가동 "));
  printHms(millis() / 1000UL);
  Serial.println(')');
  return true;
}

// ── 진입점 ───────────────────────────────────────────────────────────
void setup() {
  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, HIGH);   // 03_8 실측: LOW 는 모뎀 전원붕괴 시 UNO 까지 멈춤
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, PWRKEY_ACTIVE_HIGH ? LOW : HIGH);
  Serial.begin(115200);
  modem.begin(MODEM_BAUD);
  Serial.println();
  Serial.println(F("===== DHT11 온습도 야간 로거 (UNO + SIM7080G) ====="));
  Serial.println(F("[안내] DHT11 배선: 신호=D2, 전원=5V, GND. 15초마다 서버로 전송"));
  Serial.println(F("[안내] 조회 페이지: https://gps.serial.kr/diagnostic (KST, 최신값 우선)"));
  listenFor(300);
}

void loop() {
  receiveLines();
  const uint32_t now = millis();

  // 모뎀 재부팅 감지 → 어느 단계에 있든 처음부터
  if (modemReboots != rebootsSeen) {
    rebootsSeen = modemReboots;
    stage = 1;
    listenFor(3000);   // RDY 직후 안정 대기
  }

  if (stage == 1) {
    if (stageModem()) stage = 2;
    else listenFor(10000);
    return;
  }
  if (stage == 2) { stageConfig(); stage = 3; return; }
  if (stage == 3) {
    if (stageSim()) {
      stage = 4;
      regStat = -1; rssi = 99;
      regStartMs = now; lastPollMs = 0; lastNoteMs = 0;
      Serial.println(F("[준비4] 망 등록 대기…"));
    } else listenFor(5000);
    return;
  }
  if (stage == 4) {
    if (now - lastPollMs >= 5000) { lastPollMs = now; pollNetwork(); }
    if (regStat == 1 || regStat == 5) {
      Serial.println(F("[준비4] 망 등록: 성공"));
      stage = 5;
      return;
    }
    if (now - lastNoteMs >= 30000) {
      lastNoteMs = now;
      Serial.print(F("[준비4] 망 등록 대기 중… (신호 CSQ="));
      Serial.print(rssi);
      Serial.print(F(", 경과 "));
      Serial.print((now - regStartMs) / 1000UL);
      Serial.println(F("초)"));
    }
    return;
  }
  if (stage == 5) {
    if (stageConnect()) { stage = 6; lastSendMs = 0; consecFail = 0; }
    else listenFor(10000);
    return;
  }

  // stage 6 — 15초 주기 전송
  if (now - lastSendMs >= SEND_INTERVAL_MS) {
    lastSendMs = now;
    if (!sendOnce()) {
      ++sendFail; ++consecFail;
      Serial.print(F("[전송] 실패 (연속 "));
      Serial.print(consecFail);
      Serial.println(F("회) — 서버 재연결 시도"));
      command(F("AT+SHDISC"), 3000);
      if (consecFail >= 3) {
        Serial.println(F("[복구] 연속 3회 실패 — 망 등록부터 다시 확인"));
        stage = 3; consecFail = 0;
      } else {
        stage = 5;   // SHCONN 재수립
      }
    } else {
      consecFail = 0;
    }
  }
}
