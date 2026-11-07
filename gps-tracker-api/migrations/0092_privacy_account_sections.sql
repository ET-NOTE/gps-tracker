-- Existing grants must never acquire broader personal-data scope implicitly.
ALTER TABLE privacy_account_packages ADD COLUMN sections TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE privacy_account_packages ADD CONSTRAINT privacy_account_sections_valid
 CHECK (cardinality(sections)<=3 AND array_position(sections,NULL) IS NULL
 AND sections <@ ARRAY['contact_settings','transactions','activity_metadata']::TEXT[]);
