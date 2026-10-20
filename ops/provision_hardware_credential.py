"""Factory enrollment of new GPS hardware; no SIM or user account is required."""
import argparse,hashlib,json,os,pathlib,re,secrets,urllib.parse
import psycopg2
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--env',required=True);p.add_argument('--auth-uid',required=True,help='hw- followed by the 12 hex MAC digits')
p.add_argument('--output',required=True,type=pathlib.Path)
a=p.parse_args();os.umask(0o077)
assert re.fullmatch(r'hw-[0-9a-f]{12}',a.auth_uid)
assert a.output.is_absolute() and not a.output.exists()
env={k:v.strip().strip('"').strip("'") for k,v in (line.split('=',1) for line in pathlib.Path(a.env).read_text().splitlines() if '=' in line and not line.startswith('#'))}
url=urllib.parse.urlsplit(env['DATABASE_URL'])
assert url.hostname in ('localhost','127.0.0.1') and url.path.startswith('/gps_tracker')
key=secrets.token_hex(32)
with psycopg2.connect(env['DATABASE_URL']) as db:
 with db.cursor() as c:
  c.execute('INSERT INTO hardware_credentials(auth_uid,key_digest) VALUES(%s,%s)',(a.auth_uid,hashlib.sha256(key.encode()).digest()))
  a.output.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
  fd=os.open(a.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w') as f:json.dump({'device_uid':a.auth_uid,'key':key},f)
print(json.dumps({'auth_uid':a.auth_uid,'credential_file':str(a.output),'SIM_required':False,'owner_assigned':False}))
