CREATE TABLE cargo_staff_groups (
    id bigserial PRIMARY KEY,
    owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    permissions text[] NOT NULL CHECK (permissions <@ ARRAY['dispatch_read','fleet_read','handover_note']),
    revision integer NOT NULL DEFAULT 1,
    UNIQUE(owner_id, name), UNIQUE(owner_id, id)
);
CREATE TABLE cargo_staff (
    id bigserial PRIMARY KEY,
    owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id bigint REFERENCES users(id) ON DELETE SET NULL,
    email text NOT NULL, name text NOT NULL, branch_id text NOT NULL, group_id bigint NOT NULL,
    active boolean NOT NULL DEFAULT true, invite_digest text, expires_at timestamptz,
    revision integer NOT NULL DEFAULT 1,
    FOREIGN KEY(owner_id, group_id) REFERENCES cargo_staff_groups(owner_id, id),
    UNIQUE(owner_id, email), UNIQUE(owner_id, account_id), UNIQUE(invite_digest),
    CHECK(owner_id IS DISTINCT FROM account_id)
);
CREATE TABLE cargo_handover_notes (
    id bigserial PRIMARY KEY, shipment_id text NOT NULL,
    staff_id bigint NOT NULL REFERENCES cargo_staff(id) ON DELETE CASCADE,
    branch_id text NOT NULL,
    body text NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cargo_handover_contract ON cargo_handover_notes(shipment_id, branch_id);

CREATE TABLE cargo_companies (
    owner_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL, representative text NOT NULL, phone text NOT NULL,
    business_number text NOT NULL, address text NOT NULL, revision integer NOT NULL DEFAULT 1
);
