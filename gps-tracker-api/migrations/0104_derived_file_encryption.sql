-- 20B additive, OFF by default. Existing values are converted only by maintenance.
SET LOCAL lock_timeout='5s';
ALTER TABLE geocode_cache ADD COLUMN storage_id bigserial UNIQUE NOT NULL;
ALTER TABLE geocode_cache DROP CONSTRAINT geocode_cache_pkey;
ALTER TABLE geocode_cache ADD PRIMARY KEY(storage_id);
CREATE UNIQUE INDEX geocode_cache_cell ON geocode_cache(lat_q,lng_q);
-- Mutable serving roles must not be able to bypass a conversion fence.
ALTER TABLE location_storage_policy ADD COLUMN maintenance boolean NOT NULL DEFAULT false;
CREATE FUNCTION gps_storage_write_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT maintenance FROM location_storage_policy WHERE singleton)
 AND NOT pg_has_role(session_user,(SELECT relowner FROM pg_class WHERE oid='location_storage_policy'::regclass),'USAGE')
 THEN RAISE EXCEPTION 'location storage maintenance'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
-- Full logical row, including bytea PostgreSQL hex representation, with no cipher metadata.
CREATE FUNCTION gps_open_row(tab text, doc jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL RESTRICTED AS $$
DECLARE r record; f text;
BEGIN
 SELECT * INTO STRICT r FROM location_storage_fields WHERE table_name=tab;
 FOREACH f IN ARRAY r.fields LOOP
  IF coalesce(doc->f,'null'::jsonb)='null'::jsonb AND doc->(f||'_sealed') IS NOT NULL AND doc->(f||'_sealed')<>'null'::jsonb THEN
   doc:=jsonb_set(doc,ARRAY[f],coalesce(gps_open_cell(doc->(f||'_sealed'),gps_cell_context(tab,doc,r.identity_columns,f)),'null'::jsonb));
  END IF;
  doc:=doc-(f||'_sealed');
 END LOOP; RETURN doc;
END $$;
INSERT INTO location_storage_fields VALUES('geofences',ARRAY['id'],ARRAY['name','center_lat','center_lng']);
INSERT INTO location_storage_fields VALUES('fleet_sites',ARRAY['id'],ARRAY['name','address','geometry','note']);
INSERT INTO location_storage_fields VALUES('fleet_site_versions',ARRAY['id'],ARRAY['snapshot']);
INSERT INTO location_storage_fields VALUES('fleet_site_visits',ARRAY['id'],ARRAY['site_name','group_name']);
INSERT INTO location_storage_fields VALUES('fleet_trip_corrections',ARRAY['id'],ARRAY['sources','outputs','reason','revert_reason']);
INSERT INTO location_storage_fields VALUES('ai_analyses',ARRAY['id'],ARRAY['analysis']);
INSERT INTO location_storage_fields VALUES('device_audit_log',ARRAY['id'],ARRAY['data']);
INSERT INTO location_storage_fields VALUES('fleet_trip_assignment_audit',ARRAY['id'],ARRAY['before_value','after_value']);
INSERT INTO location_storage_fields VALUES('fleet_vehicle_audit',ARRAY['id'],ARRAY['before_value','after_value']);
INSERT INTO location_storage_fields VALUES('fleet_expense_audit',ARRAY['id'],ARRAY['before_value','after_value']);
INSERT INTO location_storage_fields VALUES('fcm_outbox',ARRAY['id'],ARRAY['message']);
INSERT INTO location_storage_fields VALUES('rental_photos',ARRAY['id'],ARRAY['bytes']);
INSERT INTO location_storage_fields VALUES('fleet_expense_receipts',ARRAY['id'],ARRAY['content']);
INSERT INTO location_storage_fields VALUES('privacy_company_submissions',ARRAY['id'],ARRAY['file_bytes']);
INSERT INTO location_storage_fields VALUES('privacy_image_payloads',ARRAY['delivery_id'],ARRAY['png_bytes']);
INSERT INTO location_storage_fields VALUES('location_1min',ARRAY['device_id','bucket'],ARRAY['lat_avg','lng_avg','lat_last','lng_last']);
INSERT INTO location_storage_fields VALUES('location_5min',ARRAY['device_id','bucket'],ARRAY['lat_avg','lng_avg','lat_last','lng_last']);
INSERT INTO location_storage_fields VALUES('location_1hour',ARRAY['device_id','bucket'],ARRAY['lat_avg','lng_avg','lat_last','lng_last']);
INSERT INTO location_storage_fields VALUES('geocode_cache',ARRAY['storage_id'],ARRAY['lat_q','lng_q','road','jibun','region','building']);

INSERT INTO location_storage_fields VALUES('fleet_team_audit',ARRAY['id'],ARRAY['before_value','after_value']);
-- Restore never needs to expose keys to pg_restore. Physical constraints accept
-- a sealed value; normal writes must pass this unprivileged BEFORE trigger.
-- pg_dump restores triggers only after data, then the transition tool decrypt-scans.
CREATE FUNCTION gps_validate_storage_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb; f text; check_sql text; valid boolean;
BEGIN
 doc:=gps_open_row(TG_TABLE_NAME,to_jsonb(NEW));
 FOR f IN SELECT jsonb_array_elements_text(TG_ARGV[0]::jsonb) LOOP
  IF coalesce(doc->f,'null'::jsonb)='null'::jsonb THEN RAISE EXCEPTION 'required encrypted field: %',f; END IF;
 END LOOP;
 FOR check_sql IN SELECT jsonb_array_elements_text(TG_ARGV[1]::jsonb) LOOP
  EXECUTE format('SELECT (%s) IS NOT FALSE FROM jsonb_populate_record(NULL::public.%I,$1) AS %I',check_sql,TG_TABLE_NAME,TG_TABLE_NAME) INTO valid USING doc;
  IF NOT valid THEN RAISE EXCEPTION 'invalid encrypted row: %',TG_TABLE_NAME; END IF;
 END LOOP;
 RETURN NEW;
END $$;
-- A canonical field expression shared by CHECK constraints and read views.
CREATE FUNCTION gps_storage_expression(tab text, field_name text, ids text[], alias_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT format('CASE WHEN %1$I.%2$I IS NULL THEN %1$I.%3$I ELSE (jsonb_populate_record(NULL::public.%4$I,jsonb_build_object(%3$L,gps_open_cell(%1$I.%2$I,gps_cell_context(%4$L,jsonb_build_object(%5$s),%6$L::text[],%3$L))))).%3$I END',
 alias_name,field_name||'_sealed',field_name,tab,
 (SELECT string_agg(format('%L,to_jsonb(%I.%I)',k,alias_name,k),',') FROM unnest(ids) k),ids)
$$;
DO $$
DECLARE r record; f text; col record; ck record; expr text; projection text; required_fields jsonb; original_checks jsonb; sealed_present text;
BEGIN
 FOR r IN SELECT * FROM location_storage_fields WHERE table_name NOT IN ('devices','events','location_records') LOOP
  FOREACH f IN ARRAY r.fields LOOP
   EXECUTE format('ALTER TABLE %I ADD COLUMN %I jsonb',r.table_name,f||'_sealed');
  END LOOP;
  SELECT coalesce(jsonb_agg(attname),'[]'::jsonb) INTO required_fields FROM pg_attribute
   WHERE attrelid=r.table_name::regclass AND attname=ANY(r.fields) AND attnotnull;
  SELECT coalesce(jsonb_agg(pg_get_expr(conbin,conrelid)),'[]'::jsonb) INTO original_checks
   FROM pg_constraint WHERE conrelid=r.table_name::regclass AND contype='c';
  SELECT string_agg(format('%I IS NOT NULL',v||'_sealed'),' OR ') INTO sealed_present FROM unnest(r.fields) v;
  FOR ck IN SELECT conname,pg_get_expr(conbin,conrelid) expression FROM pg_constraint WHERE conrelid=r.table_name::regclass AND contype='c' LOOP
   EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',r.table_name,ck.conname);
   EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR (%s))',r.table_name,ck.conname,sealed_present,ck.expression);
  END LOOP;
  FOREACH f IN ARRAY r.fields LOOP
   IF (SELECT attnotnull FROM pg_attribute WHERE attrelid=r.table_name::regclass AND attname=f) THEN
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL',r.table_name,f);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IS NOT NULL OR %I IS NOT NULL)',r.table_name,'sealed_required_'||f,f,f||'_sealed');
   END IF;
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I FOR EACH ROW EXECUTE FUNCTION gps_encrypt_location_field(%L,%L,%L)',
    'seal_'||f,f,r.table_name,f,array_to_string(r.identity_columns,','),r.table_name);
  END LOOP;
  EXECUTE format('CREATE TRIGGER zz_gps_storage_validate BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION gps_validate_storage_row(%L,%L)',r.table_name,required_fields::text,original_checks::text);
  projection:='';
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=r.table_name::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum LOOP
   IF col.attname LIKE '%\_sealed' ESCAPE '\' THEN CONTINUE; END IF;
   expr:=format('t.%I',col.attname);
   IF col.attname=ANY(r.fields) THEN expr:=gps_storage_expression(r.table_name,col.attname,r.identity_columns,'t'); END IF;
   projection:=projection||CASE WHEN projection='' THEN '' ELSE ',' END||expr||format(' AS %I',col.attname);
  END LOOP;
  EXECUTE format('CREATE VIEW gps_read_%I AS SELECT %s FROM %I t',r.table_name,projection,r.table_name);
 END LOOP;
 -- Fence every public table, not merely position rows: files/approvals/background jobs also write.
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('_sqlx_migrations','location_storage_policy','location_storage_fields') LOOP
  EXECUTE format('CREATE TRIGGER gps_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION gps_storage_write_fence()',r.tablename);
 END LOOP;
