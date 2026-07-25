# 8. 실전 사고 — 며칠씩 파고든 것들

전체 사고 log 는 [docs/troubleshooting.md](../troubleshooting.md) 에 정리. 이 챕터는 그중 **가장 인상 깊었던 4가지** 서사식.

---

## 사고 1 — INT-WDT 로 4시간 offline

**증상**: sss device (id=3005) 07-05 오후 log:
```
14:30  offline
17:50  stuck watchdog
18:45  wake (reset_cause=INT_WDT, boots=1)
```
14:30 offline 후 **4시간 15분** 동안 자동 복구 안 됨. 사이 wake 이벤트도 없었음.

### 진단 흐름

1. **첫 가설**: firmware stuck watchdog (5분+ 무응답 시 `esp_restart()`) 이 작동 안 함
   - 코드 확인: 로직은 있음. 근데 실행 안 된 것.
2. **두 번째 가설**: `esp_restart()` 는 SW reset → `esp_reset_reason() == ESP_RST_SW` 여야 정상
   - 실제 log 는 `reset_cause=INT_WDT` → hardware watchdog trip
   - → **stuck watchdog 이 발동하기 전에 이미 hardware WDT 걸림**
3. **세 번째 가설**: `boots=1` 이 이상. RTC_DATA_ATTR 카운터는 sleep/reset 넘어 유지되어야 하는데 왜 1?
   - INT_WDT 이후 RTC memory 유실 케이스 존재
   - 원인 후보: **LTE TX peak 시 VBAT rail droop → 순간 brownout 유사 상태 → RTC memory 유실 + INT_WDT trip 동시 발생**

### 확정 증거

이후 `cbc_mv` 필드 (SIM7080 자체 배터리 측정) 를 payload 에 추가한 뒤:
- Idle 시 `vbat 4240 / cbc 4210` (30mV drop)
- LTE POST 순간 관측된 sample: `vbat 4180 / cbc 3820` (**360mV drop** — 순간 brownout 임계 근처)

**하드웨어 원인**. Firmware 만으론 못 막음. PCB trace 굵기 + decoupling cap 재검토 필요 (별개 라운드).

### Firmware fix

- 완전 복구는 못 하지만 완화:
  - `boot_stuck_escalation` (부팅 후 성공 POST 0 회 5분+ → `esp_restart`)
  - IDF 기반 15_a_modular 리팩터로 복구 경로 통합 (`recovery` state machine)

---

## 사고 2 — 새 aa GPS 통신 안 됨 (부품 마킹 실사)

**증상**: 새 aa 배치 device flash 후 GPS NMEA URC 하나도 안 옴. sat count 0 유지.

### 진단 흐름

1. **첫 가설**: firmware 버그
   - 첫 aa (검증본) 는 잘 됐으니 firmware 는 문제 아님
2. **두 번째 가설**: GPS 안테나 문제
   - 안테나 교체해도 안 됨
3. **세 번째 가설**: 배선 (RX/TX 스왑)
   - 스왑해도 안 됨
4. **결정적 시도**: GPS chip 실제로 봄
   - 첫 aa: `LC86G` 마킹
   - 새 aa: **`L86 M33 Q1 A0437`** — MediaTek MTK 기반. 완전히 다른 chip
5. Firmware 는 LC86G 초기화 명령 (`$PAIR864` 등) 만 발사. L86 은 `$PMTK*` 계열만 인식.

### Fix

`arduino/13_4_aa_motion_aware_tracker/` 안 **두 명령 계열 모두 지원**. 안테나 URC 파싱도 두 형식:
- LC86G: `$PQTMANTENNASTATUS,OK_INT/OK_EXT/OPEN/SHORT*XX`
- L86: `$GPTXT,01,01,02,ANTSTATUS=OK/OPEN/SHORT*XX`

같은 `last_antenna` 필드로 통일해서 UI 는 chip 세대와 무관해짐.

### 교훈

같은 부품 발주여도 chip 세대 섞일 수 있음. 신규 device 커미셔닝 시 **부품 마킹 항상 실사**. 회로도만 믿지 말 것.

---

## 사고 3 — WS 401 무한 loop (24시간+ 방치 창)

**증상**: 사용자 리포트 "브라우저 켜뒀는데 실시간 위치가 안 움직여요. 콘솔에 뭔가 빨간 게 잔뜩."

콘솔 확인:
```
WebSocket connection to 'wss://gps.serial.kr/ws/realtime?token=eyJ...' failed:
  HTTP Authentication failed; no valid credentials available
```
초당 여러 번 재시도. 지도는 그대로.

