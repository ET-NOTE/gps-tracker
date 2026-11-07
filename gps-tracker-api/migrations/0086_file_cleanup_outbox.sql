-- Removal from the active DB and local file removal are separate, retryable work.
-- No FK to users/assets: cascade deletion must not erase the cleanup obligation.
-- This is NOT proof of backup/cache/external-copy erasure.
CREATE TABLE privacy_file_cleanup (
 id BIGSERIAL PRIMARY KEY,
 storage_kind TEXT NOT NULL CHECK(storage_kind IN ('document','car_image')),
 storage_key TEXT NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 4096),
 source_table TEXT NOT NULL, source_id BIGINT NOT NULL, owner_id BIGINT,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','retry','blocked','shared','local_absent')),
 attempts INTEGER NOT NULL DEFAULT 0,
 reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 local_verified_at TIMESTAMPTZ,
 UNIQUE(storage_kind,storage_key),
 CHECK((state='local_absent')=(local_verified_at IS NOT NULL))
);
CREATE INDEX privacy_file_cleanup_due ON privacy_file_cleanup(next_attempt_at,id)
 WHERE state IN ('pending','retry','shared');
CREATE TABLE privacy_file_cleanup_events (
 id BIGSERIAL PRIMARY KEY, job_id BIGINT NOT NULL REFERENCES privacy_file_cleanup(id),
 state TEXT NOT NULL, reason TEXT NOT NULL, attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- One file may be referenced by several accounts/assets. Preserve every removal
-- source rather than attributing the shared cleanup only to the first account.
CREATE TABLE privacy_file_cleanup_sources (
 id BIGSERIAL PRIMARY KEY, job_id BIGINT NOT NULL REFERENCES privacy_file_cleanup(id),
 source_table TEXT NOT NULL, source_id BIGINT NOT NULL, owner_id BIGINT,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX privacy_file_cleanup_sources_owner ON privacy_file_cleanup_sources(owner_id,job_id);

CREATE FUNCTION privacy_queue_old_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE file_key TEXT; kind TEXT; uid BIGINT; cleanup_id BIGINT;
BEGIN
 IF TG_TABLE_NAME='device_documents' THEN
  file_key:=OLD.stored_path; kind:='document'; uid:=OLD.user_id;
  IF TG_OP='UPDATE' AND NEW.stored_path IS NOT DISTINCT FROM file_key THEN RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='devices' THEN
  file_key:=OLD.car_image_url; kind:='car_image'; uid:=OLD.owner_id;
  IF TG_OP='UPDATE' AND NEW.car_image_url IS NOT DISTINCT FROM file_key THEN RETURN NEW; END IF;
 ELSE
  file_key:=OLD.profile->>'car_image_url'; kind:='car_image'; uid:=OLD.owner_id;
  IF TG_OP='UPDATE' AND NEW.profile->>'car_image_url' IS NOT DISTINCT FROM file_key THEN RETURN NEW; END IF;
 END IF;
 IF NULLIF(file_key,'') IS NOT NULL THEN
  INSERT INTO privacy_file_cleanup(storage_kind,storage_key,source_table,source_id,owner_id)
   VALUES(kind,file_key,TG_TABLE_NAME,OLD.id,uid)
  ON CONFLICT(storage_kind,storage_key) DO UPDATE SET
   state='pending',reason=NULL,local_verified_at=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
  RETURNING id INTO cleanup_id;
  INSERT INTO privacy_file_cleanup_sources(job_id,source_table,source_id,owner_id)
   VALUES(cleanup_id,TG_TABLE_NAME,OLD.id,uid);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_document_cleanup AFTER DELETE OR UPDATE OF stored_path ON device_documents
 FOR EACH ROW EXECUTE FUNCTION privacy_queue_old_file();
CREATE TRIGGER privacy_device_image_cleanup AFTER DELETE OR UPDATE OF car_image_url ON devices
 FOR EACH ROW EXECUTE FUNCTION privacy_queue_old_file();
CREATE TRIGGER privacy_fleet_image_cleanup AFTER DELETE OR UPDATE OF profile ON fleet_vehicles
 FOR EACH ROW EXECUTE FUNCTION privacy_queue_old_file();
COMMENT ON TABLE privacy_file_cleanup IS 'Local file cleanup only. Backup, browser, external recipients and DB retention require separate review.';
