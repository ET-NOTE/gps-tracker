"""Create a device credential on the API host; secret is written only to a private file."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import urllib.parse
import psycopg2

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--env',required=True);p.add_argument('--device-id',type=int,required=True)
p.add_argument('--expected-owner',type=int,required=True);p.add_argument('--expected-uid',required=True)
p.add_argument('--output',type=Path,required=True);p.add_argument('--rotate',action='store_true')
a=p.parse_args();os.umask(0o077)
env=dict(line.split('=',1) for line in Path(a.env).read_text().splitlines() if '=' in line and not line.startswith('#'))
url=env['DATABASE_URL'].strip().strip('"').strip("'");parsed=urllib.parse.urlsplit(url)
assert parsed.hostname in ('127.0.0.1','localhost') and parsed.path.startswith('/gps_tracker')
assert a.output.is_absolute() and not a.output.exists(), 'Use a fresh private output path'
key=secrets.token_hex(32)
with psycopg2.connect(url) as db:
 with db.cursor() as c:
  c.execute('SELECT pg_advisory_xact_lock(%s)',(a.device_id,))
  c.execute('SELECT device_uid,owner_id FROM devices WHERE id=%s FOR UPDATE',(a.device_id,))
  assert c.fetchone()==(a.expected_uid,a.expected_owner), 'Device identity or owner changed'
  c.execute('SELECT EXISTS(SELECT 1 FROM device_credentials WHERE device_id=%s)',(a.device_id,))
  assert not c.fetchone()[0] or a.rotate, 'Existing key requires explicit --rotate'
  c.execute('''INSERT INTO device_credentials(device_id,key_digest) VALUES(%s,%s)
    ON CONFLICT(device_id) DO UPDATE SET key_digest=EXCLUDED.key_digest,last_counter=0''',
    (a.device_id,hashlib.sha256(key.encode()).digest()))
  a.output.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
  fd=os.open(a.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w') as f:
   json.dump({'device_uid':a.expected_uid,'device_id':a.device_id,'key':key},f)
print(json.dumps({'device_id':a.device_id,'credential_file':str(a.output),'activated':False}))
