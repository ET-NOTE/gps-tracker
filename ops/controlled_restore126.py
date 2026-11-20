"""Hold automatic statistics in the isolated fixture to separate cache from ANALYZE.

This is an experimental control, never a deployment setting. The native DB is
inside the labelled126 container with no external network or host data mounts.
"""
import json
import time
import psycopg
import verify_runtime126 as v
from runtime121_control import job

v.stop_api()
for name in ('baseline126.json','stats126-after-baseline.json','repeat-restore126.json'):
    path=v.ROOT/'out'/name
    if path.exists():path.rename(path.with_name('automatic-'+name))
with psycopg.connect(v.DSN,autocommit=True) as db:
    db.execute('ALTER SYSTEM SET autovacuum=off')
    db.execute('SELECT pg_reload_conf()')
time.sleep(1)
with psycopg.connect(v.DSN,autocommit=True) as db:
    assert db.execute('SHOW autovacuum').fetchone()==('off',)
    for _ in range(100):
        if db.execute("SELECT count(*) FROM pg_stat_activity WHERE backend_type='autovacuum worker'").fetchone()==(0,):break
        time.sleep(.1)
    else:raise AssertionError('autovacuum worker not settled')
name='gps_cumulative_restore'
job('recovery',action='drop',database=name)
job('recovery',action='create',database=name)
job('recovery',action='pre',database=name)
t=time.monotonic()
job('recovery',action='restore',database=name)
job('recovery',action='post',database=name)
v.load.save('controlled-restore126',dict(seconds=time.monotonic()-t,database=name,
    control='autovacuum off only in isolated fixture; not proposed for deployment'))
v.snapshot('controlled-fresh',json.loads(v.CONTEXT.read_text())['dsn'])
v.baseline()
import profile_runtime126 as p
p.profile('controlled-plan',analyze=False)
p.profile('controlled-default')
p.profile('controlled-jit-off',jit=False)
