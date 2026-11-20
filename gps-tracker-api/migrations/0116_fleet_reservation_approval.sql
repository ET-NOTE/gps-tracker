CREATE TABLE fleet_reservation_policy (
  owner_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  approval_required boolean NOT NULL DEFAULT false
);

ALTER TABLE vehicle_reservations
  ADD COLUMN approval_required boolean NOT NULL DEFAULT false,
  ADD COLUMN submitted_by bigint REFERENCES users(id) ON DELETE SET NULL,
  DROP CONSTRAINT vehicle_reservations_status_check,
  ADD CONSTRAINT vehicle_reservations_status_check CHECK (
    status IN ('planned','in_progress','completed','cancelled')
    OR (approval_required AND status IN ('pending','rejected'))
  ),
  DROP CONSTRAINT fleet_booking_no_overlap,
  ADD CONSTRAINT fleet_booking_no_overlap EXCLUDE USING gist (
    int8range(fleet_vehicle_id,fleet_vehicle_id,'[]') WITH &&,
    tstzrange(starts_at,ends_at,'[)') WITH &&
  ) WHERE (fleet_vehicle_id IS NOT NULL AND status IN ('pending','planned','in_progress'));

-- Runs after fleet_reservation_identity resolves older SIM-based inserts.
-- Policy changes and new bookings observe the same company lock.
CREATE FUNCTION fleet_reservation_policy_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fleet_vehicle_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('fleet-reservations:' || NEW.user_id::text,0));
    NEW.approval_required := EXISTS(SELECT 1 FROM fleet_reservation_policy
      WHERE owner_id=NEW.user_id AND approval_required);
    NEW.submitted_by := COALESCE(NEW.submitted_by,NEW.user_id);
    IF NEW.approval_required THEN
      NEW.status := 'pending';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_reservation_policy_insert BEFORE INSERT ON vehicle_reservations
FOR EACH ROW EXECUTE FUNCTION fleet_reservation_policy_insert();

CREATE FUNCTION fleet_record_reservation_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO fleet_team_audit(owner_id,actor_id,action,target_id,after_value)
    VALUES(NEW.user_id,NEW.submitted_by,'reservation_change',NEW.id,jsonb_build_object('status',NEW.status));
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_record_reservation_request AFTER INSERT ON vehicle_reservations
FOR EACH ROW WHEN (NEW.approval_required) EXECUTE FUNCTION fleet_record_reservation_request();
