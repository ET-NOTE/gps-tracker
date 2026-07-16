// 03_5 — 구버전 LTE 모듈 단독 테스트 (RX/TX + DTR 스왑 자동 순환).
//
// 사용자 상황: 구 PCB rev — 신 PCB (13_4_aa) 와 RX/TX 및 DTR 극성이 반대일 가능성.
// 어떤 조합이 응답하는지 알 수 없어 5초마다 4가지 조합을 순환하며 AT 명령 발사 →
// 응답 오는 조합을 시리얼 로그로 확정.
//
// 순환 조합:
//   #0  ESP RX=GPIO2, TX=GPIO4, DTR idle=LOW   (신 PCB / aa 기본)
//   #1  ESP RX=GPIO2, TX=GPIO4, DTR idle=HIGH  (DTR 만 스왑)
//   #2  ESP RX=GPIO4, TX=GPIO2, DTR idle=LOW   (RX/TX 만 스왑)
//   #3  ESP RX=GPIO4, TX=GPIO2, DTR idle=HIGH  (둘 다 스왑)
//
// 각 조합 5초 동안 AT 발사 + 응답 대기. 응답 오는 첫 조합 발견 시 그 조합에 고정,
// 이후 순환 AT 명령 (CPIN/CSQ/CEREG/CGATT/CGDCONT/CGPADDR) 로 심화 진단.
//
// PWRKEY 극성은 신 aa 기준 (idle=LOW, pulse=HIGH). 구 sss 는 반대일 수 있으나
// 사용자가 명시 안 함 → 필요 시 PWRKEY_INVERT 매크로 1 로 바꿔 재플래시.

#include <HardwareSerial.h>

#define PIN_PWR_EN  6
#define PIN_PWRKEY  7
#define PIN_DTR    10

// PIN A/B 를 조합별로 스왑. A=GPIO2, B=GPIO4.
#define PIN_A       2
#define PIN_B       4
#define LTE_BAUD   115200UL

// PWRKEY 극성 — 신 aa=0 (idle LOW, pulse HIGH). 구 sss = 1 (idle HIGH, pulse LOW).
// (2026-07-08) 구버전 모듈 첫 시도 4-조합 all 0-byte → sss 극성 시도.
#define PWRKEY_INVERT 1

HardwareSerial lte(1);

// 조합별 상태
struct Combo {
  const char* name;
  int rxPin;
  int txPin;
  int dtrIdle;   // DTR 아이들 레벨
};
static const Combo COMBOS[] = {
  { "#0 new(RX=2,TX=4,DTR=LOW)",  PIN_A, PIN_B, LOW  },
  { "#1 DTR-swap(RX=2,TX=4,DTR=HIGH)",  PIN_A, PIN_B, HIGH },
  { "#2 RXTX-swap(RX=4,TX=2,DTR=LOW)",  PIN_B, PIN_A, LOW  },
  { "#3 both-swap(RX=4,TX=2,DTR=HIGH)", PIN_B, PIN_A, HIGH },
};
static const uint8_t N_COMBOS = sizeof(COMBOS) / sizeof(COMBOS[0]);

uint8_t curCombo = 0;
bool locked = false;         // 응답 나오는 조합 확정 후 순환 멈춤
uint32_t totalBytes = 0;
uint32_t cntOK = 0, cntERROR = 0, cntATEcho = 0;
uint32_t lastByteMs = 0;

char rxLine[200];
uint16_t rxLen = 0;

// ── PWRKEY 펄스 (신 aa 극성 기본) ──────────────────────────
static void pulsePwrKey() {
  int idle  = PWRKEY_INVERT ? HIGH : LOW;
  int pulse = PWRKEY_INVERT ? LOW  : HIGH;
  pinMode(PIN_PWRKEY, OUTPUT);
  digitalWrite(PIN_PWRKEY, idle);
  delay(100);
  digitalWrite(PIN_PWRKEY, pulse);
  delay(1500);
  digitalWrite(PIN_PWRKEY, idle);
}

// ── 파워온 (한 번만) ────────────────────────────────────
static void powerOnOnce() {
  pinMode(PIN_PWR_EN, OUTPUT);
  digitalWrite(PIN_PWR_EN, LOW);        // VBAT 공급
  Serial.println(F("[PWR] PWR_EN -> LOW (VBAT ON)"));
  delay(500);

  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, LOW);           // 초기값 — 조합별로 이후 재설정
  Serial.println(F("[PWR] DTR -> LOW (초기, 조합별로 갱신)"));

  Serial.println(F("[PWR] PWRKEY 펄스..."));
  pulsePwrKey();

  Serial.println(F("[PWR] 부팅 대기 6s..."));
  delay(6000);
}

