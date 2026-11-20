CREATE TABLE rental_branches (
    id bigserial PRIMARY KEY,
    owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    UNIQUE(owner_id, name), UNIQUE(owner_id, id)
);
CREATE TABLE rental_staff_groups (
    id bigserial PRIMARY KEY,
    owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    permissions text[] NOT NULL CHECK (permissions <@ ARRAY['dispatch_read','service_read','handover_note']),
    revision integer NOT NULL DEFAULT 1,
    UNIQUE(owner_id, name), UNIQUE(owner_id, id)
);
CREATE TABLE rental_staff (
    id bigserial PRIMARY KEY,
    owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id bigint REFERENCES users(id) ON DELETE SET NULL,
    email text NOT NULL, name text NOT NULL, branch_id bigint NOT NULL, group_id bigint NOT NULL,
    active boolean NOT NULL DEFAULT true, invite_digest text, expires_at timestamptz,
    revision integer NOT NULL DEFAULT 1,
    FOREIGN KEY(owner_id, branch_id) REFERENCES rental_branches(owner_id, id),
    FOREIGN KEY(owner_id, group_id) REFERENCES rental_staff_groups(owner_id, id),
    UNIQUE(owner_id, email), UNIQUE(owner_id, account_id), UNIQUE(invite_digest),
    CHECK(owner_id IS DISTINCT FROM account_id)
);
CREATE TABLE rental_handover_notes (
    id bigserial PRIMARY KEY, contract_id bigint NOT NULL REFERENCES rental_contracts(id) ON DELETE CASCADE,
    staff_id bigint NOT NULL REFERENCES rental_staff(id) ON DELETE CASCADE,
    branch_id bigint NOT NULL REFERENCES rental_branches(id) ON DELETE CASCADE,
    body text NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rental_handover_contract ON rental_handover_notes(contract_id, branch_id);
