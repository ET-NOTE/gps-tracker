-- Company places do not replace personal SIM fences or the telemetry ledger.
CREATE TABLE fleet_site_groups (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80), active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(id,owner_id), UNIQUE(owner_id,name)
);
CREATE TABLE fleet_sites (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120), address TEXT NOT NULL DEFAULT '',
 group_id BIGINT, geometry JSONB NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, note TEXT NOT NULL DEFAULT '',
 detection_from TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(id,owner_id),
 FOREIGN KEY(group_id,owner_id) REFERENCES fleet_site_groups(id,owner_id)
);
CREATE INDEX fleet_sites_owner ON fleet_sites(owner_id,id);
CREATE TABLE fleet_site_versions (
 id BIGSERIAL PRIMARY KEY, site_id BIGINT NOT NULL REFERENCES fleet_sites(id) ON DELETE CASCADE,
 owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 valid_from TIMESTAMPTZ NOT NULL, valid_to TIMESTAMPTZ, snapshot JSONB NOT NULL
);
CREATE INDEX fleet_site_versions_owner ON fleet_site_versions(owner_id,valid_from);
CREATE TABLE fleet_site_visits (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 site_id BIGINT NOT NULL REFERENCES fleet_sites(id) ON DELETE CASCADE,
 vehicle_id BIGINT NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
 binding_id BIGINT NOT NULL REFERENCES fleet_vehicle_bindings(id) ON DELETE CASCADE,
 site_name TEXT NOT NULL, group_name TEXT, vehicle_name TEXT NOT NULL,
 first_inside_at TIMESTAMPTZ NOT NULL, last_inside_at TIMESTAMPTZ NOT NULL,
 previous_outside_at TIMESTAMPTZ, outside_at TIMESTAMPTZ,
 start_kind TEXT NOT NULL CHECK(start_kind IN ('observed','transition')),
 end_reason TEXT CHECK(end_reason IN ('exit','gap','binding_end','configuration')),
 detected_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ
);
CREATE INDEX fleet_site_visits_owner ON fleet_site_visits(owner_id,first_inside_at DESC,id DESC);
CREATE INDEX fleet_site_visits_open ON fleet_site_visits(binding_id,site_id) WHERE closed_at IS NULL;
CREATE TABLE fleet_site_states (
 site_id BIGINT NOT NULL REFERENCES fleet_sites(id) ON DELETE CASCADE,
 binding_id BIGINT NOT NULL REFERENCES fleet_vehicle_bindings(id) ON DELETE CASCADE,
 last_at TIMESTAMPTZ NOT NULL, inside BOOLEAN NOT NULL,
 visit_id BIGINT REFERENCES fleet_site_visits(id) ON DELETE SET NULL,
 PRIMARY KEY(site_id,binding_id)
);
CREATE TABLE fleet_site_cursors (
 binding_id BIGINT PRIMARY KEY REFERENCES fleet_vehicle_bindings(id) ON DELETE CASCADE,
 last_at TIMESTAMPTZ NOT NULL, checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Changes retain geometry/name snapshots and close uncertain presence; never
-- synthesize a physical exit when an administrator changes a fence.
CREATE FUNCTION fleet_site_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
   NEW.updated_at=GREATEST(clock_timestamp(),OLD.updated_at+interval '1 microsecond');
   UPDATE fleet_site_versions SET valid_to=NEW.updated_at WHERE site_id=OLD.id AND valid_to IS NULL;
   IF NEW.geometry IS DISTINCT FROM OLD.geometry OR NEW.active IS DISTINCT FROM OLD.active THEN
     NEW.detection_from=NEW.updated_at;
     UPDATE fleet_site_visits SET closed_at=NEW.updated_at,end_reason='configuration' WHERE site_id=OLD.id AND closed_at IS NULL;
     DELETE FROM fleet_site_states WHERE site_id=OLD.id;
   END IF;
 END IF;
 INSERT INTO fleet_site_versions(site_id,owner_id,valid_from,snapshot)
 VALUES(NEW.id,NEW.owner_id,NEW.updated_at,to_jsonb(NEW));
 RETURN NEW;
END $$;
-- AFTER insert is needed for the version's FK; update timestamp is set by API.
CREATE FUNCTION fleet_site_insert_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO fleet_site_versions(site_id,owner_id,valid_from,snapshot)
 VALUES(NEW.id,NEW.owner_id,NEW.updated_at,to_jsonb(NEW)); RETURN NEW;
END $$;
CREATE TRIGGER fleet_site_insert AFTER INSERT ON fleet_sites FOR EACH ROW EXECUTE FUNCTION fleet_site_insert_version();
CREATE TRIGGER fleet_site_update BEFORE UPDATE ON fleet_sites FOR EACH ROW EXECUTE FUNCTION fleet_site_version_change();
