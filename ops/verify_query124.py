"""Transactional 112/113 comparison on disposable encrypted data only.

No production connection, plaintext result file, key output or migration ledger
mutation. The entire fixture and trial DDL roll back, including on assertion.
"""
import datetime as dt
import hashlib
import json
from pathlib import Path
import resource
import uuid
from psycopg2.extras import execute_values
import load_runtime122 as l

resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
ROOT = l.ROOT
FUNCTIONS = ('location_points_between', 'location_sample_keys_between',
             'location_history_points_between', 'location_speed_metrics_between',
             'location_speed_points_between')


def verify():
    db = l.connect(); db.autocommit = False
    checks = []
    try:
        q = db.cursor()
        q.execute('SELECT max(version) FROM _sqlx_migrations')
        assert q.fetchone() == (112,)
        tag = uuid.uuid4().hex
        q.execute("INSERT INTO users(email,password_hash,phone) VALUES(%s,'','01000000000'),(%s,'','01000000000') RETURNING id",
                  (tag+'@query124.invalid',tag+'b@query124.invalid'))
        a,b = [r[0] for r in q.fetchall()]
        q.execute("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,''),(%s,%s,'') RETURNING id",
                  ('query124-'+tag,a,'query124-other-'+tag,a))
        did,other = [r[0] for r in q.fetchall()]
        start = dt.datetime(2026,10,19,15,tzinfo=dt.timezone.utc)
        rows = []
        for i in range(80):
            anchor=start+dt.timedelta(seconds=60*i)
            fixes=[dict(at_ms=-60000+k*5000,up_ms=i*60000+k*5000,
                        lat=35+i*.0001+k*.00001,lng=127,sat=12,speed_kmh=120) for k in range(12)]
            raw=json.dumps(dict(boot_id='boot-'+str(i//40),cbc_mv=4132,payload='x'*5000,fixes=fixes))
            rows.append((did,a,anchor,'l80',True,35,127,12,raw,json.dumps(fixes)))
        rows.extend([
            (did,a,start-dt.timedelta(seconds=5),'l80',True,31,120,2,'{}',None),
            (did,a,start,'phone',True,35,127,12,'{"boot":"phone"}',None),
            (did,a,start+dt.timedelta(seconds=5),'phone',False,None,None,None,'{}',None),
            (did,b,start+dt.timedelta(seconds=7),'l80',True,10,11,12,'{"private":true}',None),
            (other,a,start,'l80',True,11,12,12,'{}',None),
        ])
        for days,ms in [(-40,40*86400000+15000),(40,-40*86400000+20000)]:
            rows.append((did,a,start+dt.timedelta(days=days),'lte_gnss',False,None,None,None,'{}',
                         json.dumps([dict(at_ms=ms,lat=36,lng=128)])))
        for i,v in enumerate(('[]','{}','null')):
            rows.append((did,a,start+dt.timedelta(seconds=30+i),'empty',False,None,None,None,'{}',v))
        execute_values(q,'INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat,raw,fixes_jsonb) VALUES %s',rows)
        # Simulate a pre110 encrypted row awaiting envelope backfill. This is
        # rolled back together with DDL and fixture; do not disable sealing.
        # Timescale refuses DISABLE TRIGGER on compression-enabled hypertables.
        # Replace only this metadata trigger function inside the rolled-back
        # transaction; sealing and ownership triggers remain active. Restore
        # the exact definition before any query comparison.
        q.execute("SELECT pg_get_functiondef('gps_location_query_bounds()'::regprocedure)")
        bounds_definition=q.fetchone()[0]
        q.execute('CREATE OR REPLACE FUNCTION gps_location_query_bounds() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$')
        q.execute('UPDATE location_records SET query_bounds_ready=false,query_first_at=NULL,query_last_at=NULL WHERE device_id=%s AND source=%s',(did,'lte_gnss'))
        q.execute(bounds_definition)
        windows=[(None,None),(start,start),(start,start+dt.timedelta(hours=1)),
                 (None,start),(start,None),(start-dt.timedelta(seconds=12),start+dt.timedelta(seconds=17)),
                 (start+dt.timedelta(days=2),start+dt.timedelta(days=3)),
                 (start+dt.timedelta(seconds=20),start+dt.timedelta(seconds=15))]

        def snapshot():
            result={}
            q.execute('SET LOCAL ROLE gps_runtime')
            try:
                for owner in (a,b):
                    for index,(lo,hi) in enumerate(windows):
                        for name in FUNCTIONS:
                            q.execute('SELECT to_jsonb(p) FROM '+name+'(%s,%s,%s,%s) p ORDER BY recorded_at,source',(did,owner,lo,hi))
                            values=[r[0] for r in q.fetchall()]
                            # Values only in protected process memory. Evidence
                            # contains a digest and count, not the actual points.
                            result[f'{owner==a}:{index}:{name}'] = dict(rows=len(values),
                                sha256=hashlib.sha256(json.dumps(values,sort_keys=True,separators=(',',':')).encode()).hexdigest())
                return result
            finally:q.execute('RESET ROLE')

        definitions=[]
        for function in ('location_query_records_between','location_speed_metrics_between'):
            q.execute("SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=%s",(function,))
            definitions.append(q.fetchone()[0])
        before=snapshot()
        keyring=(ROOT/'test-keys.json').read_text()
        q.execute("SELECT set_config('gps.storage_keys','',true)")
        q.execute((ROOT/'src/gps-tracker-api/migrations/0113_location_device_projection.sql').read_text())
        q.execute("SELECT set_config('gps.storage_keys',%s,true)",(keyring,))
        after=snapshot()
        assert before==after, [k for k in before if before[k]!=after[k]]
        checks.append(dict(case='encrypted112_to113',comparisons=len(before),equal=True))
        # Reverting only the function definitions in this transaction should
        # reproduce 112 on late insert/delete too, without touching stored rows.
        q.execute('SAVEPOINT candidate')
        q.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat,raw) VALUES(%s,%s,%s,'l80',true,35.0001,127,12,'{}')",(did,a,start+dt.timedelta(seconds=22)))
        q.execute("DELETE FROM location_records WHERE device_id=%s AND source='l80' AND recorded_at=%s",(did,start+dt.timedelta(seconds=60)))
        changed=snapshot()
        assert changed!=after
        for definition in definitions:q.execute(definition)
        assert snapshot()==changed
        checks.append(dict(case='late_insert_delete112_to113',comparisons=len(changed),equal=True))
        q.execute('ROLLBACK TO SAVEPOINT candidate')
        assert snapshot()==after
        checks.append(dict(case='no_stale_cache_after_insert_delete_rollback',equal=True))
        q.execute('SELECT count(*) FROM location_records WHERE device_id=%s AND (lat IS NOT NULL OR lng IS NOT NULL OR raw IS NOT NULL OR fixes_jsonb IS NOT NULL)',(did,))
        assert q.fetchone()==(0,)
        # A wrong key or a ciphertext swapped across identity must still fail.
        for case in ('missing-key','wrong-context'):
            q.execute('SAVEPOINT denied')
            if case=='missing-key':q.execute("SELECT set_config('gps.storage_keys','{}',true)")
            try:
                q.execute('SET LOCAL ROLE gps_runtime')
                if case=='missing-key':
                    q.execute('SELECT lat FROM location_points_between(%s,%s,%s,%s)',(did,a,start,start+dt.timedelta(seconds=10)))
                else:
                    q.execute("SELECT gps_open_cell(fixes_jsonb_sealed,'wrong-context') FROM location_records WHERE device_id=%s AND fixes_jsonb_sealed IS NOT NULL LIMIT 1",(did,))
                q.fetchall()
            except l.psycopg2.Error as error:
                expected='location decryption key unavailable' if case=='missing-key' else 'location ciphertext authentication failed'
                assert error.pgcode=='P0001' and error.diag.message_primary==expected
                checks.append(dict(case=case,rejected=True,sqlstate=error.pgcode,reason=expected))
            else:raise AssertionError(case+' unexpectedly accepted')
            finally:q.execute('ROLLBACK TO SAVEPOINT denied')
    finally:
        db.rollback();db.close()
    assert l.sql('SELECT max(version) FROM _sqlx_migrations')==[(112,)]
    l.save('query124-equivalence',dict(checks=checks,fixture_rows=len(rows),
        pending_envelope_fallback=True,other_SIM_same_owner=True,receiving_owner_isolation=True,
        raw_payload_bytes=5000,DDL_without_keys=True,rolled_back=True,production_modified=False))
    print('PASS124:80 encrypted comparisons, pending bounds, SIM/owner boundaries, keys/context rejection; rolled back')


if __name__=='__main__':verify()
