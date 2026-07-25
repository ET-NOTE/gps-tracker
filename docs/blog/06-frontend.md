# 6. 프론트 — React + Kakao Maps (draft)

> Draft.

## 요약

- **stack**: React 18 + Vite + Kakao Maps SDK
- **build**: 초기 555 KB → gzip 166 KB (nginx gzip fix 후 실 서빙)
- **code split**: `vendor` chunk 분리 + `React.lazy` (Auth/Share/Diagnostic/Admin/Corporate)
- **UX 3 뷰**: 홈 (실시간 지도) · Seeker (일자별 재생) · Diagnostic (진단 이벤트)

## 핵심 도전

### 1. 폴리라인 성능
- 하루 2000 fix × device 5개 = 10K vertex
- 매 fix 마다 `setPath` → O(N²). 초 단위 lag
- Fix: bulk mode (마지막에 한 번 setPath) — 500배 개선

### 2. 실시간 marker + polyline
- WebSocket batch fix 로 이동 궤적 실시간 그리기
- 순간이동 문제 (batch 안 좌표 순서) → 순차 처리로 fix
- Out-of-order fix 방어 (역방향 라인 예방)

### 3. Seeker (일자별 재생)
- 시간대별 색 vs opacity 논쟁 (PR #9 vs #132) → opacity 승 (device identity 유지)
- 정지 클러스터 흡수 (`compactStopMarkerIndexes`)
- 속도별 색 옵션 (BUCKET_COLORS)

### 4. WebSocket refresh
- 24시간+ 방치 세션 자동 refresh (사고 #3 참조)
- REST 만 refresh 있었음 → WS 통합

## userPrefs 계층 이관

Legacy `localStorage` 로 device 색, 테마 등 저장 → **서버 sync (userPrefs JSONB)** 로 이관. 여러 device 로그인 시 자동 sync.

## 관련

- [사고 log 사고 #3, #4, #7, #10](08-troubleshooting.md)
- `gps-tracker-web/src/components/KakaoMap.jsx` — 지도 로직
- `gps-tracker-web/src/pages/Dashboard.jsx` — 홈 뷰

## 다음

- [7. 모바일](07-mobile.md)
