# 9. 회고 — 다시 시작한다면

9개월. Firmware 5K 줄 · 서버 4K 줄 · 웹 8K 줄 · 사고 10+ 케이스 · PR 130+ 개.

## 잘 한 것

### 1. Fork 문화

새 하드웨어 rev 나오면 firmware 는 **원본 오염 없이 fork** — `13_4_motion_aware_tracker` vs `13_4_aa_motion_aware_tracker`. Build flag (`#ifdef USE_OLD_PCB`) 로 조건부 컴파일도 병행. 두 rev 각자 iteration 하다가 안정화되면 통합 (`15_a_modular`).

이 덕분에 **어느 rev 에서 뭐가 됐는지 시간별로 남음**. `arduino/03_*/`, `arduino/14_*/`, `arduino/hwteam_*/` 등 20+ 폴더가 사고 log 그 자체.

### 2. 진단 sketch 폴더 다 남김

새 문제 발견 → 새 sketch 폴더. 문제 해결 후에도 지우지 않고 남김. 다음 유사 사고 때 참조. 예: 옛 하드웨어 재테스트 시 `03_5_legacy_lte_swap_test` 는 여전히 유용.

### 3. Memory system 활용

Claude Code 의 memory 로 하드웨어 극성/부품 세대/사고 히스토리 지속 기록. 6개월 후 재진단 시 "sss/aa 극성 차이가 뭐였지?" → memory 확인 → 3초 만에 답. 매번 코드 파는 것보다 훨씬 빠름.

### 4. 병렬 fetch + O(N²) → O(N) 최적화

Frontend `loadDevices` 가 device 별 순차 fetch → `Promise.all` 로 병렬화. Polyline `setPath` 매 fix 마다 호출 → bulk mode 로 마지막에 한 번. 성능 개선 규모가 컸음 (500배).

## 아쉬운 것

### 1. 초기 회로도 미문서화

첫 rev (`05_sim7080g_at`) 시절 배선을 회로도로 안 남김. 주석에 "원래 2였지만 스왑해봄" 만. 9개월 후 그 하드웨어 재테스트 시 pin 조합 못 찾음 (사고 #2 참조). **초기부터 회로도 남겼으면 며칠 절약**.

### 2. 하드웨어 브라운아웃 대책

INT-WDT 4시간 offline 사고 (사고 #1) 는 결국 하드웨어 원인 (VBAT rail droop). Firmware 로는 완전 fix 불가. **PCB 설계 초기에 decoupling cap 크게 + trace 굵게** 했어야. 다음 rev 에서는 반영.

### 3. 인증 로직 통합

WS 만 refresh 안 해서 24시간+ 사용자에게 조용히 fail (사고 #3). 이런 종류는 **인증 client 를 통합 layer** 로 두고 REST/WS 모두 통과하게 했어야. 지금은 fix 됐지만 초기 설계 부재.

### 4. 커밋 히스토리 한국어

블로그 발행 관점에서 커밋 메시지가 한국어라 GitHub 국제 검색 노출 낮음. 앞으로 최소 title 은 영어. Body 는 한국어 유지 (설명 명확).

## 다음 라운드 계획

### 하드웨어 rev++ (예정)

- **Brownout 방지**: VBAT rail 부근 큰 low-ESR cap + trace 굵게
- **부저 완전 격리**: 별도 driver IC 또는 flyback diode
- **GPS 안테나 SMA 표준화**: 지금 몇 rev 는 내장 안테나만 (약함)
- **USB-C**: 지금 micro-USB (구식)

### Firmware 완성

- `15_a_modular` (IDF from-source) 로 완전 이관. Arduino IDE 는 개발 편의로만 유지.
- `recovery` state machine 강화: hardware WDT trip 시나리오 커버
- OTA (over-the-air firmware update) 추가. 지금은 물리적 flash 필요.

### 서버 스케일

- 지금 3-5 device 로는 여유. 100+ device 되면 병목 예상 지점:
  - PostgreSQL 커넥션 pool
  - WebSocket broadcast fan-out
  - 1NCE API rate limit (device 별 SIM 사용량 조회)
- 필요 시 device 별 partitioning + Redis pub-sub 도입

### UX 진화

- 지도 dot 뭉치기 (cluster) — seeker 에서만 유지, 홈은 뺌 (사용자 피드백)
- 배터리 tooltip pair (vbat + cbc) — 진단용 유지, 소비자용 별도 뷰 필요
- 오프라인 캐시 (PWA) — 지도 로컬 저장

### 블로그

- 챕터 4-7 (firmware 리팩터, 서버, 프론트, 모바일) 서사식 완성
- 각 사고 딥다이브 (지금 요약본만)
- 회로도 · PCB 이미지 · GIF 데모 추가

## 소감

이 프로젝트는 **소프트웨어 사고보다 하드웨어 사고가 많았다**. Firmware 코드는 진단 가능 (log 남기고 재현) 하지만 하드웨어 이슈는 **부품 실사 · 오실로스코프 · 뜯어보기** 없이는 못 잡음. 그런데도 소프트웨어 개발자가 하드웨어 이슈 진단하며 배운 게 크다.

"이 rev 는 왜 안 되는지" 를 여러 번 반복하다 보면 결국 **소프트웨어 · 하드웨어 · 통신 · 서버 · 프론트 · 모바일** 을 다 알아야 원인 판단 가능. Full-stack + embedded + network. 이게 이 프로젝트의 재미.

그리고 이 모든 게 **하나의 저장소** 에 남아있다. 3년 후 다시 봐도 "여기서 이러다 결국 이렇게 됐구나" 를 시간순으로 볼 수 있게. 그게 이 dirty repo 의 가치.

## 관련

- [docs/troubleshooting.md](../troubleshooting.md) — 전체 사고 log
- [docs/hardware.md](../hardware.md) — HW 진화
- [STATUS.md](../../STATUS.md) — 현재 진행 상태
- [1. 왜 시작했나](01-why.md) — 처음으로
