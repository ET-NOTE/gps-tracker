"""18B schema 99 -> 101 OFF upgrade / empty-ledger rollback rehearsal.
This ONLY runs against the disposable Docker job. Not a production deployer.
"""
import pathlib, shutil
here=pathlib.Path(__file__).parent
exec(compile((here/'test_privacy_packages.py').read_text().split('owner,other,admin=')[0],__file__,'exec'))
BASELINE='fa1e51e3d39473ca2852ac6b2899790547fa6667bb7337c646d29258a3e1c0fe'
assert digest==BASELINE and sql('SELECT max(version) FROM _sqlx_migrations')==99
assert cfg.get('GPS_LOCATION_ACCESS_LOG','off')!='on'
previous=here/'out/gps-tracker-api.baseline99';shutil.copyfile(binary,previous)
candidate=here/'out/gps-tracker-api.18b'
candidate_hash=hashlib.sha256(candidate.read_bytes()).hexdigest()
def fingerprint():
 return sql("SELECT md5(jsonb_build_array((SELECT jsonb_agg(jsonb_build_array(id,email,role) ORDER BY id) FROM users),(SELECT jsonb_agg(jsonb_build_array(id,device_uid,owner_id) ORDER BY id) FROM devices),(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM privacy_requests p))::text)")
before=fingerprint()
def helper(action):
 import os
 r=subprocess.run(['bash',str(here/'dev18.sh'),action],env={**os.environ,'LEDGER':'','KEEP_DAYS':'','ERASURE':''},capture_output=True,text=True)
 assert r.returncode==0,(action,r.stdout,r.stderr)
def install(source):
 helper('stop');shutil.copyfile(source,binary);helper('api')
def empty():
 for table in ['location_access_events','location_access_log','location_access_coverage','location_access_erasure_runs']:
  assert sql('SELECT count(*) FROM '+table)==0,table
install(candidate)
assert sql('SELECT max(version) FROM _sqlx_migrations')==101 and fingerprint()==before
empty();check('99 -> 101 OFF migration: real baseline 18A binary, same database, account/SIM/request fingerprint preserved, no events or coverage created')
helper('stop')
empty()
# This reversal is allowed ONLY with all four new stores empty; never drops used evidence.
sql('''BEGIN;
 DROP VIEW location_access_records; DROP VIEW location_access_hourly;
 DROP FUNCTION privacy_erase_access_events(BIGINT,INTEGER,BIGINT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT);
 DROP TABLE location_access_events; DROP TABLE location_access_erasure_runs;
 DROP FUNCTION location_access_event_guard();
 DROP TABLE location_access_log; DROP TABLE location_access_coverage;
 DROP FUNCTION location_access_log_guard(); DROP FUNCTION location_access_coverage_guard(); DROP FUNCTION location_access_no_truncate();
 DELETE FROM _sqlx_migrations WHERE version IN (100,101); COMMIT;''')
shutil.copyfile(previous,binary);helper('api')
assert sql('SELECT max(version) FROM _sqlx_migrations')==99 and fingerprint()==before
check('empty-ledger-only rollback restores baseline API and schema 99; unrelated account/SIM/request data identical')
install(candidate)
assert sql('SELECT max(version) FROM _sqlx_migrations')==101 and fingerprint()==before
empty()
check('second OFF upgrade succeeds; no ledger enablement or destructive data migration')
report={'environment':'disposable-internal-docker','baseline_api_sha256':BASELINE,'candidate_api_sha256':candidate_hash,
 'schema_path':[99,101,99,101],'groups':passed,'identity_fingerprint_unchanged':True,'production_changed':False}
(here/'access-events-off-rehearsal.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
