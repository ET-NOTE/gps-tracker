-- Keep previously published bytes for recovery; new Drive attachments store metadata only.
ALTER TABLE post_files ADD COLUMN drive_url text;
ALTER TABLE post_files ALTER COLUMN data DROP NOT NULL;
ALTER TABLE post_files ADD CONSTRAINT post_files_source CHECK (data IS NOT NULL OR drive_url IS NOT NULL);
ALTER TABLE post_files ADD CONSTRAINT post_files_drive_url CHECK (
    drive_url IS NULL OR (length(drive_url) <= 1000 AND drive_url LIKE 'https://drive.google.com/file/d/%/view%')
);
