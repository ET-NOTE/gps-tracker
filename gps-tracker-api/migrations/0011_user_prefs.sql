-- 사용자별 UI 환경설정 (지도 zoom/center 등)
-- prefs 키 예시:
--   { "map_state": { "lat": 37.5665, "lng": 126.9780, "level": 7 } }
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
