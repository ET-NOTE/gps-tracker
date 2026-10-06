-- Only upload-first, unclaimed examples are eligible for automatic expiry.
CREATE TABLE device_enrollments (
 device_id bigint PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX device_enrollments_expiry_idx ON device_enrollments(expires_at);
