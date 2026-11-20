-- Round 22. Explicit, subject-confirmed intervals. SIM identity is unchanged.
SET LOCAL lock_timeout='5s';
CREATE TABLE location_subject_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 reference text NOT NULL DEFAULT '',
 push_enabled boolean NOT NULL DEFAULT false,
 CHECK(NOT enabled OR length(trim(reference))>=8),
 CHECK(NOT push_enabled OR enabled)
);
INSERT INTO location_subject_policy DEFAULT VALUES;
CREATE TABLE location_subject_mappings (
 id bigserial PRIMARY KEY,
 request_key uuid NOT NULL,
 owner_id bigint NOT NULL REFERENCES users(id),
 subject_id bigint NOT NULL REFERENCES users(id),
 proposed_by bigint NOT NULL REFERENCES users(id),
 staff_id bigint NOT NULL,
 vehicle_id bigint NOT NULL,
 binding_id bigint NOT NULL,
 device_id bigint NOT NULL,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 purpose text NOT NULL DEFAULT 'fleet_operations' CHECK(purpose='fleet_operations'),
 consent_version text NOT NULL DEFAULT 'fleet-subject-v1' CHECK(consent_version='fleet-subject-v1'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected','revoked')),
 revision bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decided_at timestamptz,
 UNIQUE(owner_id,request_key),
 CHECK(starts_at<ends_at AND ends_at<=starts_at+interval '31 days'),
 EXCLUDE USING gist (int8range(device_id,device_id,'[]') WITH &&,
   tstzrange(starts_at,ends_at,'[)') WITH &&) WHERE(status='confirmed')
);
CREATE INDEX location_subject_owner_period ON location_subject_mappings(owner_id,starts_at,ends_at);
CREATE INDEX location_subject_inbox ON location_subject_mappings(subject_id,id);
CREATE TABLE location_subject_actions (
 id bigserial PRIMARY KEY, mapping_id bigint NOT NULL, actor_id bigint NOT NULL,
 action text NOT NULL CHECK(action IN ('proposed','confirmed','rejected','revoked')),
 revision bigint NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(mapping_id,revision)
);
-- No cascading FK: queue and evidence must survive ledger retention / staff unlink.
-- Snapshots contain stable IDs and enums, never coordinates, tokens or free text.
CREATE TABLE location_provision_notices (
 id bigserial PRIMARY KEY, event_id bigint NOT NULL, mapping_id bigint NOT NULL,
 subject_id bigint NOT NULL, owner_id bigint NOT NULL, actor_id bigint NOT NULL,
 device_id bigint NOT NULL, vehicle_id bigint NOT NULL,
 purpose text NOT NULL CHECK(purpose='fleet_operations'),
 consent_version text NOT NULL, policy_reference text NOT NULL,
 range_from timestamptz NOT NULL, range_until timestamptz NOT NULL,
 started_at timestamptz NOT NULL,
 outcome text NOT NULL DEFAULT 'prepared', completed_at timestamptz,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 delivery text NOT NULL DEFAULT 'waiting' CHECK(delivery IN ('waiting','pending','provider_accepted','review','not_provided')),
 attempts integer NOT NULL DEFAULT 0, lease_id uuid, lease_until timestamptz,
 last_error text, provider_accepted_at timestamptz, read_at timestamptz,
 UNIQUE(event_id,mapping_id), CHECK(range_from<range_until)
);
CREATE INDEX location_provision_due ON location_provision_notices(available_at,id) WHERE delivery='pending';
CREATE INDEX location_provision_subject ON location_provision_notices(subject_id,id);
CREATE TABLE location_notice_attempts (
 id bigserial PRIMARY KEY, notice_id bigint NOT NULL, lease_id uuid NOT NULL,
 attempt integer NOT NULL, result text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(notice_id,lease_id)
);
