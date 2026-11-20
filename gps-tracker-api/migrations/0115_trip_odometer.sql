-- Dashboard readings are entered explicitly, never inferred from GPS distance.
-- Existing rows deliberately remain NULL. The annotation audit trigger stores
-- the complete before/after row and therefore includes these fields unchanged.
ALTER TABLE trip_annotations
    ADD COLUMN odometer_before_km NUMERIC(9,2),
    ADD COLUMN odometer_after_km NUMERIC(9,2),
    ADD CONSTRAINT trip_annotation_odometer_pair CHECK (
        (odometer_before_km IS NULL AND odometer_after_km IS NULL)
        OR (odometer_before_km IS NOT NULL AND odometer_after_km IS NOT NULL
            AND odometer_before_km >= 0
            AND odometer_before_km <= 9999999.99
            AND odometer_after_km >= odometer_before_km
            AND odometer_after_km <= 9999999.99)
    );
