-- Service restriction is distinct from verified destruction of all copies.
-- Keep the account/SIM keys: never turn identifying history into SET NULL rows.
CREATE TABLE privacy_account_controls (
 user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 restricted BOOLEAN NOT NULL DEFAULT false,
 restricted_at TIMESTAMPTZ
);
INSERT INTO privacy_account_controls(user_id) SELECT id FROM users;
CREATE FUNCTION privacy_account_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO privacy_account_controls(user_id) VALUES(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER privacy_account_created AFTER INSERT ON users
 FOR EACH ROW EXECUTE FUNCTION privacy_account_created();

CREATE TABLE privacy_account_closures (
 request_id BIGINT PRIMARY KEY REFERENCES privacy_requests(id) ON DELETE RESTRICT,
 user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
 started_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 state TEXT NOT NULL DEFAULT 'restricted' CHECK(state IN ('restricted','retry','review_required')),
 personal_scope_verified BOOLEAN NOT NULL DEFAULT false,
 deleted_counts JSONB NOT NULL DEFAULT '{}',
 review_reasons JSONB NOT NULL DEFAULT '[]',
 attempts INT NOT NULL DEFAULT 0,
 last_error TEXT,
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 external_copies_verified BOOLEAN NOT NULL DEFAULT false CHECK(NOT external_copies_verified)
);

CREATE FUNCTION privacy_assert_account_active(uid BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE stopped BOOLEAN;
BEGIN
 IF uid IS NULL THEN RETURN; END IF;
 SELECT restricted INTO stopped FROM privacy_account_controls WHERE user_id=uid FOR SHARE;
 IF NOT FOUND OR stopped THEN
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='account unavailable for processing';
 END IF;
END $$;

CREATE FUNCTION privacy_guard_account_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE uid BIGINT; prior BIGINT;
BEGIN
 uid=(to_jsonb(NEW)->>TG_ARGV[0])::bigint;
 PERFORM privacy_assert_account_active(uid);
 IF TG_OP='UPDATE' THEN
  prior=(to_jsonb(OLD)->>TG_ARGV[0])::bigint;
  IF prior IS DISTINCT FROM uid THEN PERFORM privacy_assert_account_active(prior); END IF;
 END IF;
 RETURN NEW;
END $$;

-- Explicit ownership columns; company actor_id is NOT company ownership.
DO $$
DECLARE t TEXT;
BEGIN
 FOREACH t IN ARRAY ARRAY['location_records','events','daily_stats','trip_annotations',
  'ai_analyses','ai_analysis_requests','ai_usage_log','connection_alert_episodes',
  'fcm_tokens','fcm_outbox','refresh_tokens','device_commands','device_documents',
  'rental_photos','rental_handoff_tokens','vehicle_reservations','notification_settings','user_phones',
  'staff','corporate_info'] LOOP
  EXECUTE format('CREATE TRIGGER privacy_account_write BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION privacy_guard_account_write(''user_id'')',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['geofences','fleet_vehicles','fleet_vehicle_bindings','fleet_sites',
  'fleet_site_visits','fleet_trip_corrections','fleet_trip_rules','fleet_expenses','fleet_invites'] LOOP
  EXECUTE format('CREATE TRIGGER privacy_account_write BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION privacy_guard_account_write(''owner_id'')',t);
 END LOOP;
END $$;
CREATE TRIGGER privacy_account_write BEFORE INSERT OR UPDATE ON share_tokens
 FOR EACH ROW EXECUTE FUNCTION privacy_guard_account_write('created_by');
CREATE TRIGGER privacy_account_write BEFORE INSERT OR UPDATE ON fleet_staff_accounts
 FOR EACH ROW EXECUTE FUNCTION privacy_guard_account_write('account_id');
CREATE TRIGGER privacy_account_owner_write BEFORE INSERT OR UPDATE ON fleet_staff_accounts
 FOR EACH ROW EXECUTE FUNCTION privacy_guard_account_write('owner_id');

-- Existing per-SIM barriers also protect background workers and cache writes.
CREATE OR REPLACE FUNCTION privacy_assert_device_writable(did BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE stopped BOOLEAN; uid BIGINT;
BEGIN
 IF did IS NULL THEN RETURN; END IF;
 SELECT blocked INTO stopped FROM device_data_controls WHERE device_id=did FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'device data control missing'; END IF;
 IF stopped THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='device data collection blocked by erasure'; END IF;
 SELECT owner_id INTO uid FROM devices WHERE id=did;
 PERFORM privacy_assert_account_active(uid);
END $$;
CREATE TRIGGER privacy_new_device_owner BEFORE INSERT ON devices
 FOR EACH ROW EXECUTE FUNCTION privacy_guard_account_write('owner_id');
CREATE TRIGGER privacy_changed_device_owner BEFORE UPDATE OF owner_id ON devices
 FOR EACH ROW EXECUTE FUNCTION privacy_guard_account_write('owner_id');

CREATE FUNCTION privacy_start_account_closure(rid BIGINT, rev INT, actor BIGINT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r privacy_requests%ROWTYPE;
BEGIN
 SELECT * INTO r FROM privacy_requests WHERE id=rid FOR UPDATE;
 IF NOT FOUND OR r.kind<>'account_closure' THEN RAISE EXCEPTION 'closure request not found'; END IF;
 IF EXISTS(SELECT 1 FROM privacy_account_closures WHERE request_id=rid) THEN RETURN; END IF;
 IF r.revision<>rev OR r.status NOT IN ('received','in_review','needs_information') THEN
  RAISE EXCEPTION 'closure request changed';
 END IF;
 IF r.user_id=actor OR NOT EXISTS(SELECT 1 FROM users WHERE id=actor AND role='admin') THEN
  RAISE EXCEPTION 'independent administrator required';
 END IF;
 PERFORM privacy_assert_account_active(actor);
 -- Exclusive lock drains earlier guarded writes. Later stale jobs are rejected.
 PERFORM 1 FROM privacy_account_controls WHERE user_id=r.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account barrier missing'; END IF;
 -- Revoke, rather than delete, handoff tokens referenced by retained photos.
 -- Perform guarded internal updates before marking this same transaction closed.
 UPDATE rental_handoff_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=r.user_id;
 UPDATE privacy_account_controls SET restricted=true,restricted_at=now() WHERE user_id=r.user_id;
 INSERT INTO privacy_account_closures(request_id,user_id,started_by,review_reasons)
 VALUES(rid,r.user_id,actor,CASE WHEN EXISTS(SELECT 1 FROM fleet_staff_accounts WHERE account_id=r.user_id)
  THEN '["company_membership_subject_review"]'::jsonb ELSE '[]'::jsonb END);
 DELETE FROM refresh_tokens WHERE user_id=r.user_id;
 DELETE FROM fcm_tokens WHERE user_id=r.user_id; -- cascades queued deliveries
 DELETE FROM share_tokens WHERE created_by=r.user_id OR device_id IN (SELECT id FROM devices WHERE owner_id=r.user_id);
 DELETE FROM fleet_invites WHERE owner_id=r.user_id;
 DELETE FROM fleet_staff_accounts WHERE account_id=r.user_id;
 UPDATE privacy_requests SET status='in_review',revision=revision+1,assigned_to=actor,
  result_message='계정 이용을 종료하고 로그인을 차단했습니다. 자료 삭제와 보관 대상 확인은 진행 중입니다.',updated_at=now() WHERE id=rid;
 INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message)
  SELECT id,actor,revision,status,result_message FROM privacy_requests WHERE id=rid;
END $$;
