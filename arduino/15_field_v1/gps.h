// =================================================================
// gps — LC86G(L86) NMEA 수집 계층.
//   책임: UART init + PAIR 명령, NMEA encode, 안테나 상태 파싱, fix freshness
//         판정, drift history, batch 버퍼(POST 사이 fix 누적).
//   디커플링: 부저/POST 를 직접 안 부름. first-fix 는 이벤트로 노출 → main 이 beep,
//            batch/drift 는 accessor 로 telemetry/sleep_mgr 가 소비.
// =================================================================
#pragma once
#include <Arduino.h>

namespace gps {
  struct Fix {
    double lat;
    double lng;
    int    sat;
    float  hdop;
    float  course;      // deg (0-360), hasCourse=false 면 무효 (정지)
    bool   hasCourse;
  };

  void init(uint32_t bootRefMs);   // gpsSerial.begin + LC86G PAIR init
  void feed();                     // loop 마다: UART drain → encode → 상태 갱신

  // ── 상태 질의 ──
  bool     hasFix();               // freshness 강제 (age/sat/hdop)
  bool     getFix(Fix &out);       // hasFix() 면 채우고 true
  int      satellites();
  float    hdop();                 // 실수 (1.23 …)
  uint32_t charsRx();
  uint32_t sentencesOk();
  uint32_t firstCharMs();          // 절대 millis (0=아직)
  uint32_t firstFixMs();           // 절대 millis (0=아직)
  uint32_t lastFixMs();            // 절대 millis
  const char* antennaStatus();     // "OK"/"OPEN"/"SHORT"/"?" …
  bool     consumeFirstFixEvent(); // 첫 fix 순간 1회 true (main 이 beep 트리거)

  // ── 정지 판정 지원 (sleep_mgr) ──
  int      recentDrift(float &maxDistM, uint32_t windowMs);  // 유효 fix 수 반환

  // ── batch (telemetry) ──
  uint8_t  batchCount();
  bool     batchGet(uint8_t i, float &lat, float &lng, int &sat, uint32_t &atMs);
  void     batchDrop(uint8_t n);   // 앞에서 n 개 제거 (POST 성공분)
}
