-- A company purpose describes the visit. The separate report purpose continues
-- to determine statutory mileage allocations without reclassifying old trips.
CREATE TABLE fleet_trip_purposes (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 50),
    active BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (owner_id, id)
);
CREATE UNIQUE INDEX fleet_trip_purposes_company_name ON fleet_trip_purposes(owner_id, lower(name));

ALTER TABLE vehicle_reservations ADD COLUMN company_purpose_id BIGINT,
    ADD FOREIGN KEY (user_id, company_purpose_id) REFERENCES fleet_trip_purposes(owner_id, id);
ALTER TABLE trip_annotations ADD COLUMN company_purpose_id BIGINT,
    ADD FOREIGN KEY (user_id, company_purpose_id) REFERENCES fleet_trip_purposes(owner_id, id);
CREATE INDEX vehicle_reservations_company_purpose ON vehicle_reservations(user_id, company_purpose_id) WHERE company_purpose_id IS NOT NULL;
CREATE INDEX trip_annotations_company_purpose ON trip_annotations(user_id, company_purpose_id) WHERE company_purpose_id IS NOT NULL;
