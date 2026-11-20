-- Round 17: an account package may carry the recorded facts of collection, use and provision of
-- location information for an explicit past period. Only the period is stored here; the facts are
-- read from the existing records when the subject downloads, and never include coordinates.
ALTER TABLE privacy_account_packages DROP CONSTRAINT privacy_account_sections_valid;
ALTER TABLE privacy_account_packages ADD CONSTRAINT privacy_account_sections_valid
 CHECK (cardinality(sections)<=4 AND array_position(sections,NULL) IS NULL
 AND sections <@ ARRAY['contact_settings','transactions','activity_metadata','location_facts']::TEXT[]);
ALTER TABLE privacy_account_packages ADD COLUMN facts_from TIMESTAMPTZ, ADD COLUMN facts_until TIMESTAMPTZ;
-- The period exists exactly when the section is selected, lies in the past and spans at most 366 days.
ALTER TABLE privacy_account_packages ADD CONSTRAINT privacy_account_facts_period
 CHECK ((facts_from IS NULL)=(facts_until IS NULL)
 AND (facts_from IS NOT NULL)=(sections @> ARRAY['location_facts']::TEXT[])
 AND (facts_from IS NULL OR (facts_until>facts_from AND facts_until-facts_from<=interval '366 days' AND facts_until<=created_at)));
