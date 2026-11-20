"""Bounded synthetic encryption benchmark/inventory. Never connects to production."""
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import time
import psycopg

job = Path(__file__).resolve().parent
assert str(job).startswith('/home/etcom-hub/build/gps-crypto20-')
net = 'gps-crypto20-test-20261105'
container = 'gps-crypto20-db-20261105'
network = json.loads(subprocess.check_output(['docker', 'network', 'inspect', net]))[0]
assert network['Internal']
state = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
assert '/var/lib/postgresql/data' in state['HostConfig']['Tmpfs']
addr = state['NetworkSettings']['Networks'][net]['IPAddress']
db = psycopg.connect(f'postgres://postgres:closure-test-only@{addr}/gps_closure_test', autocommit=True)
ring = json.loads((job / 'test-keys.json').read_text())
with db.cursor() as cur:
    cur.execute("SELECT set_config('gps.storage_keys',%s,false)", (json.dumps(ring),))
    cur.execute("SET jit=off")
    cur.execute("SET statement_timeout='20s'")
    cur.execute('SELECT enabled FROM location_storage_policy'); assert cur.fetchone()[0]
    cur.execute('SELECT min(id) FROM users'); owner = cur.fetchone()[0]
    cur.execute("INSERT INTO devices(device_uid,api_key_hash,owner_id) VALUES('synthetic-crypto-benchmark','',%s) RETURNING id", (owner,))
    device = cur.fetchone()[0]
    # 300 batches x 30 points = 9,000 synthetic points, never a real user's data.
    began = time.monotonic()
    cur.execute("""INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,raw,fixes_jsonb)
      SELECT %s,%s,'2026-11-01'::timestamptz+i*interval '30 seconds','l80',true,37.1,127.1,
       jsonb_build_object('cbc_mv',4100,'boot',1),
       (SELECT jsonb_agg(jsonb_build_object('at_ms',j*1000,'lat',37.1+j*0.00001,'lng',127.1+j*0.00001,'sat',12,'up_ms',i*30000+j*1000)) FROM generate_series(-29,0) j)
      FROM generate_series(1,300) i""", (device, owner))
    insert_ms = (time.monotonic()-began)*1000
    measures = []
    for _ in range(3):
        began = time.monotonic()
        cur.execute("SELECT count(*) FROM location_history_points_between(%s,%s,'2026-11-01','2026-11-02')", (device, owner))
        count = cur.fetchone()[0]; assert count == 9000, count
        measures.append((time.monotonic()-began)*1000)
    cur.execute("SELECT pg_total_relation_size('location_records'),pg_total_relation_size('devices')")
    sizes = cur.fetchone()
    cur.execute("""SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name NOT LIKE 'gps_read_%'
      AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname='public')
      AND column_name NOT LIKE '%_sealed'
      AND (column_name ~ '(lat|lng|latitude|longitude|geometry|address|path|route|snapshot|analysis)' OR data_type='jsonb')
      ORDER BY table_name,ordinal_position""")
    candidates = [dict(zip(['table','column','type'], r)) for r in cur.fetchall()]
db.close()
result = {'environment':'isolated synthetic fixture; not production capacity',
          'batches':300,'points':9000,'insert_ms':round(insert_ms,2),
          'history_count_ms':[round(x,2) for x in measures],
          'history_count_median_ms':round(statistics.median(measures),2),
          'timeout_ms':20000,'parent_relation_bytes':list(sizes),
          'candidate_inventory_requires_content_review':candidates,
          'api_sha256':hashlib.sha256((job/'out/gps-tracker-api').read_bytes()).hexdigest()}
(job/'out/crypto20-measurement.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='candidate_inventory_requires_content_review'}))
