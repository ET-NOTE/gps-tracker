"""Offline subject checkpoint tests. Internal disposable round22 DB only."""
import hashlib,json,pathlib,subprocess
import psycopg
from privacy_restore_checkpoint import export,restore
from privacy_retention import run as retain
HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE).startswith('/home/etcom-hub/build/gps-provision22-')
NET='gps-provision22-test-20261108';DB='gps-provision22-db-20261108'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
assert '/var/lib/postgresql/data' in inspect('container',DB)['HostConfig']['Tmpfs']
dsn='postgres://postgres:closure-test-only@'+inspect('container',DB)['NetworkSettings']['Networks'][NET]['IPAddress']+'/gps_closure_test'
cfg={'DATABASE_URL':dsn}
f=json.loads((HERE/'out/round22-integration.json').read_text())['fixture']
p=HERE/'test-subject-checkpoint.json';p.unlink(missing_ok=True)
subprocess.run(['bash',str(HERE/'dev22.sh'),'stop'],check=True)
with psycopg.connect(dsn,autocommit=True) as db:
 db.execute("UPDATE location_provision_notices SET delivery='provider_accepted',provider_accepted_at=now(),read_at=NULL WHERE id=%s",(f['notice'],))
 db.execute("INSERT INTO privacy_retention_consents(user_id,months,consent_reference) VALUES(%s,6,'isolated-review') ON CONFLICT DO NOTHING",(f['subject'],))
result=export(cfg,p)
assert json.loads(p.read_text())['version']==2
preview=retain(cfg,False)
row=next(x for x in preview['accounts'] if x['account_id']==f['subject'])
assert 'company_subject_and_retention_review' in row['review_reasons'],row
with psycopg.connect(dsn,autocommit=True) as db:
 db.execute("UPDATE location_subject_mappings SET status='confirmed',revision=1 WHERE id=%s",(f['mapping'],))
 db.execute("UPDATE location_provision_notices SET delivery='pending',provider_accepted_at=NULL,read_at=NULL WHERE id=%s",(f['notice'],))
restore(cfg,p,result['sha256'])
with psycopg.connect(dsn,autocommit=True) as db:
 assert db.execute('SELECT status,revision FROM location_subject_mappings WHERE id=%s',(f['mapping'],)).fetchone()==('revoked',2)
 assert db.execute("SELECT delivery,provider_accepted_at IS NOT NULL,read_at IS NULL FROM location_provision_notices WHERE id=%s",(f['notice'],)).fetchone()==('provider_accepted',True,True)
 assert db.execute('SELECT enabled OR push_enabled FROM location_subject_policy').fetchone()==(False,)
 assert db.execute("SELECT count(*) FROM location_provision_notices WHERE delivery IN ('waiting','pending') OR lease_id IS NOT NULL").fetchone()==(0,)
# Reject old-format checkpoints and immutable identity collisions without changing rows.
for mode in ('version','identity'):
 data=json.loads(p.read_text())
 if mode=='version':data['version']=1
 else:data['tables']['location_subject_mappings'][0]['subject_id']+=100000
 bad=HERE/'test-invalid-checkpoint.json';body=json.dumps(data).encode();bad.write_bytes(body);bad.chmod(0o600)
 try:restore(cfg,bad,hashlib.sha256(body).hexdigest())
 except ValueError:pass
 else:raise AssertionError('invalid checkpoint accepted')
 bad.unlink()
with psycopg.connect(dsn,autocommit=True) as db:
 assert db.execute('SELECT status,revision FROM location_subject_mappings WHERE id=%s',(f['mapping'],)).fetchone()==('revoked',2)
p.unlink()
out={'revocation_replayed':True,'provider_acceptance_not_read':True,'restore_send_disabled':True,'unresolved_queue_review':True,'old_format_rejected':True,'identity_collision_atomic':True,'former_staff_retention_hold':True,'external_backup_erasure_verified':False}
(HERE/'out/round22-restore.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
