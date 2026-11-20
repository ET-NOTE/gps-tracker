-- Revision-checked writes make a dispatch, its orders and its accounting one unit.
CREATE TABLE cargo_workspaces (
    owner_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision bigint NOT NULL CHECK (revision > 0),
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cargo_proof_images (
    id text PRIMARY KEY,
    owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    digest bytea NOT NULL,
    content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
    content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 512000),
    created_at timestamptz NOT NULL DEFAULT now(),
    attached boolean NOT NULL DEFAULT false,
    UNIQUE(owner_id, digest)
);
CREATE INDEX cargo_staged_images ON cargo_proof_images(owner_id, created_at) WHERE NOT attached;
