-- 1NCE SIM 정보 캐시
-- 통계 패널 클릭마다 1NCE API 를 부르면 느리고 (외부 + bizmsg API 부하) 실패도 잦음.
-- 30분 주기 워커가 미리 채워두고, 사용자 요청은 캐시만 즉시 반환.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS sim_info_cache       JSONB,
    ADD COLUMN IF NOT EXISTS sim_info_fetched_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sim_info_error       TEXT;            -- 마지막 fetch 실패 메시지

-- 워커가 stale 우선순위 정렬에 쓰는 인덱스
CREATE INDEX IF NOT EXISTS idx_devices_sim_info_stale
    ON devices(sim_info_fetched_at NULLS FIRST)
    WHERE iccid IS NOT NULL;
