-- (2026-07-28) Stage-3A: devices 에 연비/연료 컬럼 추가.
-- 목적: 월간 리포트에서 총 주행거리 × 연비 × 유가 로 유류비 자동 추정.
--       사용자가 trip_annotations 에 매번 수기 입력하는 대신 device 단위 기본값.
--
-- fuel_efficiency_kmpl: 리터당 km (통상 8~20). NULL = 미입력 (자동 추정 skip).
-- fuel_type:            'gasoline' | 'diesel' | 'lpg' | 'ev' | NULL
--                       EV 는 유류비 대신 kWh × 전기료 로 다른 공식 적용 가능 (후속).
--
-- 유가는 서버 env 상수 (FUEL_PRICE_GASOLINE_KRW 등) 또는 코드 기본값으로
-- 시작. 후속에 오피넷 API 도입 시 실시간 갱신.

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS fuel_efficiency_kmpl REAL,
    ADD COLUMN IF NOT EXISTS fuel_type            TEXT
        CHECK (fuel_type IN ('gasoline','diesel','lpg','ev'));

COMMENT ON COLUMN devices.fuel_efficiency_kmpl IS '리터당 km. 월간 리포트 유류비 추정용 (NULL=미입력)';
COMMENT ON COLUMN devices.fuel_type            IS 'gasoline|diesel|lpg|ev. 유가 조회에 사용';
