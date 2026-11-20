"""Synthetic causal experiment: change planner statistics only, then actual API."""
import json
import time
import psycopg
import verify_runtime126 as v
import profile_runtime126 as p

ctx=json.loads(v.CONTEXT.read_text())
dsn=ctx['dsn']
v.stop_api()
for name in ('baseline126.json','stats126-after-baseline.json'):
    path=v.ROOT/'out'/name
    if path.exists():path.rename(path.with_name('controlled-'+name))
with psycopg.connect(dsn,autocommit=True) as db:
    assert db.execute('SELECT maintenance FROM location_storage_policy').fetchone()==(True,)
    db.execute("SET statement_timeout='120s'; SET lock_timeout='5s'; SET jit=off")
    digest="SELECT count(*),md5(string_agg(md5(row_to_json(r)::text),'' ORDER BY device_id,recorded_at)) FROM location_records r"
    before=db.execute(digest).fetchone()
start=time.monotonic()
proof=v.transition(dsn,ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
seconds=time.monotonic()-start
with psycopg.connect(dsn,autocommit=True) as db:
    db.execute("SET statement_timeout='120s'; SET jit=off")
    after=db.execute(digest).fetchone()
    assert before==after
v.load.save('analyze-experiment126',dict(seconds=seconds,ciphertext_rows_unchanged=True,rows=before[0],row_digest=before[1],
    scope='location query columns only; explicit child and parent ANALYZE; protected transition unit',
    query_statistics=proof['query_statistics'],jit_changed=False))
v.snapshot('after-analyze',dsn)
v.baseline()
# Rename immediately; preserve the earlier baseline file before running this job.
(v.ROOT/'out/baseline126.json').rename(v.ROOT/'out/after-analyze-api126.json')
p.profile('after-analyze-default')
p.profile('after-analyze-jit-off',jit=False)