// ── 조합 적용 (UART 재초기화 + DTR 재설정) ──────────────────
static void applyCombo(uint8_t idx) {
  const Combo& c = COMBOS[idx];
  Serial.println();
  Serial.printf("=== combo %s 적용 ===\n", c.name);

  lte.end();
  delay(50);

  pinMode(PIN_DTR, OUTPUT);
  digitalWrite(PIN_DTR, c.dtrIdle);
  Serial.printf("  DTR = %s\n", c.dtrIdle ? "HIGH" : "LOW");

  lte.begin(LTE_BAUD, SERIAL_8N1, c.rxPin, c.txPin);
  Serial.printf("  UART begin  RX=GPIO%d  TX=GPIO%d  @%lu\n", c.rxPin, c.txPin, LTE_BAUD);

  // RX 버퍼 드레인
  delay(150);
  while (lte.available()) (void)lte.read();
  rxLen = 0;
}

// ── 라인 파싱 (응답 감지) ───────────────────────────────
static void parseLine(const char* l) {
  Serial.printf("[LTE] %s\n", l);
  if (strcmp(l, "OK") == 0) {
    cntOK++;
    if (!locked) {
      locked = true;
      Serial.println();
      Serial.printf(">>> ✅ 조합 %s 응답 확정 — 이 조합 고정, 심화 AT 진단 시작\n",
                    COMBOS[curCombo].name);
      Serial.println();
    }
    return;
  }
  if (strstr(l, "ERROR")) { cntERROR++; return; }
  if (strncmp(l, "AT", 2) == 0) { cntATEcho++; return; }
}

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);
  delay(3000);
  Serial.println();
  Serial.println(F("=== 03_5 구버전 LTE 모듈 스왑 조합 자동 탐지 ==="));
  Serial.printf ("PWR_EN=GPIO%d  PWRKEY=GPIO%d(polarity_invert=%d)  DTR=GPIO%d  A=GPIO%d  B=GPIO%d  baud=%lu\n",
                 PIN_PWR_EN, PIN_PWRKEY, PWRKEY_INVERT, PIN_DTR, PIN_A, PIN_B, LTE_BAUD);
  Serial.println();

  powerOnOnce();
  applyCombo(0);
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
      if (rxLen > 0) {
        rxLine[rxLen] = 0;
        parseLine(rxLine);
        rxLen = 0;
      }
    } else if (rxLen < sizeof(rxLine) - 1) {
      rxLine[rxLen++] = (char)c;
    } else {
      rxLen = 0;
    }
  }

  // 5초 주기 액션
  static uint32_t lastTick = 0;
  static uint8_t deepIdx = 0;
  static const char* DEEP[] = {
    "AT+CPIN?", "AT+CSQ", "AT+CEREG?", "AT+CGATT?", "AT+CGDCONT?", "AT+CGPADDR",
  };
  const uint8_t N_DEEP = sizeof(DEEP)/sizeof(DEEP[0]);
  if (now - lastTick >= 5000) {
    lastTick = now;
    if (!locked) {
      // 미확정 상태 — AT 발사, 5초 뒤에도 답 없으면 다음 조합
      Serial.printf("[TX @ combo %s] AT\n", COMBOS[curCombo].name);
      lte.print("AT\r\n");
      // 이 조합에서 아무 바이트도 못 받았으면 다음 조합
      static uint32_t comboStartMs = 0;
      if (comboStartMs == 0) comboStartMs = now;
      if (now - comboStartMs >= 5000 && totalBytes == 0) {
        curCombo = (curCombo + 1) % N_COMBOS;
        applyCombo(curCombo);
        comboStartMs = now;
      } else if (totalBytes > 0 && !locked) {
        // 바이트는 왔는데 아직 OK 확정 못한 경우 — 이 조합 5초 더 대기
        static uint32_t byteFirstMs = 0;
        if (byteFirstMs == 0) byteFirstMs = now;
        if (now - byteFirstMs >= 10000 && cntOK == 0) {
          Serial.println(F("[!] 바이트는 오는데 10s 안에 OK 못 받음 — 다음 조합"));
          curCombo = (curCombo + 1) % N_COMBOS;
          applyCombo(curCombo);
          totalBytes = 0; cntATEcho = 0; cntERROR = 0;
          byteFirstMs = 0;
          comboStartMs = now;
        }
      }
    } else {
      // 확정 후 심화 AT 순환
      Serial.printf("[TX] %s\n", DEEP[deepIdx]);
      lte.print(DEEP[deepIdx]);
      lte.print("\r\n");
      deepIdx = (deepIdx + 1) % N_DEEP;
    }
  }

  // 1초 헬스라인
  static uint32_t lastHb = 0;
  if (now - lastHb >= 1000) {
    lastHb = now;
    uint32_t silent = (now - lastByteMs) / 1000;
    Serial.printf("[%lus] combo=%s bytes=%lu OK=%lu ERR=%lu echo=%lu silent=%lus locked=%d\n",
                  now/1000UL, COMBOS[curCombo].name,
                  (unsigned long)totalBytes,
                  (unsigned long)cntOK, (unsigned long)cntERROR, (unsigned long)cntATEcho,
                  (unsigned long)silent, locked ? 1 : 0);
  }
}
