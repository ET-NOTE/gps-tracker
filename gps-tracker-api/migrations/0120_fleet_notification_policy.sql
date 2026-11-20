CREATE TABLE fleet_notification_policy (
    owner_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings jsonb NOT NULL DEFAULT '{}',
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    CHECK (jsonb_typeof(settings) = 'object')
);

-- The delivery queue contains operational identifiers only. Addresses are resolved
-- from active accounts immediately before delivery and never copied into the queue.
CREATE TABLE fleet_notification_mail (
    id bigserial PRIMARY KEY,
    owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category text NOT NULL CHECK (category IN ('reservation','trip','maintenance','connection','expense')),
    source_key text NOT NULL,
    record_id bigint,
    vehicle_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    finished_at timestamptz,
    preview boolean NOT NULL DEFAULT false,
    FOREIGN KEY (vehicle_id,owner_id) REFERENCES fleet_vehicles(id,owner_id) ON DELETE CASCADE,
    UNIQUE (owner_id,recipient_id,category,source_key)
);
CREATE INDEX fleet_notification_mail_pending ON fleet_notification_mail(next_attempt_at,id)
    WHERE finished_at IS NULL;

CREATE FUNCTION fleet_queue_notice(company bigint, recipient bigint, kind text, source text, vehicle bigint, source_id bigint DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
    INSERT INTO fleet_notification_mail(owner_id,recipient_id,category,source_key,vehicle_id,record_id)
    SELECT p.owner_id,coalesce(recipient,company),kind,source,vehicle,source_id
    FROM fleet_notification_policy p WHERE p.owner_id=company AND (p.settings->>'email')::boolean
      AND coalesce((p.settings->>kind)::boolean,true)
    ON CONFLICT(owner_id,recipient_id,category,source_key) DO NOTHING
$$;

CREATE FUNCTION fleet_notice_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
BEGIN
    IF NEW.fleet_vehicle_id IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
    IF OLD.status='pending' AND NEW.status IN ('planned','rejected') THEN kind:='reservation';
    ELSIF NEW.status IN ('in_progress','completed') THEN kind:='trip';
    ELSE RETURN NULL; END IF;
    PERFORM fleet_queue_notice(NEW.user_id,NEW.submitted_by,kind,
        'booking-'||NEW.id||'-'||extract(epoch FROM NEW.updated_at)||'-'||NEW.status, NEW.fleet_vehicle_id,NEW.id);
    RETURN NULL;
END $$;
CREATE TRIGGER fleet_notice_booking_change AFTER UPDATE OF status ON vehicle_reservations
    FOR EACH ROW EXECUTE FUNCTION fleet_notice_booking();

CREATE FUNCTION fleet_notice_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('approved','rejected') THEN
        PERFORM fleet_queue_notice(NEW.owner_id,NEW.created_by,'expense',
            'expense-'||NEW.id||'-'||extract(epoch FROM NEW.reviewed_at), NEW.vehicle_id,NEW.id);
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER fleet_notice_expense_change AFTER UPDATE OF status ON fleet_expenses
    FOR EACH ROW EXECUTE FUNCTION fleet_notice_expense();

CREATE FUNCTION fleet_notice_connection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE asset bigint;
BEGIN
    IF NEW.event_id IS NULL OR NEW.event_id IS NOT DISTINCT FROM OLD.event_id
       OR NOT EXISTS(SELECT 1 FROM fleet_notification_policy p WHERE p.owner_id=NEW.user_id
           AND (p.settings->>'email')::boolean AND coalesce((p.settings->>'connection')::boolean,true))
       THEN RETURN NULL; END IF;
    SELECT b.vehicle_id INTO asset FROM fleet_vehicle_bindings b
       WHERE b.device_id=NEW.device_id AND b.owner_id=NEW.user_id AND b.is_primary AND b.ended_at IS NULL
       AND b.started_at<=NEW.last_seen_at;
    IF asset IS NOT NULL THEN
        PERFORM fleet_queue_notice(NEW.user_id,NEW.user_id,'connection','episode-'||NEW.event_id,asset);
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER fleet_notice_connection_episode AFTER UPDATE OF event_id ON connection_alert_episodes
    FOR EACH ROW EXECUTE FUNCTION fleet_notice_connection();
