-- GPS 진행 방향 (course over ground) — NMEA $GPRMC 의 7번째 필드.
-- 단위: degrees (0 = 북, 90 = 동). 정지 시 또는 fix 없을 때 NULL.
-- 웹에서 디바이스 마커 화살표 회전에 사용.
ALTER TABLE location_records
    ADD COLUMN IF NOT EXISTS heading REAL;
