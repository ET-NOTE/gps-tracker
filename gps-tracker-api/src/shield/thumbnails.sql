CREATE TABLE category_thumbnails (
    category text PRIMARY KEY CHECK (length(category) BETWEEN 1 AND 40),
    image_id text REFERENCES post_images(id),
    alt text NOT NULL DEFAULT '' CHECK (length(alt) <= 200),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_by bigint REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (image_id IS NULL OR length(trim(alt)) > 0)
);
CREATE INDEX category_thumbnails_image ON category_thumbnails(image_id);
