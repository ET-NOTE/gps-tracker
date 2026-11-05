-- Rights intake is distinct from execution: accepting a request is NOT erasure.
-- No telemetry identity, ownership, retention period or existing NULL row changes.
CREATE TABLE privacy_requests (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_key UUID NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('access','rectification','erasure','account_closure')),
 scope TEXT NOT NULL CHECK(length(btrim(scope)) BETWEEN 1 AND 2000),
 status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','in_review','needs_information','fulfilled','rejected','cancelled')),
 revision INTEGER NOT NULL DEFAULT 1,
 assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
 due_at TIMESTAMPTZ,
 result_message TEXT NOT NULL DEFAULT '',
 evidence_reference TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id,request_key),
 -- A later, verified erasure executor will remove this guard. The intake
 -- interface must never mark destructive work complete with a checkbox.
 CHECK(kind NOT IN ('erasure','account_closure') OR status <> 'fulfilled')
);
CREATE UNIQUE INDEX privacy_request_open_kind ON privacy_requests(user_id,kind)
 WHERE status IN ('received','in_review','needs_information');
CREATE INDEX privacy_request_queue ON privacy_requests(status,id);
CREATE TABLE privacy_request_events (
 id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES privacy_requests(id) ON DELETE CASCADE,
 actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 revision INTEGER NOT NULL,
 status TEXT NOT NULL,
 message TEXT NOT NULL DEFAULT '',
 evidence_reference TEXT NOT NULL DEFAULT '',
 due_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(request_id,revision)
);
-- Contains no copied telemetry, passwords, documents or payment payloads.
-- Retention/purge for the request itself must be decided with its legal basis;
-- RESTRICT prevents a generic user DELETE from silently losing pending work.
