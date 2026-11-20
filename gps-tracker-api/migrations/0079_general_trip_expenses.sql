-- General expenses can share a trip. Only fuel owns its single report amount.
SET LOCAL lock_timeout='5s';
ALTER TABLE fleet_expenses DROP CONSTRAINT fleet_expenses_check1;
DROP INDEX fleet_expense_trip_once;
CREATE UNIQUE INDEX fleet_expense_trip_once ON fleet_expenses(owner_id,source_device_id,trip_started_at)
 WHERE trip_started_at IS NOT NULL AND category_kind='fuel' AND status<>'cancelled';
CREATE INDEX fleet_expense_trip_links ON fleet_expenses(owner_id,source_device_id,binding_id,trip_started_at)
 WHERE trip_started_at IS NOT NULL AND status<>'cancelled';
