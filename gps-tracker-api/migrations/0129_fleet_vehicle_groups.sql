CREATE TABLE fleet_vehicle_groups (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 50),
    UNIQUE (owner_id, id)
);
CREATE UNIQUE INDEX fleet_vehicle_groups_name ON fleet_vehicle_groups(owner_id, lower(name));

ALTER TABLE fleet_vehicles ADD COLUMN group_id BIGINT,
    ADD FOREIGN KEY (owner_id, group_id) REFERENCES fleet_vehicle_groups(owner_id, id);
CREATE INDEX fleet_vehicles_group ON fleet_vehicles(owner_id, group_id) WHERE group_id IS NOT NULL;
