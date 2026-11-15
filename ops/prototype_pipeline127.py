"""Continue a disposable113 prototype; restore all pinned functions first."""
import json
import psycopg
import verify_runtime126 as v

ctx=json.loads(v.CONTEXT.read_text());v.stop_api()
with psycopg.connect(ctx['dsn'],autocommit=True) as db:
    for definition in json.loads((v.ROOT/'out/oracle113-functions.json').read_text()).values():
        db.execute(definition)
# Re-run the paired experiment with explicit decompression and pinned113 code.
import probe_runtime127
