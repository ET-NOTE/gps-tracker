-- Staff are business records; a login gains access only after accepting a
-- single-use invitation. SIM ownership and ingest identities are unchanged.
CREATE TABLE fleet_org_items (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('department','position')), name TEXT NOT NULL,
 active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(owner_id,kind,name), UNIQUE(owner_id,id)
);
ALTER TABLE staff ADD CONSTRAINT staff_owner_identity UNIQUE(user_id,id);
ALTER TABLE staff ADD COLUMN department_id BIGINT,
 ADD COLUMN position_id BIGINT,
 ADD COLUMN access_role TEXT NOT NULL DEFAULT 'member' CHECK(access_role IN ('admin','department_manager','member')),
 ADD COLUMN all_vehicles BOOLEAN NOT NULL DEFAULT TRUE,
 ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 ADD FOREIGN KEY(user_id,department_id) REFERENCES fleet_org_items(owner_id,id),
 ADD FOREIGN KEY(user_id,position_id) REFERENCES fleet_org_items(owner_id,id);
ALTER TABLE fleet_vehicles ADD COLUMN department_id BIGINT,
 ADD FOREIGN KEY(owner_id,department_id) REFERENCES fleet_org_items(owner_id,id);
INSERT INTO fleet_org_items(owner_id,kind,name)
 SELECT DISTINCT owner_id,'department',trim(department) FROM fleet_vehicles
 WHERE nullif(trim(department),'') IS NOT NULL ON CONFLICT DO NOTHING;
UPDATE fleet_vehicles v SET department_id=i.id FROM fleet_org_items i
 WHERE i.owner_id=v.owner_id AND i.kind='department' AND i.name=trim(v.department);
CREATE TABLE fleet_staff_vehicles (
 owner_id BIGINT NOT NULL, staff_id BIGINT NOT NULL, vehicle_id BIGINT NOT NULL,
 PRIMARY KEY(owner_id,staff_id,vehicle_id),
 FOREIGN KEY(owner_id,staff_id) REFERENCES staff(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,vehicle_id) REFERENCES fleet_vehicles(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE fleet_staff_accounts (
 owner_id BIGINT NOT NULL, staff_id BIGINT NOT NULL, account_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,staff_id), UNIQUE(owner_id,account_id),
 FOREIGN KEY(owner_id,staff_id) REFERENCES staff(user_id,id) ON DELETE CASCADE,
 CHECK(owner_id<>account_id)
);
CREATE TABLE fleet_invites (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL, staff_id BIGINT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE, created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ, accepted_at TIMESTAMPTZ,
 FOREIGN KEY(owner_id,staff_id) REFERENCES staff(user_id,id) ON DELETE CASCADE
);
CREATE TABLE fleet_team_audit (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL,
 target_id BIGINT, before_value JSONB, after_value JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fleet_team_audit_owner ON fleet_team_audit(owner_id,id DESC);
ALTER TABLE trip_annotations ADD COLUMN driver_name_snapshot TEXT,
 ADD COLUMN driver_department_snapshot TEXT, ADD COLUMN driver_position_snapshot TEXT;
ALTER TABLE vehicle_reservations ADD COLUMN driver_name_snapshot TEXT;
UPDATE trip_annotations a SET driver_name_snapshot=s.name FROM staff s
 WHERE s.id=a.driver_staff_id AND s.user_id=a.user_id;
UPDATE vehicle_reservations r SET driver_name_snapshot=s.name FROM staff s
 WHERE s.id=r.driver_staff_id AND s.user_id=r.user_id;
CREATE FUNCTION fleet_driver_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.driver_staff_id IS DISTINCT FROM OLD.driver_staff_id THEN
  SELECT s.name INTO NEW.driver_name_snapshot FROM staff s WHERE s.id=NEW.driver_staff_id AND s.user_id=NEW.user_id;
  IF TG_TABLE_NAME='trip_annotations' THEN
   SELECT d.name,p.name INTO NEW.driver_department_snapshot,NEW.driver_position_snapshot
   FROM staff s LEFT JOIN fleet_org_items d ON d.id=s.department_id
   LEFT JOIN fleet_org_items p ON p.id=s.position_id WHERE s.id=NEW.driver_staff_id AND s.user_id=NEW.user_id;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_annotation_snapshot BEFORE INSERT OR UPDATE ON trip_annotations FOR EACH ROW EXECUTE FUNCTION fleet_driver_snapshot();
CREATE TRIGGER fleet_booking_snapshot BEFORE INSERT OR UPDATE ON vehicle_reservations FOR EACH ROW EXECUTE FUNCTION fleet_driver_snapshot();
