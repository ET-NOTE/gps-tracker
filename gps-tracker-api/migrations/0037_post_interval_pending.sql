-- POST 주기 원격 조정 (24h 안정성 테스트용).
-- 진단 페이지에서 N초 입력 → devices.post_interval_pending = N 으로 마킹.
-- 다음 ingest 응답에 post_interval_s=N 동봉 + atomic 으로 NULL 토글 (한 번 받으면 끝).
-- firmware 의 변수는 RAM only — reset/wake 시 자동 default 30s 복귀 (회복 후 재 hang 회피).

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS post_interval_pending INT;
