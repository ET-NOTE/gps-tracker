"""Real130k compressed fixture: old failure, bounded writes, rollback and resume."""
import datetime as dt
import json
import time
import psycopg
from psycopg import sql
import before_bounds128 as before
import candidate_bounds128 as candidate
import verify_runtime126 as v

ctx=json.loads(v.CONTEXT.read_text());dsn=ctx['dsn'];v.stop_api()
v.transition(dsn,ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
report=dict(schema=114,production_modified=False,checks=[],api_sha256=v.load.b.SHA)


def record(name,**data):
    report['checks'].append(dict(name=name,**data));v.load.save('backfill128',report)
    print('PASS128',name,json.dumps(data),flush=True)


def connect(owner=False):
    target=dsn.replace('postgres:closure-test-only','gps_migration:synthetic-migration-only') if owner else dsn
    db=psycopg.connect(target,autocommit=True)
    db.execute("SET statement_timeout='60s'; SET lock_timeout='5s'; SET jit=off; SET temp_tablespaces='gps121_sort'")
    db.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ctx['ring']),))
    return db


def fingerprint(db):
    return db.execute("SELECT count(*),md5(string_agg(md5((to_jsonb(r)-ARRAY['query_first_at','query_last_at','query_bounds_ready'])::text),'' ORDER BY device_id,recorded_at,source)) FROM location_records r").fetchone()


def compressed_rows(db):
    tables=db.execute("""SELECT cc.schema_name,cc.table_name FROM _timescaledb_catalog.chunk c
      JOIN _timescaledb_catalog.chunk cc ON cc.id=c.compressed_chunk_id
      JOIN _timescaledb_catalog.hypertable h ON h.id=c.hypertable_id
      WHERE h.schema_name='public' AND h.table_name='location_records' AND NOT c.dropped""").fetchall()
    return sum(db.execute(sql.SQL('SELECT coalesce(sum(_ts_meta_count),0) FROM {}').format(sql.Identifier(s,t))).fetchone()[0] for s,t in tables)


def normalize(db,compress):
    chunks=db.execute("SELECT format('%I.%I',chunk_schema,chunk_name),is_compressed FROM timescaledb_information.chunks WHERE hypertable_name='location_records'").fetchall()
    for name,is_compressed in chunks:
        if is_compressed:db.execute('SELECT decompress_chunk(%s::regclass)',(name,))
        if compress:db.execute('SELECT compress_chunk(%s::regclass)',(name,))


def pending(db):return db.execute('SELECT count(*) FROM location_records WHERE NOT query_bounds_ready').fetchone()[0]
def settings(db):return dict(db.execute("SELECT name,setting FROM pg_settings WHERE name IN ('plan_cache_mode','statement_timeout','lock_timeout','timescaledb.max_tuples_decompressed_per_dml_transaction')").fetchall())