END $$;
-- Preserve snapshot meanings. INSERT sees sealed NEW; UPDATE runs before seal_*.
CREATE OR REPLACE FUNCTION fleet_site_insert_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO fleet_site_versions(site_id,owner_id,valid_from,snapshot)
 VALUES(NEW.id,NEW.owner_id,NEW.updated_at,gps_open_row('fleet_sites',to_jsonb(NEW))); RETURN NEW;
END $$;
-- Readers, including erasure predicates, must resolve logical values.
DO $$
DECLARE r record; definition text; changed text; t text;
BEGIN
 FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind='f' AND p.proname NOT LIKE 'gps_%'
 AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') LOOP
  definition:=pg_get_functiondef(r.oid); changed:=definition;
  FOR t IN SELECT table_name FROM location_storage_fields WHERE table_name NOT IN ('devices','events','location_records') LOOP
   changed:=regexp_replace(changed,'(DELETE\s+FROM\s+)'||t||'\M','\1__gps_delete_'||t,'gi');
   changed:=regexp_replace(changed,'((FROM|JOIN)\s+)'||t||'\M','\1gps_read_'||t,'gi');
   changed:=replace(changed,'__gps_delete_'||t,t);
  END LOOP;
  IF changed<>definition THEN EXECUTE changed; END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION gps_cell_context(table_name text,row_data jsonb,identity_columns text[],field_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_array('gps-location-v1',table_name,field_name,
 (SELECT jsonb_object_agg(k,CASE WHEN k IN ('recorded_at','bucket') THEN to_jsonb((row_data->>k)::timestamptz AT TIME ZONE 'UTC') ELSE row_data->k END) FROM unnest(identity_columns) k))::text
$$;

CREATE FUNCTION gps_geocode_cache_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT enabled FROM location_storage_policy WHERE singleton) AND NOT (SELECT maintenance FROM location_storage_policy WHERE singleton) THEN
  RAISE EXCEPTION 'persistent geocode cache disabled while encrypted'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gps_geocode_cache_guard BEFORE INSERT OR UPDATE ON geocode_cache FOR EACH ROW EXECUTE FUNCTION gps_geocode_cache_guard();
