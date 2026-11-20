-- Assignment changes only annotations. SIM identities and measured points stay untouched.
ALTER TABLE trip_annotations ADD COLUMN assignment_source JSONB;
CREATE TABLE fleet_trip_rules (
 id BIGSERIAL PRIMARY KEY,
 owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 vehicle_id BIGINT NOT NULL,
 name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
 kind TEXT NOT NULL CHECK(kind IN ('default','weekly')),
 weekdays INTEGER[] NOT NULL DEFAULT '{}',
 start_min INTEGER NOT NULL DEFAULT 0 CHECK(start_min BETWEEN 0 AND 1439),
 end_min INTEGER NOT NULL DEFAULT 1440 CHECK(end_min BETWEEN 1 AND 1440),
 valid_from DATE NOT NULL, valid_to DATE,
 driver_staff_id BIGINT REFERENCES staff(id) ON DELETE RESTRICT,
 purpose TEXT CHECK(purpose IN ('commute','business','other')),
 purpose_note TEXT,
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(vehicle_id,owner_id) REFERENCES fleet_vehicles(id,owner_id) ON DELETE CASCADE,
 CHECK(valid_to IS NULL OR valid_to>=valid_from),
 CHECK(driver_staff_id IS NOT NULL OR purpose IS NOT NULL),
 CHECK(start_min<end_min),
 CHECK(kind='default' OR cardinality(weekdays) BETWEEN 1 AND 7)
);
CREATE UNIQUE INDEX fleet_trip_default ON fleet_trip_rules(owner_id,vehicle_id) WHERE active AND kind='default';
CREATE INDEX fleet_trip_rules_vehicle ON fleet_trip_rules(owner_id,vehicle_id);
CREATE TABLE fleet_trip_assignment_audit (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 vehicle_id BIGINT REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
 action TEXT NOT NULL, before_value JSONB, after_value JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fleet_trip_audit_vehicle ON fleet_trip_assignment_audit(owner_id,vehicle_id,id DESC);
CREATE FUNCTION audit_fleet_trip_annotation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vid BIGINT; aid BIGINT; prior JSONB;
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(OLD)-'updated_at')=(to_jsonb(NEW)-'updated_at') THEN RETURN NEW; END IF;
 SELECT b.vehicle_id INTO vid FROM fleet_vehicle_bindings b
  WHERE b.owner_id=NEW.user_id AND b.device_id=NEW.device_id AND b.is_primary
   AND b.started_at<=NEW.trip_started_at AND (b.ended_at IS NULL OR b.ended_at>NEW.trip_started_at);
 IF vid IS NULL THEN RETURN NEW; END IF;
 aid=NULLIF(current_setting('app.fleet_actor',true),'')::bigint;
 IF aid IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN prior=to_jsonb(OLD); END IF;
 INSERT INTO fleet_trip_assignment_audit(owner_id,actor_id,vehicle_id,action,before_value,after_value)
 VALUES(NEW.user_id,aid,vid,'annotation',prior,to_jsonb(NEW));
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_trip_annotation_audit AFTER INSERT OR UPDATE ON trip_annotations
 FOR EACH ROW EXECUTE FUNCTION audit_fleet_trip_annotation();

ALTER TABLE vehicle_reservations ADD COLUMN report_purpose TEXT CHECK(report_purpose IN ('commute','business','other'));
