-- A group narrows a staff member's existing company role and data scope.
-- No assignment preserves existing permissions, including existing invitations.
CREATE TABLE fleet_permission_groups (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
    permissions TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (owner_id, id),
    CHECK (permissions <@ ARRAY['manage_vehicles','write_reservations','review_reservations',
                                'write_trips','write_expenses','review_expenses']::text[])
);
CREATE UNIQUE INDEX fleet_permission_group_name ON fleet_permission_groups (owner_id, lower(trim(name)));
ALTER TABLE staff ADD COLUMN permission_group_id BIGINT,
    ADD FOREIGN KEY (user_id, permission_group_id) REFERENCES fleet_permission_groups(owner_id, id);
CREATE INDEX staff_permission_group ON staff(user_id, permission_group_id) WHERE permission_group_id IS NOT NULL;
