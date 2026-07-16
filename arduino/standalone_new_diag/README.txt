================================================================
 [패키지 C] Arduino 소스 — standalone+신모듈 진단본 (코드 수정용)
 (2026-07-09 · idf_caltest 현재 소스에서 생성 · 컴파일 검증 완료)
================================================================

[빌드 환경]
- Arduino IDE (또는 arduino-cli) + ESP32 보드패키지 (esp32:esp32, 3.x 권장)
- 라이브러리: TinyGPSPlus  (라이브러리 매니저에서 설치)
- 보드: "ESP32C3 Dev Module"
- ★ "USB CDC On Boot: Enabled" 필수 (Serial=USB 콘솔. 안 켜면 시리얼 출력 안 나옴)
- 검증된 컴파일 명령:
    arduino-cli compile -b esp32:esp32:esp32c3:CDCOnBoot=cdc standalone_new_diag
- 업로드:
    arduino-cli upload  -b esp32:esp32:esp32c3:CDCOnBoot=cdc -p COMx standalone_new_diag
  (또는 Arduino IDE 에서 폴더 열고 업로드). 시리얼 모니터 115200 bps.

[코드 수정 포인트]
- config.h : 핀맵/모듈설정/플래그 대부분 여기.
    · LTE 핀: 신모듈=RX2/TX4, 구모듈=RX4/TX2(스왑). DTR/PWRKEY 극성. (구모듈=DTR HIGH+PWRKEY 반전 등)
    · HWDIAG_ENABLED (크래시 카운터/배너/부저), SLEEP_DISABLED (절전).
- lte.cpp   : AT 시퀀스(IFC/IPR/CSCLK/CPIN/CEREG), bringUp 상태머신, HTTP POST(SHxxx).
- 그 외 모듈: buzzer / gps / motion / hw_power / recovery / sleep_mgr / telemetry / breadcrumb / loopwdt.

[★ 이 Arduino 빌드의 한계 — 반드시 인지]
1) CAL_CYCLES(RTC 캘리 완화)는 ESP-IDF sdkconfig 전용입니다. Arduino 코어는 이 값이 고정이라
   이 소스로는 CAL=0/576 완화 실험이 불가합니다(크래시 빈도 조절 X). CAL 실험은 ESP-IDF 빌드 필요.
2) coredump-to-flash 는 커스텀 파티션(coredump 영역)이 필요한데 기본 Arduino 파티션엔 없어
   크래시 스택 저장이 안 됩니다. → HWDIAG NVS 카운터 + 시리얼 배너는 동작. 스택 디코드가 필요하면
   ESP-IDF 빌드(별도 제공 가능)를 쓰세요.
3) 즉 이 패키지는 "앱 로직 수정/재빌드" 용입니다. 저수준(클럭/파티션/coredump) 실험엔 IDF 빌드 사용.

[참고 — 크래시 원인]
- 크래시 = 전원 마진 부족 + LTE TX 전류 버스트 (근본 = PCB 전원 전달부). 오실로스코프로
  VDD/모뎀 VBAT 레일의 TX 버스트 순간 sag 캡처 권장. (멀티미터·UART 신호선으로는 못 봄.)
================================================================
