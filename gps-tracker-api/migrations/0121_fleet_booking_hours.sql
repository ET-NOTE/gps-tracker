CREATE TABLE fleet_booking_hours (
    owner_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    week_mask integer NOT NULL CHECK (week_mask BETWEEN 1 AND 127),
    open_minute integer NOT NULL CHECK (open_minute BETWEEN 0 AND 1439),
    close_minute integer NOT NULL CHECK (close_minute BETWEEN 1 AND 1440 AND close_minute > open_minute),
    revision bigint NOT NULL CHECK (revision > 0)
);

-- Check the occupied interval [start,end) in Korean local time, including days
-- between the endpoints. Existing bookings can still be completed or cancelled.
CREATE FUNCTION fleet_check_booking_hours() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    hours fleet_booking_hours%ROWTYPE;
    local_start timestamp;
    local_end timestamp;
    last_day date;
BEGIN
    IF NEW.fleet_vehicle_id IS NULL THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
        IF (NEW.fleet_vehicle_id,NEW.starts_at,NEW.ends_at) IS NOT DISTINCT FROM
           (OLD.fleet_vehicle_id,OLD.starts_at,OLD.ends_at) THEN RETURN NEW; END IF;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fleet-reservations:' || NEW.user_id::text,0));
    SELECT * INTO hours FROM fleet_booking_hours WHERE owner_id=NEW.user_id;
    IF NOT FOUND OR (hours.week_mask=127 AND hours.open_minute=0 AND hours.close_minute=1440)
    THEN RETURN NEW; END IF;
    local_start := NEW.starts_at AT TIME ZONE 'Asia/Seoul';
    local_end := NEW.ends_at AT TIME ZONE 'Asia/Seoul';
    last_day := (local_end - interval '1 microsecond')::date;
    IF EXISTS (
        SELECT FROM generate_series(0,LEAST(last_day-local_start::date,6)) AS days(i)
        WHERE (hours.week_mask & (1 << (extract(isodow FROM local_start::date+i)::integer-1))) = 0
    ) OR local_start < local_start::date + make_interval(mins => hours.open_minute)
       OR local_end > last_day + make_interval(mins => hours.close_minute)
       OR (last_day > local_start::date AND (hours.open_minute<>0 OR hours.close_minute<>1440))
    THEN
        RAISE EXCEPTION 'Outside fleet booking hours' USING
            ERRCODE='23514', CONSTRAINT='fleet_booking_hours_interval';
    END IF;
    RETURN NEW;
END $$;

-- Sort after fleet_reservation_identity, which resolves bookings from older clients.
CREATE TRIGGER fleet_z_booking_hours BEFORE INSERT OR UPDATE OF fleet_vehicle_id,device_id,starts_at,ends_at
ON vehicle_reservations FOR EACH ROW EXECUTE FUNCTION fleet_check_booking_hours();
