"""Observe automatic compression and test whether full DB statistics repair it."""
import json
import psycopg
import profile_runtime126 as p
import verify_runtime126 as v
ctx=json.loads(v.CONTEXT.read_text());dsn=ctx['dsn'];v.stop_api()
p.profile('compressed-history-plan',analyze=False,route='history')
with psycopg.connect(dsn,autocommit=True) as db:
    chunks=db.execute("SELECT chunk_schema,chunk_name,is_compressed FROM timescaledb_information.chunks WHERE hypertable_name='location_records' ORDER BY chunk_name").fetchall()
    db.execute("SET statement_timeout='60s'; SET lock_timeout='5s'; ANALYZE")
v.boot_settled(dict(RUNTIME_DSN=ctx['runtime'],STORAGE='pilot'))
rows=[v.request(ctx['uid'],ctx['did'],name) for name,_ in v.load.b.routes(ctx['did'])[:3]]
v.load.save('compressed-full-db-analyze126',dict(chunks=chunks,queries=rows,
    scope='diagnostic disposable DB only; entire DB ANALYZE is not the production fix'))
v.stop_api()
p.profile('compressed-analyzed-history-plan',analyze=False,route='history')
