-- Operational state only. Evidence and delivery rows are not coalesced or removed.
SET LOCAL lock_timeout='5s';
CREATE TABLE location_notice_worker (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 seen_at timestamptz,
 provider_configured boolean NOT NULL DEFAULT false,
 next_dispatch_at timestamptz NOT NULL DEFAULT '-infinity',
 cooldown_until timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO location_notice_worker DEFAULT VALUES;
CREATE INDEX location_notice_unsettled ON location_provision_notices(delivery,started_at)
 WHERE delivery IN ('waiting','pending','review');
CREATE INDEX location_notice_attempt_time ON location_notice_attempts(at);
