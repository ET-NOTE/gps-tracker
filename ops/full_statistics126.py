"""Diagnostic with the retained all-column helper adapter installed.

Use out/adapters/location_query_statistics-all-columns.py for this rejected
experiment, then reinstall the candidate helper. This is not the chosen fix.
"""
import json
import verify_runtime126 as v
ctx=json.loads(v.CONTEXT.read_text());dsn=ctx['dsn']
v.stop_api()
v.transition(dsn,ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'fence')
proof=v.transition(dsn,ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
assert proof['query_statistics']['columns']=='all physical columns; no decrypting view', 'install the retained experimental all-column helper for this diagnostic'
v.boot_settled(dict(RUNTIME_DSN=ctx['runtime'],STORAGE='pilot'))
rows=[v.request(ctx['uid'],ctx['did'],name) for name,_ in v.load.b.routes(ctx['did'])[:3]]
v.load.save('full-statistics126',dict(statistics=proof['query_statistics'],queries=rows))
v.stop_api()
assert all(r['status']==200 for r in rows),rows
