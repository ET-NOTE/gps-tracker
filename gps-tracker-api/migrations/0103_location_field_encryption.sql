-- Additive pilot: no existing row conversion or production enablement at startup.
-- Keys are connection-local, loaded from a private file outside the database.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE location_storage_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 activated_at timestamptz
);
INSERT INTO location_storage_policy(singleton) VALUES(true);

CREATE FUNCTION gps_seal_cell(value jsonb, context text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ring jsonb; kid text; secret text;
BEGIN
 IF value IS NULL OR value='null'::jsonb THEN RETURN NULL; END IF;
 ring:=nullif(current_setting('gps.storage_keys',true),'')::jsonb;
 kid:=ring->>'active'; secret:=ring->'keys'->>kid;
 IF secret IS NULL OR octet_length(decode(secret,'base64'))<>32 THEN
  RAISE EXCEPTION 'location encryption key unavailable'; END IF;
 RETURN jsonb_build_object('v',1,'kid',kid,'cipher',encode(public.pgp_sym_encrypt(
  jsonb_build_object('context',context,'kid',kid,'value',value)::text,secret,
  'cipher-algo=aes256,sess-key=1,s2k-mode=0,compress-algo=0,disable-mdc=0'),'base64'));
END $$;

CREATE FUNCTION gps_open_cell(envelope jsonb, context text) RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL RESTRICTED SET search_path=pg_catalog,public AS $$
DECLARE ring jsonb; secret text; plain jsonb;
BEGIN
 IF envelope IS NULL THEN RETURN NULL; END IF;
 ring:=nullif(current_setting('gps.storage_keys',true),'')::jsonb;
 secret:=ring->'keys'->>(envelope->>'kid');
 IF envelope->>'v' IS DISTINCT FROM '1' OR secret IS NULL OR octet_length(decode(secret,'base64'))<>32 THEN
  RAISE EXCEPTION 'location decryption key unavailable'; END IF;
 BEGIN
  plain:=public.pgp_sym_decrypt(decode(envelope->>'cipher','base64'),secret)::jsonb;
  IF plain->>'context' IS DISTINCT FROM context OR plain->>'kid' IS DISTINCT FROM envelope->>'kid'
    OR NOT plain ? 'value' THEN RAISE EXCEPTION 'invalid envelope'; END IF;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'location ciphertext authentication failed'; END;
 RETURN plain->'value';
END $$;

CREATE FUNCTION gps_cell_context(table_name text, row_data jsonb, identity_columns text[], field_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_array('gps-location-v1',table_name,field_name,
   (SELECT jsonb_object_agg(k,CASE WHEN k='recorded_at' THEN to_jsonb((row_data->>k)::timestamptz AT TIME ZONE 'UTC') ELSE row_data->k END) FROM unnest(identity_columns) k))::text
$$;

CREATE FUNCTION gps_encrypt_location_field() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE doc jsonb; field_name text:=TG_ARGV[0]; encrypted_name text:=TG_ARGV[0]||'_sealed';
BEGIN
 IF NOT (SELECT enabled FROM public.location_storage_policy WHERE singleton) THEN RETURN NEW; END IF;
 doc:=to_jsonb(NEW);
 NEW:=jsonb_populate_record(NEW,jsonb_build_object(encrypted_name,
  public.gps_seal_cell(doc->field_name,public.gps_cell_context(TG_ARGV[2],doc,string_to_array(TG_ARGV[1],','),field_name)),
  field_name,NULL));
 RETURN NEW;
END $$;

-- Immutable primary identities bind ciphertext to a table/row/field. SIM owner
-- changes are deliberately not part of the binding; historical owner is retained.
CREATE TABLE location_storage_fields (
 table_name text PRIMARY KEY, identity_columns text[] NOT NULL, fields text[] NOT NULL
);
INSERT INTO location_storage_fields VALUES
 ('location_records',ARRAY['device_id','recorded_at','source'],ARRAY['lat','lng','raw','fixes_jsonb']),
 ('devices',ARRAY['id'],ARRAY['last_lat','last_lng','last_stationary']),
 ('events',ARRAY['id'],ARRAY['data']);

DO $$
DECLARE target record; f text; column_info record; projection text; expression text;
BEGIN
 FOR target IN SELECT * FROM location_storage_fields ORDER BY table_name LOOP
  FOREACH f IN ARRAY target.fields LOOP
   EXECUTE format('ALTER TABLE public.%I ADD COLUMN %I jsonb',target.table_name,f||'_sealed');
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON public.%I FOR EACH ROW EXECUTE FUNCTION gps_encrypt_location_field(%L,%L,%L)',
     'seal_'||f,f,target.table_name,f,array_to_string(target.identity_columns,','),target.table_name);
  END LOOP;
  projection:='';
  FOR column_info IN SELECT attname,format_type(atttypid,atttypmod) typ FROM pg_attribute
   WHERE attrelid=format('public.%I',target.table_name)::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum LOOP
   IF column_info.attname LIKE '%\_sealed' ESCAPE '\' THEN CONTINUE; END IF;
   expression:=format('t.%I',column_info.attname);
   IF column_info.attname=ANY(target.fields) THEN
    expression:=format('CASE WHEN t.%I IS NULL THEN t.%I ELSE (jsonb_populate_record(NULL::public.%I,jsonb_build_object(%L,public.gps_open_cell(t.%I,public.gps_cell_context(%L,to_jsonb(t),%L::text[],%L))))).%I END',
      column_info.attname||'_sealed',column_info.attname,target.table_name,column_info.attname,
      column_info.attname||'_sealed',target.table_name,target.identity_columns,column_info.attname,column_info.attname);
   END IF;
   projection:=projection||CASE WHEN projection='' THEN '' ELSE ',' END||expression||format(' AS %I',column_info.attname);
  END LOOP;
  EXECUTE format('CREATE VIEW public.gps_read_%I AS SELECT %s FROM public.%I t',target.table_name,projection,target.table_name);
 END LOOP;
END $$;

-- Existing canonical projection and bounded SQL functions must decrypt before
-- coordinates are expanded/aggregated. DML targets remain the physical tables.
DO $$
DECLARE r record; definition text; changed text; t text;
BEGIN
 definition:=pg_get_viewdef('location_points'::regclass,true);
 definition:=regexp_replace(definition,'FROM location_records\M','FROM gps_read_location_records','g');
 EXECUTE 'CREATE OR REPLACE VIEW location_points AS '||definition;
 FOR r IN SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prokind='f' AND p.proname NOT LIKE 'gps_%'
     AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') LOOP
  definition:=pg_get_functiondef(r.oid); changed:=definition;
  -- Session key access belongs on the leader. Do not preserve an older SAFE
  -- declaration on wrappers which now read decrypted projections.
  IF r.proname LIKE 'location_%' THEN
   changed:=replace(changed,'PARALLEL SAFE','PARALLEL RESTRICTED');
  END IF;
  FOREACH t IN ARRAY ARRAY['location_records','devices','events'] LOOP
   -- DELETE FROM must never become a delete through a computed view.
   changed:=regexp_replace(changed,'(DELETE\s+FROM\s+)'||t||'\M','\1__gps_delete_'||t,'gi');
   changed:=regexp_replace(changed,'((FROM|JOIN)\s+)'||t||'\M','\1gps_read_'||t,'gi');
   changed:=replace(changed,'__gps_delete_'||t,t);
  END LOOP;
  IF changed<>definition THEN EXECUTE changed; END IF;
 END LOOP;
END $$;
