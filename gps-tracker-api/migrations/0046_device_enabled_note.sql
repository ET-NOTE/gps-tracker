-- (2026-07-28) Stage-4C-1: 차량 관리 뷰 (cartax.biz 스타일 참조).
--   · enabled — 사용가능/사용정지 toggle. 사용정지된 차량은 리포트/월간 집계에서 제외 옵션.
--   · note    — 메모 (자유 텍스트). 정비 이력·특이사항·주의사항 등.
--
-- 기본값 TRUE — 기존 device 는 모두 사용가능 상태로 시작 (backward-compat).

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS note    TEXT;

COMMENT ON COLUMN devices.enabled IS '사용가능(TRUE) / 사용정지(FALSE). 리포트 제외 옵션에서 활용';
COMMENT ON COLUMN devices.note    IS '차량 메모 (정비 이력·특이사항 등 자유 텍스트)';
