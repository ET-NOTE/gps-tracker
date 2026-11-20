"""Differential/oracle consent tests and real populated108->109 migration.

Only the fixed internal tmpfs rehearsal DB is accepted. No network messages.
Cases include defensive persisted states; live consent authorization is also
covered by the unchanged 22/22B/22D HTTP suites in check_cumulative109.py.
"""
import datetime as dt
import hashlib
import json
import pathlib
import random
import subprocess
import time
import uuid

import psycopg
from psycopg.rows import dict_row

JOB=pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111cumulative112')
assert pathlib.Path(__file__).resolve().parent==JOB
NET='gps-provision22-test-20261111cumulative112'
DB='gps-provision22-db-20261111cumulative112'
info=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert info('network',NET)['Internal']
di=info('container',DB)
assert '/var/lib/postgresql/data' in di['HostConfig']['Tmpfs'] and not di['HostConfig']['PortBindings']
host=di['NetworkSettings']['Networks'][NET]['IPAddress']
dsn='postgres://postgres:closure-test-only@'+host+'/gps_mapping109_test'
OUT=JOB/'out'
report={'environment':'isolated synthetic','production_modified':False,'external_messages':0,'cases':[]}


def command(*args,**kw):
    return subprocess.run(list(args),check=True,stdout=subprocess.DEVNULL,**kw)


def migrate(binary,log):
    with (OUT/log).open('w') as f:
        command('docker','run','--rm','--network',NET,'--memory=550m','--cap-drop=ALL',
                '--security-opt=no-new-privileges','-e','APP_ENV=test','-e','GPS_MIGRATE_ONLY=1',
                '-e','DATABASE_URL='+dsn,'-e','JWT_SECRET=synthetic109-only',
                '-v',str(binary)+':/api:ro','gps-build:rust1.88-node22.22.2','/api',stderr=f)


command('docker','exec',DB,'createdb','-U','postgres','gps_mapping109_test')
old=JOB/'out/gps-tracker-api.baseline108'
assert hashlib.sha256(old.read_bytes()).hexdigest()=='36d89e4f0d0b0c6a1bcf73954fe019a2e29f3a761001a339f7cfc86b62b91cd0'
migrate(old,'mapping109-baseline.log')
db=psycopg.connect(dsn,autocommit=True,row_factory=dict_row)
db.execute("SET statement_timeout='60s'; SET jit=off")
one=lambda q,args=():next(iter(db.execute(q,args).fetchone().values()))
assert one('SELECT max(version) FROM _sqlx_migrations')==108
old_query=(JOB/'src/gps-tracker-api/migrations/0108_subject_revisions.sql').read_text().split('CREATE VIEW location_subject_effective AS\n',1)[1].split(';',1)[0]
owners=[];subjects=[];links={}
for prefix,arr in [('owner',owners),('subject',subjects)]:
    for i in range(3):
        arr.append(one("INSERT INTO users(phone,email,password_hash) VALUES(%s,%s,'no-login') RETURNING id",(prefix+str(i),prefix+str(i)+'@example.invalid')))
