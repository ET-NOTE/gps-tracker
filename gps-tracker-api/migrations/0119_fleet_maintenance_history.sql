CREATE TABLE fleet_maintenance_history (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    vehicle_id BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('service','oil','tires','insurance','inspection','other')),
    completed_on DATE NOT NULL,
    note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 400),
    schedule_key TEXT CHECK (schedule_key IN ('next_service_date','insurance_expiry','inspection_expiry')),
    scheduled_on DATE,
    actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    request_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (vehicle_id, owner_id) REFERENCES fleet_vehicles(id, owner_id) ON DELETE CASCADE,
    UNIQUE (owner_id, vehicle_id, request_id),
    CHECK ((schedule_key IS NULL) = (scheduled_on IS NULL))
);
CREATE INDEX fleet_maintenance_history_company_date ON fleet_maintenance_history(owner_id, completed_on DESC, id DESC);
CREATE INDEX fleet_maintenance_history_vehicle_date ON fleet_maintenance_history(owner_id, vehicle_id, completed_on DESC, id DESC);
