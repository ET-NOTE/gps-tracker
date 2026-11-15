"""Three new restores with automatic stats off; actual first monthly API reads."""
import hashlib
import json
import time
import psycopg
import verify_runtime126 as v
from runtime121_control import job

ctx=json.loads(v.CONTEXT.read_text());dsn=ctx['dsn']
expected=json.loads((v.ROOT/'out/statistics-guards126.json').read_text())['queries']
expected={r['route']:r['sha256'] for r in expected}
reports=[];v.stop_api()
for repeat in range(3):
    name='gps_cumulative_restore'
    job('recovery',action='drop',database=name)
    job('recovery',action='create',database=name)
    job('recovery',action='pre',database=name)
    start=time.monotonic();job('recovery',action='restore',database=name);job('recovery',action='post',database=name)
    restored_seconds=time.monotonic()-start
    with psycopg.connect(dsn,autocommit=True) as db:
        assert db.execute('SHOW autovacuum').fetchone()==('off',)
        assert db.execute('SELECT maintenance FROM location_storage_policy').fetchone()==(True,)
        assert db.execute("SELECT count(*) FROM pg_stat_all_tables WHERE schemaname='_timescaledb_internal' AND last_autoanalyze IS NOT NULL").fetchone()==(0,)
    proof=v.transition(dsn,ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
    assert proof['query_statistics']['completed']
    v.boot_settled(dict(RUNTIME_DSN=ctx['runtime'],STORAGE='pilot'))
    rows=[v.request(ctx['uid'],ctx['did'],route) for route in expected]
    assert all(r['status']==200 and r['sha256']==expected[r['route']] for r in rows),rows
    v.stop_api()
    reports.append(dict(repeat=repeat+1,restore_seconds=restored_seconds,
        statistics=proof['query_statistics'],queries=rows))
    v.load.save('fresh-restores126',dict(reports=reports,automatic_statistics=False,api_budget_seconds=20,
        same_response_hashes=True,cache='new DB/relations each time; OS cache not flushed'))
    print('PASS new restore',repeat+1,[(r['route'],r['seconds']) for r in rows],flush=True)
# Experimental autovacuum suppression is removed before sustained tests.
with psycopg.connect(v.DSN,autocommit=True) as db:
    db.execute('ALTER SYSTEM RESET autovacuum');db.execute('SELECT pg_reload_conf()')
time.sleep(.5)
with psycopg.connect(v.DSN,autocommit=True) as db:assert db.execute('SHOW autovacuum').fetchone()==('on',)
v.load.save('autovacuum-control-restored126',dict(autovacuum='on',test_override_removed=True))
