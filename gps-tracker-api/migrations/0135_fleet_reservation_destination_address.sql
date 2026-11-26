-- Optional destination address for a vehicle reservation (the visit place stays in purpose).
ALTER TABLE vehicle_reservations ADD COLUMN destination_address text;
ALTER TABLE vehicle_reservations ADD CONSTRAINT vehicle_reservations_destination_address_length
    CHECK (destination_address IS NULL OR char_length(destination_address) BETWEEN 1 AND 200);
