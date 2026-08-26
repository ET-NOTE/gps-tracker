#include "gps.h"
#include "config.h"
#include <TinyGPSPlus.h>
#include <HardwareSerial.h>
#include <math.h>

namespace gps {

static TinyGPSPlus    tgps;
static HardwareSerial serial(0);   // UART0 — GPS RX=20/TX=21 (CDCOnBoot=cdc 라 UART0 free)

static uint32_t bootRef_       = 0;
static uint32_t charsRx_       = 0;
static uint32_t sentencesOk_   = 0;
static uint32_t firstCharMs_   = 0;
static uint32_t firstFixMs_    = 0;
static uint32_t lastFixMs_     = 0;
static bool     firstFixEvent_ = false;
// (2026-07-03) RTC_DATA_ATTR — wake 간 값 유지. L86 은 부팅 후 GPTXT ANTSTATUS 를 OPEN→OK
//   순서로 뒤늦게 emit → 짧은 wake(uptime 2s, GPTXT 도착 전)면 OK 감지 전 sleep → payload OPEN.
//   긴 세션(모션 wake)서 OK 감지되면 RTC 로 유지 → 이후 짧은 wake 도 payload OK 유지.
//   (POWERON/완전 전원loss 만 "?" 초기화. 다른 팀 13_4_aa 동일 fix 이관.)
RTC_DATA_ATTR static char     antenna_[16]   = "?";

// ── drift history ring ──
struct Sample { double lat; double lng; uint32_t at_ms; };
static Sample   hist[GPS_HISTORY_N];
static uint8_t  histHead = 0;
static bool     histFull = false;
static uint32_t lastHistPushMs = 0;

// ── batch ──
struct BatchFix { float lat; float lng; int8_t sat; uint32_t at_ms; };
static BatchFix batch[BATCH_BUF_N];
static uint8_t  batchN = 0;

// -----------------------------------------------------------------
static void sendNmea(const char *body) {
  uint8_t cs = 0;
  const char *p = body;
  if (*p == '$') p++;
  while (*p && *p != '*') cs ^= (uint8_t)*p++;
  serial.printf("%s*%02X\r\n", body, cs);
  DBGP(F("[GPS TX] ")); DBGLN(body);
}

static float haversineM(double la1, double lo1, double la2, double lo2) {
  const double R = 6371000.0;
  const double r = M_PI / 180.0;
  double dLa = (la2 - la1) * r;
  double dLo = (lo2 - lo1) * r;
  double a = sin(dLa/2)*sin(dLa/2) + cos(la1*r)*cos(la2*r)*sin(dLo/2)*sin(dLo/2);
  return (float)(2.0 * R * asin(sqrt(a)));
}

static void histPush(double lat, double lng, uint32_t at) {
  hist[histHead] = { lat, lng, at };
  histHead = (histHead + 1) % GPS_HISTORY_N;
  if (histHead == 0) histFull = true;
}

static void setAntenna(const char *tag, const char *src, int st, int so) {
  bool changed = strncmp(antenna_, tag, sizeof(antenna_)) != 0;
  strncpy(antenna_, tag, sizeof(antenna_) - 1);
  antenna_[sizeof(antenna_) - 1] = 0;
  if (changed) {
    Serial.printf("[GPS] antenna=%s (%s st=%d so=%d, boot+%.1fs)\n",
      antenna_, src, st, so, (millis() - bootRef_) / 1000.0f);
  }
}

// $PQTMANTENNASTATUS (LC86G) 및 $..TXT ANTSTATUS (L86) 파싱. line 은 널 종료 가능해야 함.
static void parseAntenna(char *line, uint16_t len) {
  // (2026-07-02 진단) 안테나 관련 원시 NMEA — 변화 시 1회만 출력 (스팸 방지).
  if (len > 6 && len < 200) {
    line[len] = 0;
    if (strstr(line, "ANT")) {
      static char lastAntRaw[48] = "";
      if (strncmp(lastAntRaw, line, sizeof(lastAntRaw)) != 0) {
        strncpy(lastAntRaw, line, sizeof(lastAntRaw) - 1);
        lastAntRaw[sizeof(lastAntRaw) - 1] = 0;
        Serial.printf("[GPS raw-ant] %s\n", line);
      }
    }
  }
  if (len > 18 && strncmp(line, "$PQTMANTENNASTATUS", 18) == 0) {
    line[len] = 0;
    // $PQTMANTENNASTATUS,<ver>,<mode>,<status>,<source>*XX
    // status: 0=OPEN 1=SHORT 2=NORMAL 3=NOT_CONNECTED / source: 1=internal 2=external
    int commas = 0, st = -1, so = -1;
    const char *p = line;
    while (*p && *p != '*') {
      if (*p == ',') { commas++; if (commas == 3) st = atoi(p+1); else if (commas == 4) so = atoi(p+1); }
      p++;
    }
    const char *tag = "?";
    if (st == 0 || st == 3)      tag = "OPEN";
    else if (st == 1)            tag = "SHORT";
    else if (st == 2)            tag = (so == 2 ? "OK_EXT" : (so == 1 ? "OK_INT" : "OK"));
    setAntenna(tag, "PQTM", st, so);
  }
  else if (len > 6 && line[0] == '$' && strncmp(line + 3, "TXT,", 4) == 0) {
    line[len] = 0;
    const char *ants = strstr(line, "ANTSTATUS=");
    if (ants) {
      ants += 10;   // strlen("ANTSTATUS=")
      const char *tag = "?";
      if      (strncmp(ants, "OK",    2) == 0) tag = "OK";
      else if (strncmp(ants, "OPEN",  4) == 0) tag = "OPEN";
      else if (strncmp(ants, "SHORT", 5) == 0) tag = "SHORT";
      setAntenna(tag, "GPTXT", -1, -1);
    }
  }
}

// -----------------------------------------------------------------
// NMEA 설정 주입. init 외에 lte::hardCycle(railCycle) 후에도 호출 — 공유 레일이라 GPS 도 함께
//   재부팅되어 설정이 공장값으로 돌아가기 때문 (flash 비저장). [2026-08-14 분리]
void reconfigure() {
  sendNmea("$PAIR025,1");     delay(100);   // EASY (ephemeris 예측 — TTFF 단축)
  sendNmea("$PAIR050,1000");  delay(100);   // fix rate 1Hz
  sendNmea("$PAIR062,1,0");   delay(100);   // GLL off
  sendNmea("$PAIR062,5,0");   delay(100);   // VTG off
  sendNmea("$PAIR062,3,5");   delay(100);   // GSV 5s
  sendNmea("$PGCMD,33,1");    delay(100);   // [2026-07-14] MTK(L86) 안테나 advisor ON → ANTSTATUS 주기 출력(live 탈착 감지)
}

void init(uint32_t bootRefMs) {
  bootRef_ = bootRefMs;
  serial.setRxBufferSize(4096);   // LTE bringup 블로킹 동안 NMEA overflow 방지
  serial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  delay(GPS_INIT_SETTLE_MS);
  reconfigure();
}

void feed() {
  static char     nmeaLine[200];
  static uint16_t nmeaLen = 0;
  // [2026-07-14] live 안테나 탈착 감지 — L86 은 부팅시 ANTSTATUS 1회만 emit → 주기(ANT_REQUERY_MS) 재쿼리로
  //   재emit 유도. parseAntenna 가 변화를 잡아 antenna_ 갱신 → 다음 POST 에 반영. (LC86G 는 PQTM 자체주기, 무시됨)
  static uint32_t lastAntReq_ = 0;
  if (millis() - lastAntReq_ >= ANT_REQUERY_MS) {
    lastAntReq_ = millis();
    sendNmea("$PGCMD,33,1");
  }

  while (serial.available()) {
    char c = (char)serial.read();
    if (!firstCharMs_) {
      firstCharMs_ = millis();
      Serial.printf("[GPS] first NMEA char @+%.1fs\n", (firstCharMs_ - bootRef_) / 1000.0f);
    }
    charsRx_++;

    // 라인 누적 + 안테나 URC 파싱
    if (c == '\n' || c == '\r') {
      parseAntenna(nmeaLine, nmeaLen);
      nmeaLen = 0;
    } else if (nmeaLen < sizeof(nmeaLine) - 1) {
      nmeaLine[nmeaLen++] = c;
    } else {
      nmeaLen = 0;   // overflow → drop
    }

    if (tgps.encode(c)) {
      sentencesOk_++;
      if (tgps.location.isValid()) {
        uint32_t now = millis();
        if (firstFixMs_ == 0) {
          firstFixMs_    = now;
          firstFixEvent_ = true;
          Serial.printf("[GPS] *** FIRST FIX *** ttff=%.1fs sat=%d lat=%.6f lng=%.6f\n",
            (now - bootRef_) / 1000.0f, (int)tgps.satellites.value(),
            tgps.location.lat(), tgps.location.lng());
        }
        lastFixMs_ = now;

        // batch push (fresh: sat>=4 age<5s, 1s dedup, FIFO drop oldest)
        if (tgps.satellites.value() >= GPS_BATCH_MIN_SAT
            && tgps.location.age() < GPS_BATCH_MAX_AGE_MS) {
          bool push = (batchN == 0) || (now - batch[batchN - 1].at_ms >= GPS_BATCH_DEDUP_MS);
          if (push) {
            if (batchN >= BATCH_BUF_N) {
              memmove(batch, batch + 1, sizeof(BatchFix) * (BATCH_BUF_N - 1));
              batchN = BATCH_BUF_N - 1;
            }
            batch[batchN].lat   = (float)tgps.location.lat();
            batch[batchN].lng   = (float)tgps.location.lng();
            batch[batchN].sat   = (int8_t)tgps.satellites.value();
            batch[batchN].at_ms = now;
            batchN++;
          }
        }

        // drift history ~10s
        if (now - lastHistPushMs >= GPS_HIST_PUSH_MS) {
          lastHistPushMs = now;
          histPush(tgps.location.lat(), tgps.location.lng(), now);
        }
      }
    }
  }
}

// -----------------------------------------------------------------
bool hasFix() {
  uint32_t h = tgps.hdop.value();
  return tgps.location.isValid()
      && tgps.location.age() < GPS_FIX_MAX_AGE_MS
      && tgps.satellites.value() >= GPS_FIX_MIN_SAT
      && (h == 0 || h < GPS_FIX_MAX_HDOP);
}

bool getFix(Fix &out) {
  if (!hasFix()) return false;
  out.lat       = tgps.location.lat();
  out.lng       = tgps.location.lng();
  out.sat       = (int)tgps.satellites.value();
  out.hdop      = tgps.hdop.value() / 100.0f;
  out.hasCourse = tgps.course.isValid();
  out.course    = out.hasCourse ? tgps.course.deg() : -1.0f;
  return true;
}

int      satellites()    { return (int)tgps.satellites.value(); }
float    hdop()          { return tgps.hdop.value() / 100.0f; }
uint32_t charsRx()       { return charsRx_; }
uint32_t sentencesOk()   { return sentencesOk_; }
uint32_t firstCharMs()   { return firstCharMs_; }
uint32_t firstFixMs()    { return firstFixMs_; }
uint32_t lastFixMs()     { return lastFixMs_; }
const char* antennaStatus() { return antenna_; }

bool consumeFirstFixEvent() {
  if (!firstFixEvent_) return false;
  firstFixEvent_ = false;
  return true;
}

int recentDrift(float &maxDistM, uint32_t windowMs) {
  uint32_t now = millis();
  int validN = 0;
  float maxD = 0;
  int total = histFull ? GPS_HISTORY_N : histHead;
  for (int i = 0; i < total; i++) {
    if (hist[i].at_ms == 0 || now - hist[i].at_ms > windowMs) continue;
    validN++;
    for (int j = i + 1; j < total; j++) {
      if (hist[j].at_ms == 0 || now - hist[j].at_ms > windowMs) continue;
      float d = haversineM(hist[i].lat, hist[i].lng, hist[j].lat, hist[j].lng);
      if (d > maxD) maxD = d;
    }
  }
  maxDistM = maxD;
  return validN;
}

uint8_t batchCount() { return batchN; }

bool batchGet(uint8_t i, float &lat, float &lng, int &sat, uint32_t &atMs) {
  if (i >= batchN) return false;
  lat = batch[i].lat; lng = batch[i].lng; sat = batch[i].sat; atMs = batch[i].at_ms;
  return true;
}

void batchDrop(uint8_t n) {
  if (n == 0) return;
  if (n >= batchN) { batchN = 0; return; }
  memmove(batch, batch + n, sizeof(BatchFix) * (batchN - n));
  batchN -= n;
}

} // namespace gps
