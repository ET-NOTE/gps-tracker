"""Capture the restart failure and compare requests after startup activity."""
import json
import subprocess
import psycopg
import verify_runtime126 as v

ctx=json.loads(v.CONTEXT.read_text())
log=subprocess.check_output(['journalctl','-u','gps121-api','--no-pager','-o','cat'],text=True)
(v.ROOT/'out/restart-failure126.log').write_text(log)
v.snapshot('after-restart',ctx['dsn'])
rows=[]
for name,_ in v.load.b.routes(ctx['did'])[:3]:
    rows.append(v.request(ctx['uid'],ctx['did'],name))
v.load.save('restart-retry126',dict(queries=rows,api_budget_seconds=20))
v.stop_api()
import profile_runtime126 as p
p.profile('after-restart-plan',analyze=False)
