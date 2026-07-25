# 1. 왜 만들었나

> "휴대폰 켜놓으면 되잖아" 를 몇 번 들었다. 그런데도 안 되는 몇 가지가 있어서 시작했다.

## 문제 정의

가족 중 누군가는 그날 어디를 다녔는지 남기고 싶고, 누군가는 하루 종일 배터리 걱정 없이 위치를 남겨두고 싶었다. 폰의 위치 기록은 부정확하고 (OS 가 배터리 최적화로 5분에 한 번, 정지 시 30분에 한 번 정도), 폰이 꺼지면 끝난다.

기존 상용 트래커도 검토했다:

- 국내 통신사 트래커 (KT/LGU+ 등 어린이 시계 형태) — 요금제 매달 5-15k원, 폐쇄 앱, 데이터 외부 반출 어려움
- Consumer GPS logger (Garmin 등) — 저장만 하고 실시간 서버 push 없음
- 외국산 fleet tracker — 국내 SIM 이슈, 한국어 지원 X

**결정**: 직접 만든다. 어차피 회로 실험도 하고 싶었고, ESP32-C3 + SIM7080G (Cat-M1) 조합이 국내에서 도는지 확인해보고 싶었다.

## 요구사항 (초기)

가장 처음 시나리오는 단순했다:

1. **10~30초 주기 위치 push** (자동차 안에 두고 이동 시)
2. **정지 시 자동 sleep** (배터리 아끼기)
3. **웹에서 지금 어디 있나 실시간 보기**
4. **어제 어디 다녔나 되짚어보기** (하루 재생)

여기까지가 v0. 회로 하나 조립하고 firmware 몇 백 줄 짜면 될 것 같았다. **9개월 후 실제로는 firmware 5천 줄 · 서버 코드 4천 줄 · 웹 8천 줄이 됐다.**

## 왜 이렇게 커졌나 (예고)

지금부터 뒤에 나올 챕터가 이 질문의 답이다. 짧게 요약하면:

- **하드웨어가 세 번 바뀌었다** (PCB rev, GPS 모듈, 부저 회로). 매번 firmware 가 대응해야 했음.
- **LTE 모듈이 예상보다 불안정**. brownout · INT-WDT · deep sleep 복귀 실패 등. 실전 사고 log 는 [8장](08-troubleshooting.md) 참조.
- **실시간 지도 UX 요구사항이 계속 자랐다**. 처음엔 "지금 위치만" → "정지 사이클 접기" → "속도별 색" → "시간대별 opacity" 등.
- **정부 R&D 는 아니지만 여러 협업자가 붙었다.** PR 리뷰 · 브랜치 정책 · admin flow 가 필요해짐.

## 기술 선택 요약

|층| 기술 | 왜 |
|---|---|---|
| MCU | ESP32-C3 mini | 저가 + Cat-M1 모듈과 UART 궁합. 나중에 RISC-V 로 IDF from-source 리팩터. |
| LTE | SIM7080G (Cat-M1/NB-IoT) | 국내 1NCE SIM 로 KT/SKT/LGU+ 로밍 가능. AT 명령 기반 (SHREQ HTTP 지원). |
| GPS | Quectel LC86G (초기: L80) | 저가 GNSS + GLONASS. 배송 default 9600 baud. |
| API | Rust + axum + sqlx | 저메모리 (VPS 2.9GB) + async · WebSocket 내장 · 타입 안전 |
| DB | PostgreSQL 14 + TimescaleDB | 위치 시계열 → hypertable 로 파티션 자동 |
| Web | React + Vite + Kakao Maps | SPA + gzip 배포. Kakao 는 국내 지도 정확도 우수 |
| Mobile | Flutter WebView + FCM native | 최소 웹 shell + 알림만 native. 전면 native 는 부담. |

각 선택의 이유는 나중 챕터에서 더 자세히. 특히 **"왜 IDF from-source 로 리팩터했나"** 는 4장 firmware 챕터에서.

## 다음

- [2. 아키텍처 큰 그림](02-architecture.md)
- [3. 하드웨어 진화](03-hardware.md)
- [8. 실전 사고](08-troubleshooting.md) ← 재밌는 부분
