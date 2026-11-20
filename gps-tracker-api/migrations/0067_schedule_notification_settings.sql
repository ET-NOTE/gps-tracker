-- Schedule reminders belong to the vehicle owner, with separate opt-outs.
ALTER TABLE notification_settings
  ADD COLUMN reservation_alert boolean NOT NULL DEFAULT true,
  ADD COLUMN rental_alert boolean NOT NULL DEFAULT true;
