"""Fresh encrypted113 dump restore ->114 -> statistics -> bounded monthly load."""
import json
import os
import psycopg
import verify_runtime126 as v
from runtime121_control import job,migrate

ctx=json.loads(v.CONTEXT.read_text());dsn=ctx['dsn'];v.stop_api()
phase=os.environ.get('PERF127_PHASE','compressed')
assert phase in ('compressed','uncompressed')
name='gps_cumulative_restore'
for action in ('drop','create','pre','restore','post'):job('recovery',action=action,database=name)
with psycopg.connect(dsn,autocommit=True) as db:
    assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()==(113,)
    assert db.execute('SELECT maintenance FROM location_storage_policy').fetchone()==(True,)
    db.execute('GRANT gps_schema_owner TO gps_migration')
    for (jid,) in db.execute("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_compression'").fetchall():
        db.execute('SELECT alter_job(%s,scheduled=>%s)',(jid,phase=='compressed'))
migrate('restore127-'+phase,dsn.replace('postgres:closure-test-only','gps_migration:synthetic-migration-only'))
proof=v.transition(dsn,ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
with psycopg.connect(dsn,autocommit=True) as db:
    if phase=='compressed':
        for (chunk,) in db.execute("SELECT show_chunks('location_records')::text").fetchall():
            db.execute('SELECT compress_chunk(%s::regclass,if_not_compressed=>true)',(chunk,))
    assert db.execute('SHOW autovacuum').fetchone()==('on',)
v.load.save('restored127-'+phase,dict(source_schema=113,schema=114,statistics=proof['query_statistics'],
    compression_scheduled=phase=='compressed',forced_full_compression_for_coverage=phase=='compressed',
    autovacuum='on',production_policy_changed=False))
import perf_runtime127
