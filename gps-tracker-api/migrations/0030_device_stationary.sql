-- 디바이스의 가장 최근 stationary 진단 블록 — 펌웨어 13_1+ 가 매 POST 마다 전송.
-- 프론트엔드에서 "deep sleep 까지 N초 남음 / drift Xm" 표시.
-- 단일 row per device (events 테이블에 안 쌓아 부풀림 방지). 각 POST 가 덮어씀.
--
-- shape:
-- {
--   "active": bool, "held_s": int, "window_s": int, "sleep_in_s": int,
--   "drift_m": float, "threshold_m": float,
--   "fixes": int, "gps_avail": bool,
--   "motion_age_s": int,
--   "lis_ok": bool, "lis_reinits": int,
--   "updated_at": "ISO8601"          // 서버 측 도착 시각 (참고용)
-- }
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS last_stationary JSONB;
