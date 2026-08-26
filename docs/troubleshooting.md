# Troubleshooting — 실전 사고 log

> "여기 왜 안 돼요?" 로 시작해서 며칠씩 파고든 흔적들. 재현 조건 · 원인 · fix · 관련 커밋 순서. 사후 결과만 정리한 게 아니라 **왔다갔다 진짜 흔적 그대로**.

각 사건은 시간순. 최신이 위.

---

## 2026-07 · WS payload 배터리 갱신 안 됨 (fix 없는 상태)

**증상**: 단말기 카드에 3612mV 로 고정, 실시간 갱신 안 됨. 실제 DB 는 4240mV 로 계속 업데이트되고 있음.

**진단 경로**:
1. `lastMetaRef` 는 loadDevices 시점 값. WS 로 갱신되어야
2. `handleWsEvent` 초입 조건: `msg.type==='location' && msg.fix && msg.lat && msg.lng` — **fix 없으면 통째 skip**
3. ccc device 는 GPS 실내 미확보 (fix=false) → WS payload 오지만 조건 걸림 → lastMetaRef stale

**Fix (PR #128)**: no-fix WS payload 도 초입에서 별도 처리하여 meta 병합 + setDevices(last_seen_at). 마커/polyline 은 fix+lat+lng 조건에서만.

**후속 사고 (같은 세션)**: 배터리 표시가 `4200(3572)` 처럼 **vbat 최신 + cbc stale 혼합** 상황 발생.
- 원인: 서버 `Event::Location` broadcast 가 `vbat_mv` 만 포함, `cbc_mv` 필드 없음 → 웹 `msg.cbc_mv=undefined` → fallback 이 `d.last_cbc_mv` (initial fetch) 로 → 페어링 깨짐
- Fix (PR #130): 서버 broadcast 에 cbc_mv 포함 + 웹 fallback pair-based

**교훈**: WS payload 스펙 변경 시 broadcast 필드 + parse 필드 + 웹 fallback 규칙까지 3층 모두 점검.

---

## 2026-07 · 구버전 LTE 모듈 어떤 스왑 조합도 응답 없음

**증상**: 구 PCB (rev sss) LTE 모듈 재테스트 중, `03_5_legacy_lte_swap_test.ino` 로 4가지 조합 (RX/TX + DTR 극성) 순환했지만 어느 조합에서도 0 bytes 응답.

**진단 여정**:
1. 처음: memory `project-aa-hardware-polarity` 확인 — sss/aa 극성 차이는 PWRKEY 뿐 (DTR 은 동일 LOW), RX/TX 는 2/4 or 4/2 스왑
2. `PWRKEY_INVERT` 0/1 둘 다 시도 → 여전히 0 bytes
3. **8가지 조합 (4스왑 × 2극성) 모두 fail** — 하드웨어 dead 나 VBAT 미공급 의심
4. 사용자가 다른 유저 성공 코드 보여줌: `PIN_LTE_TX = 3` (GPIO 3, **우리는 2 or 4 만 시도**)
5. **진짜 원인**: 이 옛날 board 는 문서화되지 않은 GPIO 3 TX 배선

**교훈**:
- 하드웨어 진단은 sketch 만으로 exhaustive 안 됨. 회로도 없이는 pin 조합 무한 가정 불가
- 05_sim7080g_at 첫 sketch 주석 "원래 2였지만 스왑해봄" 이 이미 초기 개발자도 헤맸음을 보여줌

---

## 2026-07-06 · aa hardware 부팅 실패 (LTE 무응답)

**증상**: 첫 aa device flash 후 부팅 로그 정상 (`PWR_EN LOW`, `PWRKEY 펄스`) 인데 `AT+CFUN?` 응답 없음.

**진단**:
1. sss 극성 (`PWRKEY_INVERT=1`) 은 아님 — aa 신 rev 는 반전
2. 부저 (BUZZER_ENABLED=1) 로 부팅 시 GPIO1 → 마그네틱 PWM 인터럽트 발생
3. **부저 beep 이 LTE UART init 과 시간적으로 겹침** → 모듈 부팅 wedge

**Fix**: `BUZZER_ENABLED=0` (aa fork 만) — GPIO1 을 INPUT_PULLDOWN 으로 격리 → LTE 정상 부팅. 이후 하드웨어 재작업으로 부저 격리 개선 후 다시 `=1` 로 복구.

**Memory**: `project-buzzer-lte-diagnostic`, `project-aa-hardware-polarity`

---

## 2026-07-04~05 · INT-WDT crash 반복 + 4시간 offline

**증상**: sss (id=3005) 오후 1시간+ offline. 07-05 log:
```
14:30  offline
17:50  stuck watchdog
18:45  wake (reset_cause=INT_WDT, boots=1)
```
사이 4시간 15분 자동 복구 없음.

**진단**:
1. Firmware 안 stuck watchdog (5분+ 무응답 시 `esp_restart()`) 은 있음
2. `esp_restart()` 는 SW reset → `esp_reset_reason() == ESP_RST_SW` 가 정상
3. 하지만 실제 reset_cause = `INT_WDT` → **hardware watchdog trip** (SW restart 아님)
4. `rtc_boot_count` 도 1 (매번 리셋) — INT_WDT 이후 RTC memory 유실 케이스

**Root cause 후보**:
- LTE TX peak 시 VBAT rail droop → 순간 brownout 유사 상태 → RTC memory 유실 + INT_WDT trip
- `cbc_mv` 대비 `vbat_mv` drop 크게 벌어짐 (LTE 부팅 순간 100-200mV) 이 명확 지표

**Fix (진행 중)**:
- IDF 기반 15_a_modular 리팩터로 복구 경로 통합 (single state machine)
- 하드웨어 관점 개선: PCB trace 굵기 + decoupling cap 재검토 (별개 라운드)

**참고**: memory `project-int-wdt-bypass-decision`, `project-stuck-esp-restart-ceiling`

---

## 2026-07-01 · 새 aa 하드웨어 GPS 통신 안 됨

**증상**: 새 aa 배치 flash 후 GPS NMEA URC 하나도 안 옴. sat count 0 유지.

**진단**:
1. 첫 aa (커미셔닝 검증본) 는 LC86G → `$PAIR*` 로 잘 응답
2. 새 배치 GPS chip 마킹 확인 → **`L86 M33 Q1 A0437` (MediaTek MTK)**. LC86G 가 아님
3. L86 은 `$PAIR*` 명령 무시 (`$PMTK*` 계열만 인식)
4. Firmware 는 LC86G 초기화 명령만 발사 → 모듈 idle 상태로 있음

**Fix**: `13_4_aa` firmware 안 두 URC 형식 모두 파싱 + baud 9600 default 로 통일 (LC86G 도 이 값 유지 원칙). `$GPTXT ANTSTATUS` (L86) + `$PQTMANTENNASTATUS` (LC86G) 둘 다 안테나 상태로 매핑.

**교훈**: 같은 fleet 안에서도 chip 세대가 섞일 수 있음. 부품 마킹 항상 실사.

---

## 2026-07-08 · GPS 미확보 상태 cycle 삭제 안 됨

**증상**: aa (id=2995) 07/08 하루종일 sleep 없이 15초 POST 만 → wake/sleep_enter 이벤트 zero, `cycle_first_fix` 딱 1개. seeker 에서 사이클 삭제 눌러도 좌표 안 지워짐.

**진단**:
1. DB 실사 — 07/08 location_records 2179 rows 여전히 존재 (삭제 안 됨)
2. `groupCycles` (SeekerSheet) 는 wake 이벤트 기준 grouping. wake 없으면 첫 event 로 fake 0초 range cycle 생성
3. 사용자가 이 cycle 삭제 → `deleteDeviceRange(id, "10:05:34", "10:05:34")` = 0초 range → 좌표 안 지워짐

**Fix (PR #121 + #122)**:
- (A) `groupCycles` 개선: sleep_enter 후 새 cycle 트리거 + 진행중 cycle end 를 현재 시각까지 확장 (KST 자정 clamp)
- (B) "🗑 오늘" 버튼 추가 — date-based fallback (사이클 grouping 무의미할 때)
- (C) `delete_range` API 에 `devices.last_lat/lng/fix_at/seen_at` 재계산 추가 (2차 결함 fix)

**교훈**: UI 삭제가 "무언가 지워졌다" 느낌 만 주고 실제 range 는 0인 케이스 있음. Delete API 는 반환값 (deleted count) 로 UI 검증 필요.

---

## 2026-07-08 · Kakao 지도 `undefined.x` 217번 캐스케이드

**증상**: 브라우저 콘솔에 `TypeError: Cannot read properties of undefined (reading 'x')` 가 지도 이벤트마다 폭발적으로 반복 → UI 완전 프리즈.

**진단**:
1. 스택 트레이스 = kakao.js 내부 event dispatch
2. Root cause: `new kakao.maps.LatLng(lat, lng)` 에 lat/lng 가 undefined → 인스턴스 자체가 손상 → 후속 `bounds.extend` / `setPosition` 에서 `undefined.x` 폭발
3. WS payload 안 no-fix 이벤트 (sleep_enter, geofence_out) 가 lat/lng 없이 옴 → Dashboard legacy path (`msg.fix && lat` 조건 우회) 에서 그대로 updateMarker 호출

**Fix (PR #120)**:
- `KakaoMap.updateMarker` / `addHistoryPoint` 초입에 `Number.isFinite(lat/lng)` 유효성 검증
- Dashboard legacy path 도 `msg.lat != null && msg.lng != null` 조건 추가

**교훈**: Kakao maps SDK 는 invalid LatLng 를 즉시 오류 안 던지고 event listener 에서 lazy fail 함. 즉 원인 지점과 크래시 지점이 시간·공간적으로 분리됨. **입력 시점 유효성 검증** 이 유일 답.

---

## 2026-07-08 · WS 401 무한 loop (24시간+ 방치 창)

**증상**: 브라우저 24시간+ 열어둔 창에서 콘솔 401 로 도배됨:
```
WebSocket connection to 'wss://.../ws/realtime?token=eyJ...' failed: HTTP Authentication failed
```

**진단**:
1. JWT decode → **iat=어제, exp=어제+15분** = 만료 24시간+
2. REST 는 `req()` 안에서 401 → `tryRefresh()` 자동 갱신
3. **WS 는 그 로직 없음** — `_open()` 이 `activeStorage()` 로 저장된 토큰 그대로 사용
4. 결과: WS 401 → onclose → 5초 후 재시도 → 만료 토큰 그대로 → 무한 loop

**Fix (PR #120)**:
- `api.js` 에 `tryRefresh` + `isTokenExpiringSoon` export
- `ws.js _open` 을 async 로: 만료 임박 (60초 이내) 이면 `tryRefresh` 먼저 호출 → 새 토큰으로 연결
- refresh 도 'unauth' 면 `_dead=true` 로 재시도 loop 중단

**교훈**: 인증 관련 client 로직은 **모든 통신 경로에 일관되게** 적용해야. REST 만 fix 하고 WS 잊으면 대낮에 몇 시간 방치된 사용자가 조용히 데이터 못 받음.

---

## 2026-07-06 · gzip 미적용으로 초기 로드 지연

**증상**: 사용자 "프론트가 느리다" 리포트. 서버 지표는 다 정상 (API TTFB 42ms, VPS load 0.27).

**진단**:
1. VPS 리소스 감사 → memory 여유, load 낮음
2. API endpoint latency → 정상
3. **정적 asset 응답 확인**: `curl -sS -D - "https://gps.serial.kr/assets/index-*.js"` → **Content-Encoding 없음** (raw 570 KB 전송)
4. nginx.conf: `gzip on;` 있지만 `gzip_types` 는 주석처리됨 → default `text/html` 만 압축, JS/CSS 미압축

**Fix**: nginx.conf 안 `gzip_types text/plain text/css application/json application/javascript ...` 주석 해제 + `gzip_vary`, `gzip_proxied any`, `gzip_comp_level 6` 등 활성. `sudo systemctl reload nginx`. **JS 570 KB → 164 KB (3.5배 감소)**.

**그 후 추가 개선 (PR #120)**:
- vite `manualChunks` — node_modules → vendor chunk 분리 (재방문 캐시 hit)
- React.lazy — Auth/SharePage/Diagnostic/Admin/Corporate route 청크 분리
- 결과: 초기 index 556 → 272 KB, vendor 163 KB (캐시), 총 초기 다운로드 -52% (재방문 시)

**교훈**: 서버 지표가 다 정상이라고 사용자 체감이 정상인 건 아님. 실제 사용자 회선에서 다운로드 시간까지 실측 필요.

---

## 2026-07 · loadDevices O(N²) polyline setPath

**증상**: 좌표 많은 device (2000+ fix) 로그인 시 페이지 로드 초 단위 지연.

**진단**:
1. `Dashboard.loadDevices` 안 `ordered.forEach(loc => updateMarker(...))`
2. `KakaoMap.updateMarker` 안 매 호출마다 `lastSeg.poly.setPath(lastSeg.coords)` 실행
3. **2000 fix 로드 시**: 1 + 2 + ... + 2000 = **~2M vertex 재렌더** (O(N²))
4. Kakao Canvas re-render 가 무거워 초 단위 lag

**Fix (PR #120)**:
- `updateMarker(..., { deferPolyline: true })` 옵션 추가 — coords 만 push, setPath skip
- 새 `flushLiveTrail(deviceId)` — 마지막에 한 번에 setPath (O(N))
- Dashboard bulk 루프 마지막 fix 만 `deferPolyline=false` + flushLiveTrail 호출
- **~500배 계산량 감소**

**후속 회귀 (PR #123)**: gap 로 나뉜 여러 segment 중 **마지막 segment 만 flush** 해서 이전 사이클 폴리라인 미렌더 → `flushLiveTrail` 이 `entry.segments.forEach(seg.poly.setPath(coords))` 로 모두 flush 하게 수정.

**교훈**: 성능 최적화 fix 는 종종 새 edge case 를 만듦. bulk mode 도입 시 "언제 flush 하는가" 를 세밀히 정의 필요.

---

## 2026-07 · 07/08 사이클 삭제 후에도 지도 잔존 (last_fix_at stale)

**증상**: 사이클 삭제 완료 alert 떴지만 새로고침 후 지도에 그 좌표 잠깐 나옴.

**진단**:
1. `delete_range` API 는 location_records + events 삭제만
2. **`devices.last_fix_at` UPDATE 안 함** → stale 값 유지
3. Dashboard `computeHomeSinceISO` 는 `device.last_fix_at >= midnightMs` 로 `todayHasFix=true` 판정 → 오늘 자정 이후 fetch → 삭제된 시점의 device row 상태 기반 오판

**Fix (PR #121)**: `delete_range` API 에 devices.last_* 재계산 SQL 추가 (CTE 로 location_records + events 최신 값 fetch).

**교훈**: **1차 결함 fix 가 자기 자신을 무효화하는 2차 결함**을 남길 수 있음. 삭제 API 는 관련 캐시/aggregate 모두 재계산 필수.

---

## Meta 사고 (진단 자체가 늦어진 케이스)

### "UI 값 이상/미보고" 진단 시 FE 매핑 딕셔너리 grep 필수
- **사고**: 2026-07-03 안테나 값이 DB 에는 "OK" (L86 값) 로 저장돼 있는데 UI 에서는 "미보고" 로 뜸. Backend → firmware → RTC 여러 layer 파고들면서 오래 걸림.
- **원인**: FE `ANT_LABEL` 딕셔너리에 `OK` 케이스 누락. Fallback "미보고".
- **교훈** (memory `feedback-ui-mapping-first-check`): "값 표시 이상" 진단 시 초반 (< 3 tool call) 안에 FE 매핑 grep 필수:
  ```
  grep -rn "\${의심 필드}\|<한글 표시명>" gps-tracker-web/src/
  ```

### 특정 시간대 wake vbat dip 을 "저전압" 으로 착각
- Wake 순간 LTE inrush current 로 VBAT 순간 300mV 이상 drop → 3612mV 같은 낮은 값 관측
- 실제 안정 상태는 4240mV. UI 는 device row `last_vbat_mv` 로 재계산 필요
- Fix: PR #129 로 devices API LATERAL JOIN 으로 vbat/cbc 최신값 조회 → new fetch 시 즉시 최신값

## 관련

- [hardware.md](hardware.md) — HW rev 진화
- [DB_RESPONSIBILITY.md](DB_RESPONSIBILITY.md) — DB 접근 정책
- [`idf_caltest/`](../idf_caltest/) — **현재 운영 firmware** (ESP-IDF, 신PCB 표준)
- `arduino/13_4_aa_motion_aware_tracker/` — legacy Arduino 세대 (구PCB 배선)
- [../STATUS.md](../STATUS.md) — 현재 진행 상태