CREATE OR REPLACE FUNCTION fleet_site_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.updated_at=GREATEST(clock_timestamp(),OLD.updated_at+interval '1 microsecond');
 UPDATE fleet_site_versions SET valid_to=NEW.updated_at WHERE site_id=OLD.id AND valid_to IS NULL;
 IF gps_open_row('fleet_sites',to_jsonb(NEW))->'geometry' IS DISTINCT FROM gps_open_row('fleet_sites',to_jsonb(OLD))->'geometry' OR NEW.active IS DISTINCT FROM OLD.active THEN
  NEW.detection_from=NEW.updated_at;
  UPDATE fleet_site_visits SET closed_at=NEW.updated_at,end_reason='configuration' WHERE site_id=OLD.id AND closed_at IS NULL;
  DELETE FROM fleet_site_states WHERE site_id=OLD.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_site_updated_version AFTER UPDATE ON fleet_sites FOR EACH ROW EXECUTE FUNCTION fleet_site_insert_version();
-- These two deletion predicates formerly inspected physical JSON fields.
DO $$
DECLARE r record; d text;
BEGIN
 FOR r IN SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'privacy_erase%' LOOP
  d:=pg_get_functiondef(r.oid);
  d:=replace(d,'DELETE FROM fleet_trip_assignment_audit WHERE before_value->>''device_id''=j.device_id::text OR after_value->>''device_id''=j.device_id::text;',
  'DELETE FROM fleet_trip_assignment_audit WHERE id IN (SELECT id FROM gps_read_fleet_trip_assignment_audit WHERE before_value->>''device_id''=j.device_id::text OR after_value->>''device_id''=j.device_id::text);');
  d:=replace(d,'OR message#>>''{data,device_id}''=j.device_id::text','OR id IN (SELECT id FROM gps_read_fcm_outbox WHERE message#>>''{data,device_id}''=j.device_id::text)');
  EXECUTE d;
 END LOOP;
END $$;

-- Encryption maintenance rewrites the SAME logical data, including retained closed
-- accounts. Never reopen collection or alter privacy controls. Serving roles cannot
-- use this marker: both maintenance and the authenticated schema-owner role are required.
CREATE FUNCTION gps_storage_rewrite_allowed() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(current_setting('gps.storage_rewrite',true),'off')='on'
 AND (SELECT maintenance FROM location_storage_policy WHERE singleton)
 AND pg_has_role(session_user,(SELECT relowner FROM pg_class WHERE oid='location_storage_policy'::regclass),'USAGE')
$$;
DO $$
DECLARE r record; d text;
BEGIN
 FOR r IN SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('privacy_assert_device_writable','privacy_assert_account_active') LOOP
  d:=pg_get_functiondef(r.oid);
  d:=regexp_replace(d,'\mBEGIN\M','BEGIN IF gps_storage_rewrite_allowed() THEN RETURN; END IF;','i');
  EXECUTE d;
 END LOOP;
END $$;
