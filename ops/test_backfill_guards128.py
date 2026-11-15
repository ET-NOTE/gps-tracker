"""Fail-closed policy/schema/key and session-setting checks for bounded writes."""
import json
import psycopg
import location_query_bounds as bounds
import verify_runtime126 as v
from runtime121_control import job

ctx=json.loads(v.CONTEXT.read_text());v.stop_api();checks=[]


def denied(name,call,exception,contains=None):
    try:call()
    except exception as exc:
        if contains:assert contains in str(exc),str(exc)
    else:raise AssertionError(name+' accepted')
    checks.append(name)


with psycopg.connect(ctx['dsn'],autocommit=True) as db:
    read=bounds.backfill(db)
    assert not read['apply'] and read['complete'] and read['updated']==0
    checks.append('keyless read-only status makes no writes')
    denied('keyless apply rejected',lambda:bounds.backfill(db,True),psycopg.Error)
    assert db.execute('SELECT 1').fetchone()==(1,)
    for size,max_batches in ((0,0),(5001,0),(7,-1)):
        denied('invalid batch rejected '+str((size,max_batches)),lambda:bounds.backfill(db,True,size,max_batches),ValueError)
    db.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ctx['ring']),))
    with db.transaction(force_rollback=True):
        db.execute('UPDATE location_storage_policy SET maintenance=true')
        denied('maintenance fence respected',lambda:bounds.backfill(db,True),ValueError,'storage transition')
    with db.transaction(force_rollback=True):
        db.execute("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction=0")
        with db.transaction():
            db.execute("SET LOCAL session_replication_role='replica'")
            db.execute("UPDATE location_records SET query_bounds_ready=false,query_first_at=NULL,query_last_at=NULL WHERE device_id=%s AND recorded_at='2026-10-01 00:16:40+00' AND source='l80'",(ctx['did'],))
            db.execute("SET LOCAL session_replication_role='origin'")
        result=bounds.backfill(db,True,1,1)
        assert result['updated']==1 and result['decompressed_tuple_limit_per_statement']==5000
        assert db.execute("SHOW timescaledb.max_tuples_decompressed_per_dml_transaction").fetchone()==('0',)
    assert bounds.backfill(db)['complete']
    checks.append('unlimited caller bounded to5000 during write; setting and row rollback preserved')

name='gps_cumulative_faults';job('recovery',action='create',database=name)
try:
    target=ctx['dsn'].rsplit('/',1)[0]+'/'+name
    with psycopg.connect(target,autocommit=True) as db:
        db.execute('CREATE TABLE _sqlx_migrations(version bigint,success bool)')
        db.execute('INSERT INTO _sqlx_migrations VALUES(115,true)')
        denied('unreviewed115 rejected before reading policy',lambda:bounds.backfill(db,True),ValueError,'reviewed GPS schema')
finally:job('recovery',action='drop',database=name)
v.load.save('backfill-guards128',dict(checks=checks,unlimited_case=result,production_modified=False))
print('PASS128',len(checks),'backfill guard checks',flush=True)
