-- Collection policy belongs to the SIM's logical device, never its hardware UUID.
ALTER TABLE device_data_controls
 ADD COLUMN collection_paused boolean NOT NULL DEFAULT false,
 ADD COLUMN collection_enforced boolean NOT NULL DEFAULT false,
 ADD COLUMN collection_epoch uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN collection_changed_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN collection_ack_epoch uuid,
 ADD COLUMN collection_ack_uid text,
 ADD COLUMN collection_ack_at timestamptz;

CREATE TABLE collection_control_events (
 id bigserial PRIMARY KEY,
 device_id bigint NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
 actor_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 paused boolean NOT NULL,
 epoch uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);

-- Pause is not erasure: historical records/derived statistics may still be read
-- and corrected. Only new location ingestion and fresh coordinate caches stop.
CREATE FUNCTION collection_guard_location() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c device_data_controls%ROWTYPE;
BEGIN
 SELECT * INTO STRICT c FROM device_data_controls WHERE device_id=NEW.device_id FOR SHARE;
 IF c.collection_paused OR (c.collection_enforced AND
    (NEW.raw#>>'{collection,epoch}' IS DISTINCT FROM c.collection_epoch::text
     OR NEW.raw#>>'{collection,paused}' IS DISTINCT FROM 'false')) THEN
   RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='location collection policy denied';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER collection_location_insert BEFORE INSERT ON location_records
 FOR EACH ROW EXECUTE FUNCTION collection_guard_location();

CREATE FUNCTION collection_guard_cache() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stopped boolean;
BEGIN
 IF (NEW.last_lat,NEW.last_lng,NEW.last_fix_at) IS DISTINCT FROM
    (OLD.last_lat,OLD.last_lng,OLD.last_fix_at) AND NEW.last_fix_at IS NOT NULL THEN
   SELECT collection_paused INTO stopped FROM device_data_controls WHERE device_id=NEW.id FOR SHARE;
   IF stopped THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='location collection paused'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER collection_cache_update BEFORE UPDATE ON devices
 FOR EACH ROW EXECUTE FUNCTION collection_guard_cache();
