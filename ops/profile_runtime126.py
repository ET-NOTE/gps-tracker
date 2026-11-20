"""Exact API aggregate SQL, same runtime role, default JIT and custom plan.

Diagnostic 60s timeout is separate from the unchanged actual API's 20s budget.
Only plans/counters are retained; no coordinates, envelopes, credentials or keys.
"""
import json
import re
import sys
import time
import psycopg
import verify_runtime126 as v
from profile_runtime124 import sql_text


def profile(label,analyze=True,jit=None,route='aggregate'):
    ctx=json.loads(v.CONTEXT.read_text())
    query=sql_text('devices.rs','WITH speed AS MATERIALIZED') if route=='aggregate' else sql_text('locations.rs','WITH scoped AS MATERIALIZED')
    prepared=re.sub(r'%\(p(\d+)\)s',lambda m:'$'+m[1],query)
    db=psycopg.connect(ctx['dsn'],autocommit=False)
    result=dict(label=label,analyze=analyze,timeout_seconds=60,api_timeout_seconds=20)
    try:
        db.execute("SET LOCAL track_functions='all'; SET LOCAL ROLE gps_runtime; SET LOCAL statement_timeout='60s'; SET LOCAL plan_cache_mode='force_custom_plan'; SET LOCAL temp_tablespaces='gps121_sort'")
        if jit is not None:db.execute('SET LOCAL jit='+('on' if jit else 'off'))
        db.execute("SELECT set_config('gps.storage_keys',%s,true)",(json.dumps(ctx['ring']),))
        result['jit']=db.execute('SHOW jit').fetchone()[0]
        db.execute('PREPARE measured126 AS '+prepared)
        values=[ctx['did'],'2026-09-30T15:00:00Z','2026-10-31T15:00:00Z','1 hour',ctx['uid'],False] if route=='aggregate' else [ctx['did'],ctx['uid'],'2026-09-30T15:00:00Z','2026-10-31T15:00:00Z',None,None,10000]
        start=time.monotonic()
        options='ANALYZE,BUFFERS,FORMAT JSON' if analyze else 'FORMAT JSON'
        try:
            # EXECUTE's argument list is a utility statement, not a bindable
            # extended-protocol query. ClientCursor quotes typed literals.
            with psycopg.ClientCursor(db) as cur:
                result['plan']=cur.execute('EXPLAIN ('+options+') EXECUTE measured126('+','.join(['%s']*len(values))+')',values).fetchone()[0][0]
            result['functions']=db.execute('SELECT funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE calls>0 ORDER BY total_time DESC,funcname').fetchall()
            result['ok']=True
        except psycopg.Error as exc:
            result['ok']=False;result['error_sqlstate']=exc.sqlstate
        result['seconds']=round(time.monotonic()-start,6)
    finally:db.rollback();db.close()
    v.load.save('profile126-'+label,result)
    print('PROFILE',label,result['ok'],result['seconds'],'jit',result['jit'],flush=True)


if __name__=='__main__':
    profile(sys.argv[1],analyze='plan-only' not in sys.argv,jit=False if 'jit-off' in sys.argv else None)
