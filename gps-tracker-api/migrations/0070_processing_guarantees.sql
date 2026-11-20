ALTER TABLE stats_rebuild_queue
    ADD COLUMN attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN last_error text;

-- One canonical plate value, including old clients which write license_plate.
UPDATE devices SET license_plate=car_plate WHERE car_plate IS NOT NULL;
UPDATE devices SET car_plate=license_plate WHERE car_plate IS NULL;
CREATE FUNCTION sync_device_plate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.license_plate:=NULLIF(btrim(COALESCE(NEW.car_plate,NEW.license_plate)), '');
  ELSIF NEW.car_plate IS DISTINCT FROM OLD.car_plate THEN
    IF NEW.license_plate IS DISTINCT FROM OLD.license_plate
       AND NEW.car_plate IS DISTINCT FROM NEW.license_plate THEN
      RAISE EXCEPTION 'conflicting vehicle plate values';
    END IF;
    NEW.license_plate:=NULLIF(btrim(NEW.car_plate),'');
  ELSIF NEW.license_plate IS DISTINCT FROM OLD.license_plate THEN
    NEW.license_plate:=NULLIF(btrim(NEW.license_plate),'');
  END IF;
  NEW.car_plate:=NEW.license_plate;
  RETURN NEW;
END $$;
CREATE TRIGGER devices_plate BEFORE INSERT OR UPDATE OF car_plate,license_plate ON devices
FOR EACH ROW EXECUTE FUNCTION sync_device_plate();

CREATE TABLE device_commands (
    id uuid PRIMARY KEY,
    device_id bigint NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id bigint REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK(kind IN ('beep','reset','post_interval')),
    arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
    requested_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    acknowledged_at timestamptz,
    cancelled_at timestamptz
);
CREATE INDEX device_commands_pending ON device_commands(device_id,requested_at)
    WHERE acknowledged_at IS NULL AND cancelled_at IS NULL;
