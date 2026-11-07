"""Schema 103 compatibility for round19's offline, two-person bootstrap.
Runs only against round20's internal, tmpfs synthetic database.
"""
import json,pathlib,subprocess
import psycopg2
from admin_security_bootstrap import bootstrap
root=pathlib.Path(__file__).resolve().parent
assert str(root).startswith('/home/etcom-hub/build/gps-crypto20-')
net='gps-crypto20-test-20261105';name='gps-crypto20-db-20261105'
n=json.loads(subprocess.check_output(['docker','network','inspect',net]))[0]
d=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
assert n['Internal'] and '/var/lib/postgresql/data' in d['HostConfig']['Tmpfs']
dsn='postgres://postgres:closure-test-only@'+d['NetworkSettings']['Networks'][net]['IPAddress']+'/gps_closure_test'
with psycopg2.connect(dsn) as db:
 with db.cursor() as c:
  c.execute("SELECT id FROM users WHERE display_name='Synthetic crypto' ORDER BY id")
  ids=[r[0] for r in c.fetchall()];assert len(ids)==2
  c.execute('SELECT count(*) FROM admin_principals');assert c.fetchone()[0]==0
result=bootstrap(dsn,*ids,['192.0.2.10/32'],'round20 synthetic compatibility',False)
assert result['schema']==103 and not result['apply']
with psycopg2.connect(dsn) as db:
 with db.cursor() as c:c.execute('SELECT count(*) FROM admin_principals');assert c.fetchone()[0]==0
result=bootstrap(dsn,*ids,['192.0.2.10/32'],'round20 synthetic compatibility',True)
with psycopg2.connect(dsn) as db:
 with db.cursor() as c:
  c.execute('SELECT role FROM admin_principals ORDER BY role');assert [r[0] for r in c.fetchall()]==['officer','operator']
  c.execute('SELECT enabled FROM location_storage_policy');assert c.fetchone()[0]
result={'synthetic':True,'production_modified':False,'schema':103,'checks':['dry-run writes no principals','apply creates two distinct officer/operator principals','encryption policy remains enabled'],'passed':True}
(root/'out/crypto20-bootstrap.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
