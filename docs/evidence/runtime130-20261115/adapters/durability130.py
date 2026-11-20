"""Read-only check of effective durability settings for the synthetic API role."""
import json
from pathlib import Path
import sys
sys.path.insert(0,'/opt/gps121')
import load_runtime130 as l
import psycopg2
with psycopg2.connect(l.runtime()) as db:
    with db.cursor() as cur:
        cur.execute("SELECT name,setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes','wal_sync_method') ORDER BY name")
        settings=dict(cur.fetchall())
        cur.execute('SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user')
        user,superuser=cur.fetchone()
assert all(settings[k]=='on' for k in ('fsync','synchronous_commit','full_page_writes'))
assert user=='gps_runtime' and not superuser
l.save('durability130',dict(settings=settings,role=user,superuser=superuser,production_modified=False,
    scope='New connection using the actual synthetic runtime role; API source does not change these settings'))
print('PASS130 runtime-role durability remains on; not a superuser')
