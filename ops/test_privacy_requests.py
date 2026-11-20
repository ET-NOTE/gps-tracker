"""Rights workflow regression; only the named disposable Docker environment.

Run on the isolated build host: python3 ops/test_privacy_requests.py
Uses fake accounts/coordinates. Never reads production configuration.
"""
import base64
import concurrent.futures
import hashlib
import hmac
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid

DB = 'gps-rights-db-20261105'
API = 'gps-rights-api-20261105'
network = json.loads(subprocess.check_output(['docker', 'network', 'inspect', 'gps-rights-test-20261105']))[0]
assert network['Internal'] is True
info = json.loads(subprocess.check_output(['docker', 'inspect', API]))[0]
assert 'APP_ENV=test' in info['Config']['Env']
assert 'DATABASE_URL=postgres://postgres:rights-test-only@rights-db:5432/gps_rights_test' in info['Config']['Env']
ip = info['NetworkSettings']['Networks']['gps-rights-test-20261105']['IPAddress']
BASE = f'http://{ip}:3043/gps-tracker/api/v1'
SECRET = b'rights-test-only-jwt-key-32-characters'
PASSWORD = 'Rights-test-pass-2026'
HASH = '$argon2id$v=19$m=65536,t=3,p=4$VneViXVy+uzQocTBcM+PbA$Ahwgvv0NEg5CdkyJhPE/qNdOpWCojTitj4ebCwFQpg4'
run = uuid.uuid4().hex

def sql(query):
    return subprocess.check_output(['docker','exec','-i',DB,'psql','-U','postgres','-d','gps_rights_test','-qAt','-v','ON_ERROR_STOP=1'],input=query.encode()).decode().strip()

def token(user):
    enc = lambda v: base64.urlsafe_b64encode(json.dumps(v,separators=(',',':')).encode()).rstrip(b'=')
    raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(user),'iat':int(time.time()),'exp':int(time.time())+3600,'typ':'access'})
    return (raw+b'.'+base64.urlsafe_b64encode(hmac.new(SECRET,raw,hashlib.sha256).digest()).rstrip(b'=')).decode()

def request(path,user=None,data=None,method=None,expected=200,headers=None):
    headers=dict(headers or {})
    if user: headers['Authorization']='Bearer '+token(user)
    raw=None
    if data is not None:
        raw=json.dumps(data).encode();headers['Content-Type']='application/json'
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE+path,data=raw,method=method,headers=headers),timeout=15) as r:
            status,body=r.status,r.read()
    except urllib.error.HTTPError as e: status,body=e.code,e.read()
    assert status==expected,(path,status,expected,body[:250])
    return json.loads(body)

def create(user,kind='access',scope='테스트 자료 열람',key=None,expected=202):
    return request('/privacy/requests',user,{'request_key':key or str(uuid.uuid4()),'kind':kind,'scope':scope,'password':PASSWORD},expected=expected)

users=[]
for name,role in [('owner','user'),('other','user'),('staff','user'),('admin','admin'),('deleted','user')]:
    uid=int(sql(f"INSERT INTO users(email,password_hash,phone,role) VALUES('rights-{run}-{name}@example.invalid','{HASH}','01000000000','{role}') RETURNING id;"))
    users.append(uid)
owner,other,staff,admin,deleted=users
iccid='89882'+str(int(run[:10],16)).zfill(14)
device=int(sql(f"INSERT INTO devices(device_uid,api_key_hash,owner_id,iccid) VALUES('rights-{run}','',{other},'{iccid}1') RETURNING id;"))
sql(f"INSERT INTO location_records(device_id,recorded_at,source,fix,lat,lng,user_id) VALUES({device},now()-interval '2h','l80',true,37.1,127.1,{owner}),({device},now()-interval '1h','l80',true,37.2,127.2,{other}),({device},now()-interval '3h','l80',true,37.3,127.3,NULL);")
sid=int(sql(f"INSERT INTO staff(user_id,name) VALUES({owner},'Fixture driver') RETURNING id;"))
sql(f"INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES({owner},{sid},{staff});")

request('/privacy/requests',expected=401)
request('/admin/privacy/requests',owner,expected=403)
request('/privacy/requests',staff,headers={'X-Fleet-Owner':str(owner)},expected=403)
request('/privacy/requests',owner,{'request_key':str(uuid.uuid4()),'kind':'access','scope':'test','password':'wrong'},expected=400)
assert request('/privacy/requests',owner)==[]
print('PASS authentication, administrator boundary, delegated scope rejection, password check',flush=True)

