-- Large receipts are reduced and rotated upright before review. A read proof now names the
-- exact normalized pixels the reviewer was shown, so a selection cannot be applied to pixels
-- produced by a different reduction/orientation. Additive only: earlier rows stay NULL and
-- therefore never satisfy a pixel-bound check (the reviewer simply reads the source again).
ALTER TABLE privacy_receipt_reads
 ADD COLUMN pixels_sha256 TEXT CHECK(pixels_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN normalization JSONB CHECK(normalization IS NULL OR jsonb_typeof(normalization)='object');
-- How the stored original became the delivered raster (source size, output size, EXIF orientation).
-- Describes the transform only; no source pixels or metadata are copied.
ALTER TABLE privacy_image_deliveries
 ADD COLUMN source_normalization JSONB CHECK(source_normalization IS NULL OR (jsonb_typeof(source_normalization)='object' AND receipt_id IS NOT NULL));
