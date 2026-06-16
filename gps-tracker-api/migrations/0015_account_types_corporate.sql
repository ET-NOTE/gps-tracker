-- 계정/디바이스 유형 + 유형별 특화 테이블 (법인운행 first).
--
-- 구조:
--   users.account_type            계정 기본 유형
--   devices.account_type_override 디바이스별 override (한 계정이 여러 종류 운영 가능)
--   corporate_info                사업자/회사 정보 (계정 1:1)
--   staff                         직원 등록 (계정 1:N)
--   trip_annotations              운행별 사용자 주석 (용무/유류/운전자)
--   subscriptions                 유료 기능 게이팅 (월 구독)

-- ─── 1) 유형 컬럼 ───────────────────────────────────
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'unspecified'
        CHECK (account_type IN ('unspecified','rentcar','corporate_fleet','delivery'));

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS account_type_override TEXT
        CHECK (account_type_override IS NULL
               OR account_type_override IN ('unspecified','rentcar','corporate_fleet','delivery'));

-- ─── 2) 법인 회사 정보 ───────────────────────────────
CREATE TABLE IF NOT EXISTS corporate_info (
    user_id          BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    business_number  TEXT,                  -- 사업자번호 (000-00-00000)
    company_name     TEXT,                  -- 회사명
    address          TEXT,                  -- 본점 주소 (선택)
    representative   TEXT,                  -- 대표자명 (선택)
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 3) 직원 (운전자 후보) ──────────────────────────
CREATE TABLE IF NOT EXISTS staff (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT   NOT NULL,
    role        TEXT,                       -- 영업/사무/배차 등 자유 입력
    phone       TEXT,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_user ON staff(user_id, active DESC, name);

-- ─── 4) 운행 주석 ────────────────────────────────────
-- trip 자체는 events 테이블의 (wake, sleep_enter) 쌍으로 동적 산출.
-- annotation 은 trip 시작 시각 (wake 의 occurred_at) 으로 키잡음.
-- 사용자가 용무/운전자/유류 등 직접 입력하는 row.
CREATE TABLE IF NOT EXISTS trip_annotations (
    id              BIGSERIAL PRIMARY KEY,
    device_id       BIGINT      NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    trip_started_at TIMESTAMPTZ NOT NULL,         -- 매칭 키 (wake.occurred_at)
    purpose         TEXT NOT NULL DEFAULT 'unspecified'
                        CHECK (purpose IN ('commute','business','other','unspecified')),
    purpose_note    TEXT,                          -- purpose='other' 일 때 자유 텍스트
    driver_staff_id BIGINT REFERENCES staff(id) ON DELETE SET NULL,
    fuel_liters     NUMERIC(6,2),                  -- 직접 입력 (선택)
    fuel_cost       INT,                           -- 원, 직접 입력 (선택)
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, trip_started_at)            -- trip 당 1행
);
CREATE INDEX IF NOT EXISTS idx_trip_anno_device_time
    ON trip_annotations(device_id, trip_started_at DESC);

-- ─── 5) 구독 (유료 리포트 게이팅) ────────────────────
-- kind='corporate_report' 한 가지로 시작. 추후 다른 유료 기능도 같은 테이블로.
CREATE TABLE IF NOT EXISTS subscriptions (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT   NOT NULL,             -- 'corporate_report' 등
    starts_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    granted_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    paid_credits BIGINT,                       -- 차감한 크레딧 (선물/관리자 grant 면 NULL)
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subs_active
    ON subscriptions(user_id, kind, expires_at DESC);
