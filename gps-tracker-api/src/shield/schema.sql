CREATE TABLE users (
 id bigserial PRIMARY KEY, email text NOT NULL UNIQUE CHECK(email=lower(email)),
 password_hash text NOT NULL, display_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invites (
 code_hash text PRIMARY KEY, expires_at timestamptz NOT NULL,
 consumed_by bigint REFERENCES users(id), consumed_at timestamptz
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE auth_attempts (bucket text PRIMARY KEY, started_at timestamptz NOT NULL, attempts integer NOT NULL);
CREATE TABLE devices (
 id bigserial PRIMARY KEY, device_uid text UNIQUE NOT NULL,
 owner_id bigint REFERENCES users(id), display_name text NOT NULL,
 key_hash text NOT NULL, claim_hash text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 paired_at timestamptz, last_seen_at timestamptz, last_fix_at timestamptz,
 last_lat double precision, last_lng double precision,
 sim_iccid text UNIQUE, sim_info jsonb, sim_updated_at timestamptz
);
CREATE INDEX devices_owner_idx ON devices(owner_id);
CREATE TABLE messages (
 id bigserial PRIMARY KEY, device_id bigint NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 user_id bigint NOT NULL REFERENCES users(id), received_at timestamptz NOT NULL DEFAULT now(),
 fingerprint text NOT NULL, UNIQUE(device_id,user_id,fingerprint)
);
CREATE INDEX messages_owner_time_idx ON messages(device_id,user_id,received_at DESC);
CREATE TABLE readings (
 id bigserial PRIMARY KEY, message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 device_id bigint NOT NULL REFERENCES devices(id) ON DELETE CASCADE, user_id bigint NOT NULL REFERENCES users(id),
 recorded_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 measured_at timestamptz, temp_c real, hum_pct real, pv_mv integer, csq smallint, reg smallint,
 gnss smallint, build_tag text NOT NULL, device_uptime_s integer,
 UNIQUE(message_id,recorded_at)
);
CREATE INDEX readings_owner_time_idx ON readings(device_id,user_id,recorded_at DESC,id DESC);
CREATE UNIQUE INDEX readings_sample_idx ON readings(device_id,user_id,measured_at) WHERE measured_at IS NOT NULL;
-- This shape deliberately matches the shared GPS SQL contract. No TimescaleDB
-- worker, rental, billing, KC diagnostic or GPS account tables are installed.
CREATE TABLE location_records (
 device_id bigint NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 user_id bigint NOT NULL REFERENCES users(id), recorded_at timestamptz NOT NULL,
 source text NOT NULL, fix boolean NOT NULL, lat double precision, lng double precision,
 sat smallint, ttff_s integer, csq smallint, reg smallint, vbat_mv integer,
 raw jsonb, device_uptime_s integer, heading real, speed_kmh real, fixes_jsonb jsonb,
 PRIMARY KEY(device_id,user_id,recorded_at,source)
);
-- Empty compatibility tables used by the immutable shared GPS SQL migrations.
CREATE TABLE daily_stats (device_id bigint REFERENCES devices(id),date date,PRIMARY KEY(device_id,date));
