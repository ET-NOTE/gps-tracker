CREATE TABLE library_order (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    content jsonb NOT NULL DEFAULT '{"categories":[],"lessons":{}}'::jsonb,
    revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_by bigint REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO library_order(singleton) VALUES(true);
