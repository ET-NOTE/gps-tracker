-- Bounded CMS assets live in the same snapshot/backup as their posts.
CREATE TABLE post_images (
    id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
    data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 1572864),
    width integer NOT NULL CHECK (width BETWEEN 1 AND 1600),
    height integer NOT NULL CHECK (height BETWEEN 1 AND 1600),
    created_by bigint REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    attached_at timestamptz
);
CREATE TABLE post_image_links (
    post_slug text NOT NULL REFERENCES content_posts(slug) ON DELETE CASCADE,
    image_id text NOT NULL REFERENCES post_images(id),
    PRIMARY KEY (post_slug, image_id)
);
CREATE INDEX post_image_links_image ON post_image_links(image_id);
