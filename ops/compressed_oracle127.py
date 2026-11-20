"""Full logical-row equivalence on compressed chunks, using113 SQL as oracle."""
import hashlib
import json
import time
import psycopg
import verify_runtime126 as v

ctx=json.loads(v.CONTEXT.read_text());v.stop_api();checks=[]
oracle=json.loads((v.ROOT/'out/oracle113-functions.json').read_text())
names=['location_points_between','location_speed_points_between','location_speed_metrics_between',
       'location_history_points_between','location_sample_keys_between']
with psycopg.connect(ctx['dsn'],autocommit=True) as db:
    assert db.execute("SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='location_records' AND is_compressed").fetchone()==(3,)
    for name in ['location_query_records_between']+names:
        definition=oracle[name].replace('FUNCTION public.'+name,'FUNCTION pg_temp.before_'+name)
        if name!='location_query_records_between':
            definition=definition.replace('FROM location_query_records_between(', 'FROM pg_temp.before_location_query_records_between(')
        db.execute(definition)
    db.execute("SET statement_timeout='20s'; SET jit=off; SET temp_tablespaces='gps121_sort'")
    db.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ctx['ring']),))
    windows=[('2026-10-01T00:00:00Z','2026-10-01T01:00:00Z'),
             ('2026-10-07T23:30:00Z','2026-10-08T00:30:00Z'),
             ('2026-10-14T23:30:00Z','2026-10-15T00:30:00Z')]
    with db.transaction():
        db.execute('SET LOCAL ROLE gps_runtime')
        for name in names:
            for lo,hi in windows:
                params=(ctx['did'],ctx['uid'],lo,hi)
                def digest(fn):
                    return db.execute('SELECT count(*),md5(string_agg(to_jsonb(p)::text,\'|\' ORDER BY recorded_at,source)) FROM '+fn+'(%s,%s,%s,%s) p',params).fetchone()
                started=time.monotonic();before=digest('pg_temp.before_'+name);after=digest(name)
                assert before==after,(name,lo)
                checks.append(dict(function=name,since=lo,until=hi,rows=after[0],md5=after[1],seconds=time.monotonic()-started))
        for name in names:
            assert db.execute('SELECT count(*) FROM '+name+'(%s,%s,%s,%s)',(ctx['did'],-1,windows[0][0],windows[0][1])).fetchone()==(0,)
    db.execute("SELECT set_config('gps.storage_keys','',false)")
    try:
        db.execute("SELECT lat FROM location_query_records_between(%s,%s,'2026-10-01','2026-10-02') LIMIT 1",(ctx['did'],ctx['uid'])).fetchone()
    except psycopg.Error:pass
    else:raise AssertionError('compressed encrypted query accepted without key')
v.load.save('compressed-oracle127',dict(schema=114,compressed_chunks=3,checks=checks,
    runtime_role=True,foreign_empty_functions=5,keyless_denied=True,logical_rows_equal=True,
    oracle='pinned113 full logical rows, not only route counts',production_modified=False))
print('PASS127 compressed15 full-row oracle comparisons,5 foreign-owner denials and missing-key rejection',flush=True)
