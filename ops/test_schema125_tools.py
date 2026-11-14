"""Real disposable DB tests for reviewed113 and fail-closed future versions."""
import gc
import json
import psycopg
import admin_db_roles
import crypto20b_transition
import location_query_bounds
import location_storage
from runtime121_control import ROOT, DSN, stop_api, drain, job

stop_api();drain()
ring=json.loads((ROOT/'test-keys.json').read_text())
assert admin_db_roles.run(DSN)['schema']==113
scan=location_storage.run(DSN,ring)
with crypto20b_transition.connect(DSN,ring) as db:
    before=db.execute("SELECT md5(string_agg(md5(jsonb_build_array(lat_sealed,lng_sealed,raw_sealed,fixes_jsonb_sealed)::text),'' ORDER BY device_id,recorded_at,source)) FROM location_records").fetchone()[0]
    result=location_query_bounds.backfill(db,apply=True,batch_size=100)
    after=db.execute("SELECT md5(string_agg(md5(jsonb_build_array(lat_sealed,lng_sealed,raw_sealed,fixes_jsonb_sealed)::text),'' ORDER BY device_id,recorded_at,source)) FROM location_records").fetchone()[0]
    assert result['schema']==113 and result['complete'] and before==after
gc.collect();drain()
job('recovery',action='create',database='gps_cumulative_faults')
target=DSN.rsplit('/',1)[0]+'/gps_cumulative_faults'
denials=[]
try:
    with psycopg.connect(target,autocommit=True) as db:
        db.execute('CREATE TABLE _sqlx_migrations(version bigint,success bool)')
        db.execute('INSERT INTO _sqlx_migrations VALUES(114,true)')
    def bounds():
        with psycopg.connect(target,autocommit=True) as db:
            return location_query_bounds.backfill(db)
    for name,call in [('roles',lambda:admin_db_roles.run(target)),
        ('transition',lambda:crypto20b_transition.connect(target,ring)),
        ('storage',lambda:location_storage.run(target,ring)),('query_bounds',bounds)]:
        try:call()
        except (ValueError,RuntimeError) as e:
            assert 'schema' in str(e) and 'required' in str(e),str(e)
            denials.append(name)
        else:raise AssertionError(name+' accepted unreviewed114')
        gc.collect()
finally:job('recovery',action='drop',database='gps_cumulative_faults')
(ROOT/'out/schema-tools125.json').write_text(json.dumps(dict(reviewed_schema=113,
    runtime_roles_check=True,core_scan=True,query_bounds=result,ciphertext_unchanged=before==after,
    unreviewed114_rejected=denials),indent=2))
print('PASS113 reviewed tools and unchanged ciphertext; all4 tools reject unreviewed114',flush=True)
