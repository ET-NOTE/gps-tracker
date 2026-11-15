"""60s paired old113 control;126 retains the full300s prior failures."""
import json
import os
import psycopg
import verify_runtime126 as v

ctx=json.loads(v.CONTEXT.read_text());v.stop_api()
with psycopg.connect(ctx['dsn'],autocommit=True) as db:
    for definition in json.loads((v.ROOT/'out/oracle113-functions.json').read_text()).values():
        db.execute(definition)
os.environ['PERF127_PHASE']='baseline-compressed'
import perf_runtime127
