ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin'));
ALTER TABLE users ADD COLUMN disabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN credit_balance bigint NOT NULL DEFAULT 0 CHECK(credit_balance>=0);
CREATE TABLE audit_log (
 id bigserial PRIMARY KEY, actor_id bigint REFERENCES users(id), action text NOT NULL,
 target_type text NOT NULL, target_id text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_log(id DESC);
CREATE FUNCTION shield_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit records are append only'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION shield_audit_immutable();
CREATE TABLE content_posts (
 slug text PRIMARY KEY, content jsonb NOT NULL, published boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1, updated_by bigint REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE devices ADD COLUMN active_sensor_set text;
ALTER TABLE devices ADD COLUMN sensor_set_at timestamptz;
ALTER TABLE devices ADD COLUMN sim_attempted_at timestamptz;
ALTER TABLE devices ADD COLUMN sim_error text;
CREATE UNIQUE INDEX devices_sim_canonical_idx ON devices(left(sim_iccid,19)) WHERE sim_iccid IS NOT NULL;
CREATE TABLE sensor_channels (
 id bigserial PRIMARY KEY, device_id bigint NOT NULL REFERENCES devices(id),
 sensor_set text NOT NULL, metric_key text NOT NULL, label text NOT NULL, unit text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(device_id,sensor_set,metric_key)
);
ALTER TABLE readings ADD COLUMN sensor_set text;
ALTER TABLE readings ADD COLUMN values_json jsonb NOT NULL DEFAULT '{}';
DROP INDEX readings_sample_idx;
CREATE UNIQUE INDEX readings_sample_idx ON readings(device_id,user_id,measured_at,COALESCE(sensor_set,'')) WHERE measured_at IS NOT NULL;
INSERT INTO sensor_channels(device_id,sensor_set,metric_key,label,unit)
 SELECT DISTINCT device_id,'dht11','temp_c','온도','°C' FROM readings WHERE temp_c IS NOT NULL;
INSERT INTO sensor_channels(device_id,sensor_set,metric_key,label,unit)
 SELECT DISTINCT device_id,'dht11','hum_pct','습도','%' FROM readings WHERE hum_pct IS NOT NULL;
UPDATE readings r SET sensor_set='dht11', values_json=COALESCE((
 SELECT jsonb_object_agg(c.id::text,CASE WHEN c.metric_key='temp_c' THEN r.temp_c ELSE r.hum_pct END)
 FROM sensor_channels c WHERE c.device_id=r.device_id AND c.sensor_set='dht11'
 AND ((c.metric_key='temp_c' AND r.temp_c IS NOT NULL) OR (c.metric_key='hum_pct' AND r.hum_pct IS NOT NULL))
),'{}') WHERE temp_c IS NOT NULL OR hum_pct IS NOT NULL;
UPDATE devices d SET active_sensor_set='dht11',sensor_set_at=(SELECT max(measured_at) FROM readings r WHERE r.device_id=d.id AND r.sensor_set='dht11')
 WHERE EXISTS(SELECT 1 FROM sensor_channels c WHERE c.device_id=d.id);
CREATE TABLE sim_requests (
 id bigserial PRIMARY KEY, reference text NOT NULL UNIQUE, device_id bigint NOT NULL REFERENCES devices(id),
 user_id bigint NOT NULL REFERENCES users(id), iccid text NOT NULL, requested_mb integer NOT NULL DEFAULT 500 CHECK(requested_mb=500),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','submitting','submitted','unknown','failed','rejected','cancelled','completed')),
 idempotency_key text NOT NULL, note text NOT NULL DEFAULT '', admin_note text NOT NULL DEFAULT '',
 cost_credits bigint NOT NULL CHECK(cost_credits>0),
 provider_order_id text, provider_status integer, processed_by bigint REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,idempotency_key)
);
CREATE UNIQUE INDEX sim_one_open_idx ON sim_requests(iccid) WHERE status IN ('pending','approved','submitting','submitted','unknown');
CREATE TABLE sim_ledger (
 id bigserial PRIMARY KEY, request_id bigint NOT NULL REFERENCES sim_requests(id), actor_id bigint REFERENCES users(id),
 event text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER sim_ledger_immutable BEFORE UPDATE OR DELETE ON sim_ledger FOR EACH ROW EXECUTE FUNCTION shield_audit_immutable();
CREATE TABLE credit_entries (
 id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), actor_id bigint REFERENCES users(id),
 amount bigint NOT NULL, balance_after bigint NOT NULL CHECK(balance_after>=0),
 request_id bigint REFERENCES sim_requests(id), kind text NOT NULL CHECK(kind IN ('adjustment','charge','refund')),
 reference text NOT NULL UNIQUE, note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER credit_entries_immutable BEFORE UPDATE OR DELETE ON credit_entries FOR EACH ROW EXECUTE FUNCTION shield_audit_immutable();
