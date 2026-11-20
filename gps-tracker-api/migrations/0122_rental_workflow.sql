ALTER TABLE rental_contracts
    ALTER COLUMN device_id DROP NOT NULL,
    ADD COLUMN rental_terms JSONB,
    ADD CONSTRAINT rental_unassigned_reservation CHECK (
        device_id IS NOT NULL OR (rental_terms IS NOT NULL AND status IN ('draft', 'cancelled'))
    );

CREATE TABLE rental_operating_policies (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 1440),
    require_license BOOLEAN NOT NULL DEFAULT FALSE,
    require_contract BOOLEAN NOT NULL DEFAULT FALSE,
    require_payment BOOLEAN NOT NULL DEFAULT FALSE,
    late_hourly INTEGER CHECK (late_hourly BETWEEN 0 AND 10000000),
    notify_return BOOLEAN NOT NULL DEFAULT TRUE
);
