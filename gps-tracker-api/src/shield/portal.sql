CREATE TABLE post_files (
    id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
    filename text NOT NULL,
    data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 5242880),
    created_by bigint REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    attached_at timestamptz
);
CREATE TABLE post_file_links (
    post_slug text NOT NULL REFERENCES content_posts(slug) ON DELETE CASCADE,
    file_id text NOT NULL REFERENCES post_files(id),
    PRIMARY KEY(post_slug,file_id)
);
CREATE INDEX post_file_links_file ON post_file_links(file_id);
CREATE TABLE site_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    guide_slug text REFERENCES content_posts(slug)
);
INSERT INTO site_settings(singleton) VALUES(true);
