-- (2026-07-28) Stage-R9a: 렌트카 QR 인수 (self-pickup) 플로우.
--
-- 흐름:
--   1) owner 가 계약에 대해 handoff-token 발급 → 카톡 등으로 임차인에게 링크 전송
--   2) 임차인이 링크 클릭 → 로그인 없이 계약 요약 확인 + 오도미터 사진 촬영 + 서명
--   3) 제출 → 계약 status draft/active → active, pickup 정보 자동 확정
--
-- 반납 (return) 도 동일 구조 재사용. purpose='pickup'|'return' 로 분기.
--
-- 토큰: URL-safe random 22자. share_tokens 패턴 참조.
-- expires_at: 발급 시 기본 72h. used_at 세팅되면 재사용 차단.

CREATE TABLE IF NOT EXISTS rental_handoff_tokens (
    id            BIGSERIAL PRIMARY KEY,
    contract_id   BIGINT NOT NULL REFERENCES rental_contracts(id) ON DELETE CASCADE,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- owner
    purpose       TEXT   NOT NULL CHECK (purpose IN ('pickup','return')),
    token         TEXT   NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,             -- 임차인이 제출한 순간
    revoked_at    TIMESTAMPTZ              -- owner 취소
);

CREATE INDEX IF NOT EXISTS rental_handoff_tokens_contract_idx
    ON rental_handoff_tokens(contract_id, purpose)
    WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS rental_handoff_tokens_user_idx
    ON rental_handoff_tokens(user_id);

COMMENT ON TABLE  rental_handoff_tokens IS '렌트카 self-handoff 토큰 (임차인용 auth-free 링크)';

-- 인수/반납 시 사진 · 서명 저장.
-- 서명: SVG path dataURL (짧음, ~5-15kb). 컬럼에 직접 저장.
-- 사진: BYTEA 압축 JPEG (~50-200kb). 다중 사진 확장 대비 별도 테이블.
ALTER TABLE rental_contracts
    ADD COLUMN IF NOT EXISTS pickup_signature_svg TEXT,
    ADD COLUMN IF NOT EXISTS pickup_signed_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS return_signature_svg TEXT,
    ADD COLUMN IF NOT EXISTS return_signed_at     TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS rental_photos (
    id            BIGSERIAL PRIMARY KEY,
    contract_id   BIGINT NOT NULL REFERENCES rental_contracts(id) ON DELETE CASCADE,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          TEXT   NOT NULL CHECK (kind IN
                    ('pickup_odometer','pickup_damage','return_odometer','return_damage')),
    mime          TEXT   NOT NULL DEFAULT 'image/jpeg',
    bytes         BYTEA  NOT NULL,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploaded_by_token BIGINT REFERENCES rental_handoff_tokens(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS rental_photos_contract_idx
    ON rental_photos(contract_id, kind);
CREATE INDEX IF NOT EXISTS rental_photos_user_idx
    ON rental_photos(user_id);

COMMENT ON TABLE  rental_photos IS '렌트카 인수/반납 사진 (오도미터·손상)';
COMMENT ON COLUMN rental_photos.bytes IS '압축 JPEG. 프론트에서 캔버스 리사이즈 후 전송';
