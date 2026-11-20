-- Business vehicles are assets. devices.id remains the SIM telemetry identity.
-- Additive migration: old device APIs and ingest retain their original keys.
CREATE TABLE fleet_vehicles (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    license_plate TEXT,
    car_model TEXT,
    department TEXT,
    manager_staff_id BIGINT REFERENCES staff(id) ON DELETE SET NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    profile JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(profile)='object'),
    legacy_device_id BIGINT REFERENCES devices(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(id,owner_id),
    UNIQUE(owner_id,legacy_device_id)
);
CREATE UNIQUE INDEX fleet_vehicle_plate_unique ON fleet_vehicles(owner_id,replace(license_plate,' ',''))
    WHERE NULLIF(btrim(license_plate),'') IS NOT NULL;

CREATE TABLE fleet_vehicle_bindings (
    id BIGSERIAL PRIMARY KEY,
    vehicle_id BIGINT NOT NULL,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id BIGINT REFERENCES devices(id) ON DELETE SET NULL,
    terminal_name TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    reason TEXT NOT NULL DEFAULT 'connect',
    end_reason TEXT,
    FOREIGN KEY(vehicle_id,owner_id) REFERENCES fleet_vehicles(id,owner_id) ON DELETE CASCADE,
    CHECK (ended_at IS NULL OR ended_at > started_at),
    -- Range types have built-in GiST support; no btree_gist extension required.
    EXCLUDE USING gist (int8range(device_id,device_id,'[]') WITH &&,
        tstzrange(started_at,ended_at,'[)') WITH &&) WHERE (device_id IS NOT NULL),
    EXCLUDE USING gist (int8range(vehicle_id,vehicle_id,'[]') WITH &&,
        tstzrange(started_at,ended_at,'[)') WITH &&) WHERE (is_primary)
);
CREATE INDEX fleet_binding_owner_vehicle ON fleet_vehicle_bindings(owner_id,vehicle_id,started_at);

CREATE TABLE fleet_vehicle_audit (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vehicle_id BIGINT NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    before_value JSONB,
    after_value JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Preserve the existing device-backed vehicle list for every owner, including
-- accounts switching business mode. Future SIM registrations do not create assets.
-- Legacy telemetry remains isolated by user_id.
INSERT INTO fleet_vehicles(owner_id,name,license_plate,car_model,department,enabled,profile,legacy_device_id,created_at)
SELECT d.owner_id,COALESCE(NULLIF(d.car_model,''),NULLIF(d.license_plate,''),NULLIF(d.car_plate,''),'차량 정보 미등록'),
       COALESCE(NULLIF(d.license_plate,''),NULLIF(d.car_plate,'')),d.car_model,d.department,d.enabled,
       jsonb_strip_nulls(jsonb_build_object('model_year',d.model_year,'engine_cc',d.engine_cc,
       'purchase_price_krw',d.purchase_price_krw,'acquired_at',d.acquired_at,'vehicle_type',d.vehicle_type,
       'fuel_type',d.fuel_type,'fuel_efficiency_kmpl',d.fuel_efficiency_kmpl,'note',d.note,
       'next_service_date',d.next_service_date,'next_service_km',d.next_service_km,
       'insurance_expiry',d.insurance_expiry,'inspection_expiry',d.inspection_expiry,
       'car_image_url',d.car_image_url)),d.id,d.created_at
FROM devices d JOIN users u ON u.id=d.owner_id
WHERE d.owner_id IS NOT NULL;

INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,is_primary,started_at,reason)
SELECT v.id,v.owner_id,d.id,COALESCE(d.display_name,d.device_uid),TRUE,'1970-01-01 UTC','legacy_import'
FROM fleet_vehicles v JOIN devices d ON d.id=v.legacy_device_id;

-- Ownership release ends the old company's connection, never transfers its
-- vehicle or historical binding to the next SIM owner.
CREATE FUNCTION fleet_end_owner_bindings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    UPDATE fleet_vehicle_bindings SET ended_at=GREATEST(clock_timestamp(),started_at+interval '1 microsecond'),end_reason='owner_released'
     WHERE device_id=OLD.id AND ended_at IS NULL;
    UPDATE fleet_vehicles SET updated_at=clock_timestamp() WHERE id IN (SELECT vehicle_id FROM fleet_vehicle_bindings WHERE device_id=OLD.id AND owner_id=OLD.owner_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_owner_release AFTER UPDATE OF owner_id ON devices
FOR EACH ROW EXECUTE FUNCTION fleet_end_owner_bindings();

ALTER TABLE vehicle_reservations ADD COLUMN fleet_vehicle_id BIGINT REFERENCES fleet_vehicles(id) ON DELETE RESTRICT;
ALTER TABLE vehicle_reservations ALTER COLUMN device_id DROP NOT NULL;
UPDATE vehicle_reservations r SET fleet_vehicle_id=v.id,device_id=NULL
FROM fleet_vehicles v WHERE v.legacy_device_id=r.device_id AND v.owner_id=r.user_id;
CREATE INDEX fleet_reservation_vehicle_time ON vehicle_reservations(fleet_vehicle_id,starts_at);

-- Older clients cannot overwrite a vehicle booking using a SIM id. New writes
-- keep the SIM reference null; the alert worker resolves the current primary.
CREATE FUNCTION fleet_reservation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.fleet_vehicle_id IS NOT NULL AND NEW.device_id IS NOT NULL THEN
   RAISE EXCEPTION 'Vehicle booking requires vehicle API' USING ERRCODE='23514';
 END IF;
 IF NEW.fleet_vehicle_id IS NULL AND NEW.device_id IS NOT NULL THEN
   SELECT vehicle_id INTO NEW.fleet_vehicle_id FROM fleet_vehicle_bindings
    WHERE device_id=NEW.device_id AND owner_id=NEW.user_id AND ended_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_reservation_identity BEFORE INSERT OR UPDATE OF device_id ON vehicle_reservations
FOR EACH ROW EXECUTE FUNCTION fleet_reservation_identity();
ALTER TABLE vehicle_reservations ADD CONSTRAINT fleet_booking_no_overlap
 EXCLUDE USING gist(int8range(fleet_vehicle_id,fleet_vehicle_id,'[]') WITH &&,
 tstzrange(starts_at,ends_at,'[)') WITH &&)
 WHERE (fleet_vehicle_id IS NOT NULL AND status IN ('planned','in_progress'));

-- Documents move with the vehicle asset, not with a subsequently reused SIM.
ALTER TABLE device_documents ADD COLUMN fleet_vehicle_id BIGINT REFERENCES fleet_vehicles(id) ON DELETE CASCADE;
ALTER TABLE device_documents ALTER COLUMN device_id DROP NOT NULL;
UPDATE device_documents doc SET fleet_vehicle_id=v.id,device_id=NULL
 FROM fleet_vehicles v WHERE doc.device_id=v.legacy_device_id AND doc.user_id=v.owner_id;
ALTER TABLE device_documents ADD CONSTRAINT document_identity CHECK ((device_id IS NULL) <> (fleet_vehicle_id IS NULL));