for owner in owners:
    for subject in subjects:
        sid=one("INSERT INTO staff(user_id,name,active) VALUES(%s,'Synthetic',true) RETURNING id",(owner,))
        db.execute('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(owner,sid,subject))
        links[owner,subject]=sid
start=dt.datetime(2026,11,1,tzinfo=dt.timezone.utc)
end=start+dt.timedelta(days=1)
device=100000


def add(status='confirmed',parent=None,kind='correction',prev=None,revision=1,
        owner=None,subject=None,did=None,a=start,b=end):
    owner=owner or owners[0];subject=subject or subjects[0]
    return one('''INSERT INTO location_subject_mappings(request_key,owner_id,subject_id,proposed_by,staff_id,
      vehicle_id,binding_id,device_id,starts_at,ends_at,status,revision,replaces_id,replaces_revision,change_kind)
      VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id''',
      (uuid.uuid4(),owner,subject,owner,links[owner,subject],did or device,did or device,did or device,
       a,b,status,revision,parent,(prev if prev is not None else 1) if parent else None,kind if parent else None))


def oracle():
    rows={r['id']:r for r in db.execute('SELECT * FROM location_subject_mappings')}
    active={(r['owner_id'],r['staff_id'],r['account_id']) for r in db.execute('''SELECT a.* FROM fleet_staff_accounts a
      JOIN staff s ON s.id=a.staff_id AND s.user_id=a.owner_id WHERE s.active''')}
    effective=[]
    for mid,m in rows.items():
        if m['status']!='confirmed' or (m['owner_id'],m['staff_id'],m['subject_id']) not in active:continue
        edges=[];node=m;seen=set()
        while node['replaces_id'] is not None:
            assert node['id'] not in seen;seen.add(node['id'])
            edges.append(node);node=rows[node['replaces_id']]
        blocked=False
        for r in rows.values():
            if r['status']!='revoked' or r['owner_id']!=m['owner_id'] or r['device_id']!=m['device_id']:continue
            if not (r['starts_at']<m['ends_at'] and r['ends_at']>m['starts_at']):continue
            allowed=any(e['replaces_id']==r['id'] and e['change_kind']=='reconsent' and
                        e['replaces_revision']==r['revision'] and e['subject_id']==r['subject_id']==m['subject_id'] for e in edges)
            if not allowed:blocked=True;break
        if not blocked:effective.append(mid)
    return sorted(effective)


def equivalent(label,expected=None):
    before=[r['id'] for r in db.execute('SELECT id FROM ('+old_query+') q ORDER BY id')]
    after=[r['id'] for r in db.execute('SELECT id FROM location_subject_effective ORDER BY id')]
    assert before==after==oracle(),label
    if expected:
        for mid,want in expected.items():assert (mid in after)==want,(label,mid,want)
    report['cases'].append({'case':label,'same_effective_ids':True,'oracle_equal':True,'effective_count':len(after)})


# All statuses, exact withdrawal revisions, cross-subject chains, temporal and
# tenant boundaries are persisted before the real migration.
expected={}
for status in ('pending','confirmed','rejected','revoked','superseded'):
    device+=1;expected[add(status)]=status=='confirmed'
device+=1
r=add('revoked',revision=2)
mid=add(parent=r,kind='reconsent',prev=2);expected[mid]=True
good=(r,mid)
device+=1
r=add('revoked',revision=2)
expected[add(parent=r,kind='reconsent',prev=1)]=False
device+=1
r=add('revoked',revision=2)
e1=add('superseded',parent=r,kind='reconsent',prev=2)
e2=add('revoked',parent=e1,revision=4)
e3=add('superseded',parent=e2,kind='reconsent',prev=4)
leaf=add(parent=e3);expected[leaf]=True
deep=(r,e2,leaf)
device+=1
r=add('revoked',revision=2)
e=add('superseded',parent=r,kind='reconsent',prev=2)
expected[add(parent=e,subject=subjects[1])]=False
device+=1
add('revoked',a=start-dt.timedelta(days=1),b=start)
expected[add()]=True  # touching half-open boundary is not an overlap
device+=1
add('revoked',a=end,b=end+dt.timedelta(days=1))
expected[add()]=True
device+=1
add('revoked',a=start+dt.timedelta(hours=1),b=end+dt.timedelta(hours=1))
expected[add()]=False
device+=1
add('revoked',owner=owners[1]);expected[add()]=True
device+=1
add('revoked',did=device+1);expected[add()]=True
device+=2
r=add('revoked',revision=2);e=add('superseded',parent=r,kind='reconsent',prev=2)
add('revoked');expected[add(parent=e)]=False  # unrelated withdrawal still blocks
equivalent('before migration: explicit consent/withdrawal/interval/tenant matrix',expected)

# Deterministic varied history, not just the favourable 32-deep load fixture.
rng=random.Random(109)
for _ in range(120):
    device+=1;owner=rng.choice(owners);subject=rng.choice(subjects);parent=None;prev=1
    depth=rng.randint(1,14)
    for i in range(depth):
        status=rng.choice(['pending','rejected','revoked','superseded'] if i<depth-1 else ['confirmed','pending','revoked','rejected'])
        revision=rng.randint(1,4)
        subject=rng.choice(subjects) if rng.random()<.2 else subject
        parent=add(status,parent,rng.choice(['correction','reconsent']),prev,revision,owner,subject)
        prev=revision
equivalent('before migration: deterministic mixed histories')
db.execute('GRANT SELECT ON location_subject_effective TO gps_runtime')
metadata=lambda:db.execute("SELECT oid,relowner,relacl::text FROM pg_class WHERE oid='location_subject_effective'::regclass").fetchone()
prior_metadata=metadata()
data_hash=lambda:one("SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY id)::text) FROM location_subject_mappings m")
prior_rows=data_hash();prior_view=one("SELECT pg_get_viewdef('location_subject_effective')")
sql109=(JOB/'src/gps-tracker-api/migrations/0109_subject_effective_ancestry.sql').read_text()
try:
    with db.transaction():db.execute(sql109);db.execute('SELECT 1/0')
except psycopg.errors.DivisionByZero:pass
else:raise AssertionError('injected migration failure not raised')
assert metadata()==prior_metadata and data_hash()==prior_rows and one("SELECT pg_get_viewdef('location_subject_effective')")==prior_view
db.close()
migrate(JOB/'out/gps-tracker-api','mapping109-migrate.log')
db=psycopg.connect(dsn,autocommit=True,row_factory=dict_row)
db.execute("SET statement_timeout='60s'; SET jit=off")
assert one('SELECT max(version) FROM _sqlx_migrations')==112
assert metadata()==prior_metadata and data_hash()==prior_rows
equivalent('populated108->112: identity, view owner/grants, all rows and effective decisions preserved',expected)
expected_runtime_count=len(oracle())
db.execute('SET ROLE gps_runtime')
assert one('SELECT count(*) FROM location_subject_effective')==expected_runtime_count
db.execute('RESET ROLE')
for parent,child in [(good[0],good[1]),(deep[0],deep[2]),(deep[1],deep[2])]:
    db.execute('UPDATE location_subject_mappings SET revision=revision+1 WHERE id=%s',(parent,))
    equivalent('later withdrawal revision invalidates descendant '+str(parent),{child:False})
sid=links[owners[0],subjects[0]]
db.execute('UPDATE staff SET active=false WHERE id=%s',(sid,))
equivalent('inactive staff removes all affected mappings')
db.execute('UPDATE staff SET active=true WHERE id=%s',(sid,))
db.execute('DELETE FROM fleet_staff_accounts WHERE staff_id=%s',(sid,))
equivalent('unlinked staff removes all affected mappings')
report.update(schema_path=[108,112],synthetic_mapping_rows=one('SELECT count(*) FROM location_subject_mappings'),
              failed109_transaction_atomic=True,view_identity_owner_grants_preserved=True,
              no_identity_or_consent_rewrite=True,runtime_select_preserved=True,
              api_sha256=hashlib.sha256((JOB/'out/gps-tracker-api').read_bytes()).hexdigest())
(OUT/'ancestry109-regression.json').write_text(json.dumps(report,indent=2)+'\n')
db.close()
command('docker','exec',DB,'dropdb','-U','postgres','--force','gps_mapping109_test')
print(json.dumps({'passed':len(report['cases']),'schema_path':[108,112]},indent=2))
