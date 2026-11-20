"""Per-transaction SQL/decryption measurements in the labelled synthetic DB.

EXPLAIN execution includes decryption; function total_time is a subset, never
added to SQL time. pg_stat_xact_user_functions avoids other sessions' counters.
No key, plaintext result, request URL or production connection is recorded.
"""
import json
import resource
from pathlib import Path
import re
import sys
import time
import load_runtime122 as l

resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
ROOT = l.ROOT


def sql_text(path, start):
    text = (ROOT / 'profile-source' / path).read_text()
    begin = text.index('"' + start) + 1
    end = text.index('"', begin)
    return re.sub(r'\$(\d+)', lambda m: '%(p' + m[1] + ')s', text[begin:end])


def profile(label):
    assert label in ('before', 'after')
    d = l.b.fixture()['devices'][0]
    params = dict(p1=d['device_id'], p2=d['user_id'], p3='2026-09-30T15:00:00Z',
                  p4='2026-10-31T15:00:00Z', p5=None, p6=None, p7=10000)
    queries = [
        ('history', sql_text('locations.rs', 'WITH scoped AS MATERIALIZED'), params),
        ('page', sql_text('locations.rs', 'WITH selected AS MATERIALIZED'),
         dict(params, p7=None, p8=None, p9=5001)),
        ('aggregate', sql_text('devices.rs', 'WITH speed AS MATERIALIZED'),
         dict(p1=d['device_id'], p2=params['p3'], p3=params['p4'],
              p4='1 hour', p5=d['user_id'], p6=False)),
        ('fleet_points', 'SELECT recorded_at,lat,lng,fix,source FROM location_points_between(%(p1)s,%(p2)s,%(p3)s,%(p4)s)', params),
    ]
    results = []
    for name, query, values in queries:
        for repeat in range(6):
            mode="force_custom_plan" if repeat<3 else "force_generic_plan"
            db = l.connect(); db.autocommit = False
            try:
                with db.cursor() as cur:
                    # Only the diagnostic connection sets statistics before
                    # assuming the same non-owner role used by the actual API.
                    cur.execute("SET LOCAL track_functions='all'; SET LOCAL ROLE gps_runtime; SET LOCAL statement_timeout='60s'")
                    cur.execute("SET LOCAL plan_cache_mode='"+mode+"'")
                    prepared=re.sub(r'%\(p(\d+)\)s', lambda m:'$'+m[1], query)
                    count=max(int(n) for n in re.findall(r'\$(\d+)',prepared))
                    cur.execute('PREPARE measured124 AS '+prepared)
                    begin = time.monotonic()
                    cur.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE measured124('+','.join(['%s']*count)+')',
                                [values['p'+str(i)] for i in range(1,count+1)])
                    plan = cur.fetchone()[0][0]
                    wall = time.monotonic() - begin
                    cur.execute("SELECT funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE calls>0 ORDER BY total_time DESC,funcname")
                    functions = [dict(name=n, calls=c, total_ms=t, self_ms=s) for n,c,t,s in cur.fetchall()]
                    results.append(dict(route=name, plan_mode=mode, repeat=repeat%3, client_seconds=wall, plan=plan, functions=functions))
                    print(label, name, mode, repeat%3, 'SQLms', plan['Execution Time'],
                          'decrypt', [f for f in functions if f['name']=='gps_open_cell'], flush=True)
            finally:
                db.rollback(); db.close()
    l.save('profile124-' + label, dict(measurement='runtime-role prepared custom/generic EXPLAIN ANALYZE; transaction-local function statistics',
        overlap_note='decrypt total_ms is inside SQL execution, not additional time',
        fixture='synthetic only', results=results))


if __name__ == '__main__':
    profile(sys.argv[1])
