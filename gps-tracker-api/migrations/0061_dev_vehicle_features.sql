-- Preserve the June dev fork using new production migration numbers.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS next_service_date date,
    ADD COLUMN IF NOT EXISTS next_service_km integer CHECK (next_service_km >= 0),
    ADD COLUMN IF NOT EXISTS insurance_expiry date,
    ADD COLUMN IF NOT EXISTS inspection_expiry date,
    ADD COLUMN IF NOT EXISTS car_plate text,
    ADD COLUMN IF NOT EXISTS car_model text,
    ADD COLUMN IF NOT EXISTS car_image_url text;
ALTER TABLE location_records ADD COLUMN IF NOT EXISTS speed_kmh real;
