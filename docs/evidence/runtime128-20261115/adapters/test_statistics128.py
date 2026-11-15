"""Real fenced native DB checks for restore statistics and clone startup waits."""
import json
import threading
import time
import psycopg
import location_query_statistics as stats
import verify_runtime126 as v
from runtime121_control import job

ctx=json.loads(v.CONTEXT.read_text());dsn=ctx['dsn'];ring=ctx['ring']
v.stop_api()
v.transition(dsn,ring,str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'fence')
results=[]


def denied(label,call,contains):
    try:call()
    except (ValueError,RuntimeError) as e:assert contains in str(e),str(e)[-300:]
    else:raise AssertionError('accepted '+label)
    results.append(label)


def refresh(target):
    with psycopg.connect(target,autocommit=True) as db:return stats.refresh(db)


with psycopg.connect(dsn,autocommit=True) as db:
    assert db.execute('SELECT maintenance FROM location_storage_policy').fetchone()==(True,)
    denied('other client rejected',lambda:refresh(dsn),'stop ALL')
denied('runtime role rejected',lambda:refresh(ctx['runtime']),'maintenance owner')
name='gps_cumulative_faults'
job('recovery',action='create',database=name)
target=dsn.rsplit('/',1)[0]+'/'+name
try:
    with psycopg.connect(target,autocommit=True) as db:
        db.execute('CREATE TABLE _sqlx_migrations(version bigint,success bool)')
        db.execute('INSERT INTO _sqlx_migrations VALUES(115,true)')
    denied('unreviewed115 rejected',lambda:refresh(target),'reviewed GPS schema')
finally:job('recovery',action='drop',database=name)
denied('post-statistics interruption',lambda:job('transition',dsn=dsn,ring=ring,mode='resume',interrupt_after_statistics=True),
    'synthetic interruption after query statistics')
with psycopg.connect(dsn,autocommit=True) as db:
    assert db.execute('SELECT maintenance FROM location_storage_policy').fetchone()==(True,)
results.append('interruption kept maintenance fence')
# Role separation transferred tables to NOLOGIN gps_schema_owner. Give only the
# synthetic maintenance login membership; gps_runtime never gets this grant.
with psycopg.connect(dsn,autocommit=True) as db:
    db.execute('GRANT gps_schema_owner TO gps_migration')
    assert db.execute("SELECT rolsuper FROM pg_roles WHERE rolname='gps_migration'").fetchone()==(False,)
owner=dsn.replace('postgres:closure-test-only','gps_migration:synthetic-migration-only')
proof=v.transition(owner,ring,str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
assert proof['query_statistics']['completed']
results.append('non-superuser owner resume analyzed all4 relations')
denied('unfenced refresh rejected',lambda:refresh(dsn),'maintenance fence')
# Check the harness watches the restored database's lock, not the original DB.
locked=threading.Event()
def hold():
    with psycopg.connect(dsn,autocommit=True) as db:
        db.execute('SELECT pg_advisory_lock(210571031)');locked.set();time.sleep(3)
thread=threading.Thread(target=hold);thread.start();assert locked.wait(2)
t=time.monotonic();v.boot_settled(dict(RUNTIME_DSN=ctx['runtime'],STORAGE='pilot'));elapsed=time.monotonic()-t
thread.join();assert elapsed>=3
rows=[v.request(ctx['uid'],ctx['did'],name) for name in ('month_aggregate','month_history','month_page')]
assert all(r['status']==200 for r in rows),rows
v.stop_api()
v.transition(dsn,ring,str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'fence')
v.load.save('statistics-guards128',dict(checks=results,owner_statistics=proof['query_statistics'],
    restored_lock_wait_seconds=elapsed,queries=rows,production_modified=False))
print('PASS126',len(results),'statistics guards/owner, clone lock wait and3 full-month routes',flush=True)
