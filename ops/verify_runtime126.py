"""Isolated restored-DB evidence. No production DSN, coordinates or keys in output."""
import hashlib
import http.client
import json
import time
import psycopg
from runtime121_control import ROOT,DSN,secret,stop_api,boot_settled,transition
import load_runtime122 as load

load.b.JWT='synthetic-cumulative-migration-only'
load.b.SHA=(ROOT/'candidate124.sha256').read_text().strip()
CONTEXT=ROOT/'restore126-private.json'


def prepare_restore(dsn,runtime,uid,did,ring):
    stop_api()
    secret(str(CONTEXT),json.dumps(dict(dsn=dsn,runtime=runtime,uid=uid,did=did,ring=ring)))
    snapshot('fresh',dsn)


def snapshot(label,dsn):
    with psycopg.connect(dsn,autocommit=True) as db:
        tables=db.execute("""SELECT n.nspname,c.relname,c.relkind,c.reltuples,c.relpages,
            s.n_live_tup,s.last_analyze,s.last_autoanalyze,s.analyze_count,s.autoanalyze_count
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            LEFT JOIN pg_stat_all_tables s ON s.relid=c.oid
            WHERE n.nspname IN ('public','_timescaledb_internal') AND c.relkind IN ('r','m')
            ORDER BY n.nspname,c.relname""").fetchall()
        settings=dict(db.execute("SELECT name,setting FROM pg_settings WHERE name IN ('jit','jit_above_cost','jit_inline_above_cost','jit_optimize_above_cost','shared_buffers','work_mem','default_statistics_target','plan_cache_mode','autovacuum')").fetchall())
        state=dict(schema=db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0],
            maintenance=db.execute('SELECT maintenance FROM location_storage_policy').fetchone()[0],
            plaintext=db.execute('SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL').fetchone()[0])
    load.save('stats126-'+label,dict(tables=[[str(x) if x is not None else None for x in r] for r in tables],settings=settings,state=state))


def request(uid,did,name='month_aggregate'):
    path=dict(load.b.routes(did))[name]
    c=http.client.HTTPConnection('127.0.0.1',3043,timeout=90)
    t=time.monotonic()
    c.request('GET',path,headers={'Authorization':'Bearer '+load.b.token(uid)})
    r=c.getresponse();body=r.read();c.close()
    return dict(route=name,status=r.status,seconds=round(time.monotonic()-t,6),bytes=len(body),sha256=hashlib.sha256(body).hexdigest())


def baseline():
    ctx=json.loads(CONTEXT.read_text());dsn=ctx['dsn']
    transition(dsn,ctx['ring'],str(ROOT/'test-storage/uploads'),str(ROOT/'test-storage/private'),'resume')
    boot_settled(dict(RUNTIME_DSN=ctx['runtime'],STORAGE='pilot'))
    try:
        rows=[]
        for i in range(2):
            row=request(ctx['uid'],ctx['did']);rows.append(row)
            load.save('baseline126',dict(api_sha256=load.b.SHA,period=load.b.MONTH,api_budget_seconds=20,queries=rows))
            print('RESTORE BASELINE',row,flush=True)
    finally:stop_api()
    transition(dsn,ctx['ring'],str(ROOT/'test-storage/uploads'),str(ROOT/'test-storage/private'),'fence')
    snapshot('after-baseline',dsn)


if __name__=='__main__':baseline()
