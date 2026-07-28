-- (2026-07-28) Stage-4C-3: 차량 서류 (등록증/보험/정비영수증 등) 파일 업로드.
--
-- 저장 방식: 로컬 FS. path = 서버 절대 경로 (systemd EnvironmentFile 로 UPLOAD_DIR 지정).
--   기본: /home/mmm/uploads/device_documents/<user_id>/<device_id>/<uuid>_<sanitized_filename>
--
-- 제한: MIME allowlist (image/*, application/pdf), 파일당 10MB, 차량당 20 파일 (API 층에서).

CREATE TABLE IF NOT EXISTS device_documents (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    device_id    BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    kind         TEXT   NOT NULL,              -- 'registration'|'insurance'|'inspection'|'receipt'|'other'
    filename     TEXT   NOT NULL,              -- 사용자가 업로드한 원본 파일명
    stored_path  TEXT   NOT NULL,              -- 서버 상 실제 파일 경로 (uuid prefix)
    mime         TEXT   NOT NULL,
    size_bytes   BIGINT NOT NULL,
    note         TEXT,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS device_documents_device_idx
    ON device_documents(device_id, uploaded_at DESC);

COMMENT ON TABLE  device_documents IS '차량 서류 (등록증/보험/정비영수증 등) 파일 메타';
COMMENT ON COLUMN device_documents.stored_path IS '서버 로컬 FS 절대 경로. 사용자 직접 접근 X, download endpoint 만.';
