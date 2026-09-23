# 03_10 — UNO + SIM7080G 쉴드 검사 + GPS/OLED/배터리 (HW팀 확장판)

03_8 의 한글 5단계 검사에 HW 팀이 확장(2026-09-23 feedback 흡수):
- **OLED**(SSD1306 128x64 I2C, A4/A5; SH1106 은 `OLED_SH1106 1`) — 단계/재부팅수/PV전압/배터리%/망/GPS/HTTP 8행 로테이션
- **GPS**: 모뎀 내장 GNSS(CGNSINF) 5초 폴링 — 로컬 표시 전용, 서버 전송엔 미포함
- **배터리**: A0=PV 분압(100k/100k) 실측 표시. 1S Li-ion OCV 근사 % (연료게이지 아님)
- 서버 전송은 03_8 과 동일 (`device_uid=uno-shield-test`, ICCID 미전송)

## ★ 신쉴드 PWRKEY 회로 교훈 (HW 확인)
D7 → T2(NPN) → PWRKEY. **D7 HIGH 유지 = PWRKEY 계속 누름 = 약 12.6초마다 강제 리셋**
(SIMCom 설계서 24–25쪽). 반드시 idle LOW, AT 무응답일 때만 1.5s HIGH 펄스.
"오토부트라 펄스 불필요 + D7 상시 HIGH" 시도는 이 리셋 루프를 만들었음 (2026-09-23 실증).
RDY 수신은 원인 단정 불가 — 경고 문구도 중립으로 변경됨.

필요 라이브러리: U8g2 (`arduino-cli lib install U8g2`). 빌드: 플래시 68% / RAM 63%.
