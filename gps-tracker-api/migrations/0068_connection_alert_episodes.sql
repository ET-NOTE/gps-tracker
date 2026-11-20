-- Connection reminders belong to a silence episode, not a rolling daily window.
-- Keep the receipt even if a user clears diagnostic event history.
CREATE TABLE connection_alert_episodes (
    device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('stuck','signal_loss','offline','lost')),
    last_seen_at TIMESTAMPTZ NOT NULL,
    event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
    PRIMARY KEY (device_id,user_id,kind)
);

-- Existing outages have already been announced. Do not announce them again on
-- deployment, including reminders whose original event is older than one day.
INSERT INTO connection_alert_episodes(device_id,user_id,kind,last_seen_at,event_id)
SELECT DISTINCT ON (d.id,d.owner_id,e.kind)
       d.id,d.owner_id,e.kind,d.last_seen_at,e.id
FROM devices d JOIN events e ON e.device_id=d.id AND e.user_id=d.owner_id
WHERE e.kind IN ('stuck','signal_loss','offline','lost')
  AND e.occurred_at >= d.last_seen_at
ORDER BY d.id,d.owner_id,e.kind,e.occurred_at,e.id;

ALTER TABLE notification_settings ALTER COLUMN offline_minutes SET DEFAULT 1440;
-- Upgrade the old default; preserve explicitly different user thresholds.
UPDATE notification_settings SET offline_minutes=1440,updated_at=now()
WHERE offline_minutes=30;

-- Retain audit records, but retire unsent connection reminders from the old policy.
UPDATE fcm_outbox o SET status='cancelled',finished_at=now(),lease_until=NULL,
    last_error='connection_policy_changed'
FROM events e WHERE o.event_id=e.id AND o.status='pending'
  AND e.kind IN ('offline','signal_loss');