### 진단

JWT decode:
```json
{"sub":"25","exp":1783317653,"iat":1783316753,"typ":"access"}
```
- iat = 어제 오후
- exp = 어제 오후 + 15분 (access TTL)
- 지금 시각 = 24시간+ 지남

즉 **만료된 access token 으로 WS 재접속** 계속 시도 중.

### Why did REST work but WS didn't?

- REST 는 `req()` 안에서 401 → `tryRefresh()` 자동 갱신 로직 있음
- WS 는 `_open()` 이 `activeStorage()` 로 저장된 토큰 그대로 사용. **refresh 로직 없음**
- 결과: WS 401 → onclose → 5초 후 재시도 → 만료 토큰 그대로 → 무한 loop

### Fix (PR #120)

- `api.js` 에 `tryRefresh` + `isTokenExpiringSoon(token, marginMs)` export
- `ws.js _open` 을 `async` 로 바꾸고, 연결 직전 access token 이 60초 이내 만료 예상되면 `tryRefresh()` 먼저 부르고 새 토큰으로 연결
- refresh 도 'unauth' 면 `_dead=true` 로 무한 재시도 loop 중단

### 교훈

인증 관련 client 로직은 **모든 통신 경로에 일관되게** 적용해야. REST 만 fix 하고 WS 잊으면 대낮에 몇 시간 방치된 사용자가 조용히 데이터 못 받음. 그리고 이런 종류의 버그는 "사용자가 오래 켜뒀을 때" 만 재발해서 개발 중엔 못 잡음.

---

## 사고 4 — 프론트가 느리다 (nginx gzip 미적용)

**증상**: 사용자 "프론트가 느려요". 서버 지표 다 정상 (API TTFB 42ms, VPS load 0.27, DB 여유).

### 진단

정적 asset 실사:
```bash
curl -sS -D - "https://gps.serial.kr/assets/index-*.js"
# Content-Length: 570669
# (Content-Encoding 헤더 없음!)
```

- Vite build 결과: 555 KB → gzip 166 KB (30%)
- 실제 서빙: **570 KB raw** 그대로 나감

### Root cause

`/etc/nginx/nginx.conf`:
```nginx
gzip on;
# gzip_types text/plain text/css application/json application/javascript ...
```

`gzip on` 은 켰지만 **`gzip_types` 는 주석처리** 상태. Default `text/html` 만 압축. JS/CSS 는 raw.

### Fix

- `gzip_types ... application/javascript ...` 주석 해제
- `gzip_vary on`, `gzip_comp_level 6`, `gzip_proxied any` 활성
- `sudo systemctl reload nginx`

**결과**: JS 570 KB → **164 KB (3.5배 감소)**.

### 추가 개선 (PR #120)

- Vite `manualChunks` — `node_modules` → vendor chunk 분리 (재방문 캐시)
- `React.lazy` — Auth/SharePage/Diagnostic/Admin/Corporate 라우트 청크 분리
- 결과: 초기 index 556 → 272 KB, vendor 163 KB (캐시), **재방문 시 -52%**

### 교훈

- 서버 지표가 다 정상이라고 사용자 체감이 정상인 건 아님. 실제 사용자 회선에서 다운로드 시간까지 실측 필수
- Nginx default gzip 은 `text/html` 만이라 SPA (JS 위주) 에선 사실상 no-op. **명시적으로 types 켜야 함**
- 이런 사고는 "왜 안 느껴야 하는데?" 로 오래 헤맴. 지표 대신 실 curl 로 확인하는 습관

---

## 정리 — 반복되는 패턴

10+ 사고를 겪으며 발견한 공통 pattern:

1. **"서버는 다 정상인데 사용자가 이상하다"** — 대개 client 나 network 문제. 서버 지표만 보면 못 잡음.
2. **"코드는 맞는데 왜 안 되지"** — 대개 하드웨어. 부품 마킹 실사. 배선 실측.
3. **"1차 fix 가 2차 결함을 만든다"** — 성능 최적화 · 삭제 API · 인증 등 모두 side effect 있음. Edge case 목록 필수.
4. **"오래 켜둔 세션에서만 재발"** — 개발 중 못 재현. 실제 사용자 리포트로만 발견. Logging 필수.

## 다음

- [9. 회고](09-retro.md)
- [docs/troubleshooting.md](../troubleshooting.md) — 전체 사고 log (10+ 케이스)