with connect() as db:
    for (jid,) in db.execute("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_compression'").fetchall():
        db.execute('SELECT alter_job(%s,scheduled=>false)',(jid,))
    db.execute('GRANT gps_schema_owner TO gps_migration')
    db.execute('GRANT CREATE ON TABLESPACE gps121_sort TO gps_migration')
    normalize(db,True)
    assert compressed_rows(db)==130000
    extra=db.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'backfill128-extra','') RETURNING id",(ctx['uid'],)).fetchone()[0]
    db.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) SELECT %s,%s,'2026-10-20'::timestamptz+i*interval '1 minute','l80',true,37,127 FROM generate_series(1,7)i",(extra,ctx['uid']))
    with db.transaction():
        db.execute("SET LOCAL session_replication_role='replica'")
        db.execute('UPDATE location_records SET query_bounds_ready=false,query_first_at=NULL,query_last_at=NULL WHERE device_id=%s',(extra,))
    original=fingerprint(db);assert pending(db)==7
    try:before.backfill(db,True,7,1)
    except psycopg.Error as exc:
        assert exc.sqlstate=='53400',exc.sqlstate
        record('old seven-row update fails at unchanged100k limit',sqlstate=exc.sqlstate,detail=exc.diag.message_detail)
    else:raise AssertionError('old failure was not reproduced')
    assert pending(db)==7 and fingerprint(db)==original and compressed_rows(db)==130000
    saved=settings(db);start=time.monotonic();result=candidate.backfill(db,True,7,1)
    assert result['updated']==7 and result['complete'] and result['statements']==7
    assert settings(db)==saved and fingerprint(db)==original and compressed_rows(db)==130000
    record('uncompressed pending rows do not decompress unrelated130k rows',result=result,seconds=time.monotonic()-start)
    # Put pending metadata inside compressed batches, across3 original chunks.
    normalize(db,False)
    with db.transaction():
        db.execute("SET LOCAL session_replication_role='replica'")
        db.execute("""UPDATE location_records SET query_bounds_ready=false,query_first_at=NULL,query_last_at=NULL
          WHERE device_id=%s AND (recorded_at IN (SELECT '2026-10-01'::timestamptz+i*interval '10 seconds' FROM unnest(ARRAY[100,10000,30000,60000,80000,100000,129999])i)
          OR recorded_at>='2026-10-01'::timestamptz+interval '1200000 seconds' AND recorded_at<'2026-10-01'::timestamptz+interval '1220000 seconds')""",(ctx['did'],))
    assert pending(db)==2007
    normalize(db,True);assert compressed_rows(db)==130007
    original=fingerprint(db)
    # Actual EXPLAIN ANALYZE, rolled back, reports how many batches are touched.
    key=db.execute('SELECT device_id,recorded_at,source FROM location_records WHERE NOT query_bounds_ready ORDER BY device_id,recorded_at,source LIMIT 1').fetchone()
    with db.transaction(force_rollback=True):
        candidate._bounded_settings(db,5000)
        plan=db.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) UPDATE location_records SET query_bounds_ready=true WHERE device_id=%s AND recorded_at=%s AND source=%s AND NOT query_bounds_ready',key).fetchone()[0]
        v.load.save('backfill128-plan',dict(plan=plan,rolled_back=True))
    # A lower operator limit stays lower; failure must not poison the caller's
    # transaction or leave a session advisory lock owned by the failed helper.
    with db.transaction(force_rollback=True):
        db.execute("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction=500")
        saved=settings(db)
        succeeded=[];writer=candidate._write_one
        def limited(*args):
            count=writer(*args);succeeded.append(count);return count
        candidate._write_one=limited
        try:
            try:candidate.backfill(db,True,7,1)
            except psycopg.Error as exc:assert exc.sqlstate=='53400',exc.sqlstate
            else:raise AssertionError('lower decompression limit ignored')
        finally:candidate._write_one=writer
        # The first residual compressed batch has479 rows, below500. Earlier
        # successful keys remain in the caller transaction; its rollback below
        # must undo them, while the failed1000-row write itself is atomic.
        assert db.execute('SELECT 1').fetchone()==(1,) and settings(db)==saved
        assert pending(db)==2007-sum(succeeded)
        with connect() as other:
            assert other.execute("SELECT pg_try_advisory_lock(hashtextextended('gps-query-bounds-110',0))").fetchone()==(True,)
            other.execute('SELECT pg_advisory_unlock_all()')
    assert pending(db)==2007
    record('lower500 limit honored; original SQLSTATE and outer transaction/lock preserved',earlier_keys_rolled_back=sum(succeeded))
    # A real lock timeout is bounded and leaves every location cell unchanged.
    with connect() as blocker:
        with blocker.transaction(force_rollback=True):
            # Timescale2.19 rejects SELECT FOR UPDATE on compressed tuples.
            # Hold the actual supported point UPDATE instead; rollback removes
            # both its metadata change and its decompression after the test.
            blocker.execute('UPDATE location_records SET query_bounds_ready=true WHERE device_id=%s AND recorded_at=%s AND source=%s',key)
            db.execute("SET lock_timeout='100ms'")
            try:candidate.backfill(db,True,7,1)
            except psycopg.Error as exc:assert exc.sqlstate=='55P03',exc.sqlstate
            else:raise AssertionError('locked row skipped')
            assert pending(db)==2007 and fingerprint(db)==original
            assert settings(db)['lock_timeout']=='100'
            db.execute("SET lock_timeout='5s'")
    assert pending(db)==2007 and fingerprint(db)==original
    record('row lock fails promptly, not skipped or declared complete')
    # Three committed keys survive a caller interruption; the next run discovers
    # remaining keys without a saved cursor or an inference of completion.
    original_writer=candidate._write_one;calls=0
    def interrupted(*args):
        global calls
        calls+=1
        if calls==4:raise RuntimeError('synthetic128 interruption')
        return original_writer(*args)
    candidate._write_one=interrupted
    try:
        try:candidate.backfill(db,True,7,1)
        except RuntimeError as exc:assert str(exc)=='synthetic128 interruption'
        else:raise AssertionError('injected interruption ignored')
    finally:candidate._write_one=original_writer
    assert pending(db)==2004 and fingerprint(db)==original
    record('three committed keys survive interruption;2004 pending remain',compressed_rows_remaining=compressed_rows(db))

with connect(owner=True) as db:
    assert db.execute("SELECT rolsuper FROM pg_roles WHERE rolname=current_user").fetchone()==(False,)
    # Force generic plans at session level: per-key transactions must override
    # them temporarily and restore the setting, including after >5 executions.
    db.execute("SET plan_cache_mode='force_generic_plan'")
    saved=settings(db);before_rows=compressed_rows(db);start=time.monotonic()
    partial=candidate.backfill(db,True,7,1)
    assert partial['updated']==7 and not partial['complete'] and partial['batches']==1
    assert before_rows-compressed_rows(db)<=7000
    result=candidate.backfill(db,True,2000)
    assert result['complete'] and result['updated']==1997 and result['statements']==1997
    assert settings(db)==saved and fingerprint(db)==original and pending(db)==0
    assert candidate.backfill(db,True)['updated']==0
    assert db.execute('SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR raw IS NOT NULL OR fixes_jsonb IS NOT NULL').fetchone()==(0,)
    prepared=any('UPDATE location_records' in row[0] for row in db.execute('SELECT statement FROM pg_prepared_statements').fetchall())
    assert prepared
    record('non-superuser partial batch and resume complete; all ciphertext unchanged',partial=partial,result=result,
        seconds=time.monotonic()-start,compression_limit_after=settings(db)['timescaledb.max_tuples_decompressed_per_dml_transaction'],
        compressed_rows_remaining=compressed_rows(db),prepared_update=prepared)

with connect() as db:
    normalize(db,True)
    assert compressed_rows(db)==130007 and fingerprint(db)==original
    db.execute('ANALYZE location_records')
    report.update(complete=True,all_ciphertext_equal=True,all_rows_recompressed=True,final_pending=0,
                  decompression_limit_raised=False,final_rows=130007)
v.load.save('backfill128',report)
print('PASS128 compressed correction complete without raising decompression limit',flush=True)
