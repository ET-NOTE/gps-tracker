"""Isolate caller setting/row state after a failed nested compressed write."""
import json
import psycopg
import candidate_bounds128 as candidate
import verify_runtime126 as v

ctx=json.loads(v.CONTEXT.read_text())
with psycopg.connect(ctx['dsn'],autocommit=True) as db:
    db.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ctx['ring']),))
    def state():
        return dict(settings=dict(db.execute("SELECT name,setting FROM pg_settings WHERE name IN ('plan_cache_mode','statement_timeout','lock_timeout','timescaledb.max_tuples_decompressed_per_dml_transaction')").fetchall()),
            pending=db.execute('SELECT count(*) FROM location_records WHERE NOT query_bounds_ready').fetchone()[0])
    with db.transaction(force_rollback=True):
        db.execute("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction=500")
        report=dict(before=state())
        try:candidate.backfill(db,True,7,1)
        except psycopg.Error as exc:report.update(sqlstate=exc.sqlstate,detail=exc.diag.message_detail)
        report['after']=state()
    v.load.save('nested-failure128-diagnostic',report)
    print(json.dumps(report),flush=True)
