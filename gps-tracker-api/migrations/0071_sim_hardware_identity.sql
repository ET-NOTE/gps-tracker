-- Records and ownership stay on the SIM's devices.id. Credentials identify hardware.
CREATE TABLE hardware_credentials (
 auth_uid text PRIMARY KEY,
 key_digest bytea NOT NULL CHECK(octet_length(key_digest)=32),
 last_counter bigint NOT NULL DEFAULT 0 CHECK(last_counter>=0),
 authorized_owner_id bigint REFERENCES users(id) ON DELETE SET NULL,
 current_device_id bigint REFERENCES devices(id) ON DELETE SET NULL,
 activated_at timestamptz,
 pending_device_id bigint REFERENCES devices(id) ON DELETE SET NULL,
 claim_code_hash text,
 claim_expires_at timestamptz,
 claim_issued_at timestamptz,
 last_claim_code_hash text,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hardware_credentials(auth_uid,key_digest,last_counter,authorized_owner_id,current_device_id)
SELECT d.device_uid,c.key_digest,c.last_counter,d.owner_id,d.id
FROM device_credentials c JOIN devices d ON d.id=c.device_id;
ALTER TABLE devices ADD COLUMN active_auth_uid text;
ALTER TABLE devices ADD COLUMN sim_auth_required boolean NOT NULL DEFAULT false;
UPDATE devices SET sim_auth_required=true WHERE id IN (SELECT device_id FROM device_credentials WHERE activated_at IS NOT NULL);
ALTER TABLE devices ADD COLUMN claim_not_before timestamptz NOT NULL DEFAULT '1970-01-01';
CREATE UNIQUE INDEX devices_iccid_canonical_unique ON devices(left(iccid,19)) WHERE iccid ~ '^[0-9]{19,20}$';
CREATE INDEX hardware_pending_claim ON hardware_credentials(claim_code_hash) WHERE claim_code_hash IS NOT NULL;
