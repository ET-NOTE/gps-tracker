"""Paired workload control: fresh restored DB with compression paused in fixture.

This does not propose disabling compression in production. It separates the
new compressed-history temp-space failure from the repaired restore-statistics
issue. Autovacuum remains on, limits and request ranges are unchanged.
"""
import json
import os
import psycopg
import verify_runtime126 as v
from runtime121_control import job

ctx=json.loads(v.CONTEXT.read_text());dsn=ctx['dsn'];v.stop_api()
name='gps_cumulative_restore'
for action in ('drop','create','pre','restore','post'):job('recovery',action=action,database=name)
with psycopg.connect(dsn,autocommit=True) as db:
    ids=db.execute("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_compression' AND hypertable_schema='public' AND hypertable_name='location_records'").fetchall()
    assert len(ids)==1,ids
    for (jid,) in ids:db.execute('SELECT alter_job(%s,scheduled=>false)',(jid,))
    assert db.execute("SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='location_records' AND is_compressed").fetchone()==(0,)
    assert db.execute('SHOW autovacuum').fetchone()==('on',)
proof=v.transition(dsn,ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
v.load.save('uncompressed-control126',dict(compression_paused_only_in_clone=True,autovacuum='on',
    statistics=proof['query_statistics'],production_policy_changed=False))
os.environ['PERF126_PHASE']='uncompressed'
import perf_runtime126
with psycopg.connect(dsn,autocommit=True) as db:
    assert db.execute("SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='location_records' AND is_compressed").fetchone()==(0,)