key=str(uuid.uuid4())
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    replay=list(pool.map(lambda _:create(owner,key=key),range(4)))
row=replay[0];rid=row['id']
assert all(r['id']==rid and r['revision']==1 for r in replay)
assert sql(f'SELECT count(*) FROM privacy_request_events WHERE request_id={rid};')=='1'
create(owner,scope='different',key=key,expected=409)
create(owner,expected=409)
request(f'/privacy/requests/{rid}/cancel',other,{'revision':1},expected=404)
assert request('/privacy/requests',other)==[]
print('PASS concurrent retry idempotency, duplicate conflict and cross-account isolation',flush=True)

impact=request('/privacy/impact',owner)
counts={x['key']:x['count'] for x in impact['items']}
assert counts['devices']==0 and counts['location_records']==1 and counts['staff']==1
staff_counts={x['key']:x['count'] for x in request('/privacy/impact',staff)['items']}
assert staff_counts['location_records']==0 and staff_counts['staff']==0 and staff_counts['fleet_staff_accounts']==1
assert sql(f'SELECT count(*) FROM location_records WHERE device_id={device};')=='3'
assert impact['read_only'] and not impact['deletion_ready']
assert len(request(f'/admin/privacy/requests/{rid}/impact',admin)['items'])==len(impact['items'])
print('PASS detached SIM history inventory, NULL and new-owner exclusion, employee/company separation',flush=True)

due='2026-12-01T00:00:00Z'
body={'revision':1,'status':'in_review','message':'자료 확인 중','due_at':due,'evidence_reference':'fixture-review-1'}
request(f'/admin/privacy/requests/{rid}',admin,{**body,'due_at':None},method='PATCH',expected=400)
review=request(f'/admin/privacy/requests/{rid}',admin,body,method='PATCH')
assert review['revision']==2 and review['assigned_to']==admin
request(f'/admin/privacy/requests/{rid}',admin,body,method='PATCH',expected=409)
request(f'/admin/privacy/requests/{rid}',admin,{'revision':2,'status':'fulfilled','message':'전달 완료'},method='PATCH',expected=400)
done=request(f'/admin/privacy/requests/{rid}',admin,{'revision':2,'status':'fulfilled','message':'안전한 경로로 전달 완료','evidence_reference':'fixture-delivery-1'},method='PATCH')
assert done['status']=='fulfilled'
assert 'evidence_reference' not in request('/privacy/requests',owner)[0]
detail=request(f'/admin/privacy/requests/{rid}',admin)
assert len(detail['events'])==3 and detail['evidence_reference']=='fixture-delivery-1'
assert detail['events'][1]['evidence_reference']=='fixture-review-1'
assert detail['events'][1]['due_at'].startswith('2026-12-01')
assert detail['events'][2]['evidence_reference']=='fixture-delivery-1'
request(f'/privacy/requests/{rid}/cancel',owner,{'revision':3},expected=409)
print('PASS deadline validation, optimistic concurrency, verified outcome reference and event history',flush=True)

for kind in ('erasure','account_closure'):
    item=create(owner,kind=kind)
    request(f'/admin/privacy/requests/{item["id"]}',admin,{'revision':1,'status':'fulfilled','message':'unchecked','evidence_reference':'fake'},method='PATCH',expected=409)
    assert request('/privacy/requests',owner)[0]['status']=='received'
request('/auth/me',owner,{'password':PASSWORD},method='DELETE',expected=409)
assert sql(f'SELECT count(*) FROM users WHERE id={owner};')=='1'
assert sql(f'SELECT count(*) FROM location_records WHERE device_id={device};')=='3'
item=create(other,kind='rectification')
request(f'/privacy/requests/{item["id"]}/cancel',other,{'revision':1})
request(f'/privacy/requests/{item["id"]}/cancel',other,{'revision':1},expected=409)
print('PASS erasure/closure cannot be falsely completed, legacy DELETE preserves identity, stale cancel rejected',flush=True)

sql(f'DELETE FROM users WHERE id={deleted};')
request('/auth/me/prefs',deleted,expected=401)
request('/privacy/requests',deleted,expected=401)
print('PASS deleted-account access JWT rejected',flush=True)
print(json.dumps({'ok':True,'fixture':run,'requests':int(sql('SELECT count(*) FROM privacy_requests;'))},ensure_ascii=False))
