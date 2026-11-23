-- Company operating policy. A missing row means the defaults below.
CREATE TABLE fleet_operating_policy (
    owner_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    expense_approval_required boolean NOT NULL DEFAULT true,
    trip_purpose_required boolean NOT NULL DEFAULT false,
    personal_use_allowed boolean NOT NULL DEFAULT true,
    review_after_trip boolean NOT NULL DEFAULT true,
    offline_minutes integer NOT NULL DEFAULT 10 CHECK (offline_minutes BETWEEN 1 AND 240),
    revision bigint NOT NULL CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Expenses saved while approval is not required are approved without a reviewer.
-- They stay editable by their writer until someone reviews or cancels them.
ALTER TABLE fleet_expenses ADD COLUMN auto_approved boolean NOT NULL DEFAULT false;
ALTER TABLE fleet_expenses ADD CONSTRAINT fleet_expenses_auto_approved
    CHECK (NOT auto_approved OR status = 'approved');

-- A writer's own re-save that is approved automatically is not a review result.
CREATE OR REPLACE FUNCTION fleet_notice_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('approved','rejected')
       AND NOT NEW.auto_approved THEN
        PERFORM fleet_queue_notice(NEW.owner_id,NEW.created_by,'expense',
            'expense-'||NEW.id||'-'||extract(epoch FROM NEW.reviewed_at), NEW.vehicle_id,NEW.id);
    END IF;
    RETURN NULL;
END $$;

ALTER TABLE fleet_permission_groups ADD COLUMN description text
    CHECK (description IS NULL OR char_length(description) <= 200);

ALTER TABLE corporate_info
    ADD COLUMN phone text CHECK (phone IS NULL OR char_length(phone) <= 30),
    ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Seoul' CHECK (char_length(timezone) BETWEEN 1 AND 64);

DO $$
DECLARE runtime_role oid := to_regrole('gps_runtime');
BEGIN
    IF runtime_role IS NOT NULL AND has_table_privilege(runtime_role,'fleet_booking_hours','INSERT') THEN
        GRANT SELECT, INSERT, UPDATE ON fleet_operating_policy TO gps_runtime;
    END IF;
END
$$;
