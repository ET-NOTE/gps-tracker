"""Fresh synthetic accounts only; refuses any non-isolated Docker target."""
import base64
import concurrent.futures
import hashlib
import hmac
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from unittest.mock import patch

import psycopg2
import websocket
import privacy_account_closure as closure_module
from privacy_account_closure import execute, process
from privacy_file_cleanup import process_one

NETWORK = 'gps-account-closure-test-20261105'
DB = 'gps-account-closure-db-20261105'
API = 'gps-account-closure-api-20261105'
inspect = lambda kind, name: json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]
assert inspect('network', NETWORK)['Internal']
di, ai = inspect('container', DB), inspect('container', API)
binary=pathlib.Path(__file__).parent/'out/gps-tracker-api'
running=subprocess.check_output(['docker','exec',API,'sha256sum','/proc/1/exe']).decode().split()[0]
assert running==hashlib.sha256(binary.read_bytes()).hexdigest(), 'test binary differs from release artifact'
cfg = dict(v.split('=', 1) for v in ai['Config']['Env'] if '=' in v)
assert cfg['APP_ENV'] == 'test' and cfg['DATABASE_URL'] == 'postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test'
dsn = f"postgres://postgres:closure-test-only@{di['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_closure_test"
base = f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043"
for attempt in range(30):
    try:
        with urllib.request.urlopen(base+'/gps-tracker/health',timeout=2) as response:
            if json.load(response)['db']:break
    except (urllib.error.URLError,TimeoutError):time.sleep(1)
else:raise AssertionError('isolated API not ready')
db = psycopg2.connect(dsn); db.autocommit = True
worker = psycopg2.connect(dsn)
passed = []
tag = uuid.uuid4().hex[:12]
password = 'isolated-closure-fixture-Only9!'


def sql(query, args=(), connection=db):
    with connection.cursor() as q:
        q.execute(query, args)
        return q.fetchone()[0] if q.description else None


def call(method, path, body=None, bearer=None, headers=None):
    h = {'Content-Type': 'application/json', **(headers or {})}
    if bearer:
        h['Authorization'] = 'Bearer '+bearer
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(urllib.request.Request(base+'/gps-tracker/api/v1'+path, data=data, method=method, headers=h), timeout=15) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def account(n):
    phone = '010'+str(int(tag,16)+n)[-8:]
    email = f'{tag}-{n}@example.invalid'
    status, otp = call('POST', '/auth/send-otp', {'phone': phone})
    assert status == 200, (status, otp)
    status, row = call('POST', '/auth/register', {'email': email, 'phone': phone, 'otp_code': otp['dev_code'], 'password': password, 'display_name': 'Privacy fixture'})
    assert status == 200, (status, row)
    row['email'] = email
    return row


def check(name):
    passed.append(name); print('PASS '+name, flush=True)


def intake(a):
    body = {'request_key': str(uuid.uuid4()), 'kind': 'account_closure', 'scope': 'Synthetic full account closure verification', 'password': password}
    status, r = call('POST', '/privacy/requests', body, a['access_token'])
    assert status == 202, (status, r)
    status, same = call('POST', '/privacy/requests', body, a['access_token'])
    assert status == 202 and same['id'] == r['id']
    return r


def start(r, token):
    return call('POST', f"/admin/privacy/requests/{r['id']}/close-account", {'revision': r['revision']}, token)


owner, other, admin, company = [account(n) for n in range(4)]
uid, foreign = owner['user_id'], other['user_id']
sql("UPDATE users SET role='admin' WHERE id=%s", (admin['user_id'],))
assert call('GET','/auth/me',bearer=owner['access_token'])[0] == 200
assert call('DELETE','/auth/me',{'password':password},owner['access_token'])[0] == 409
check('real OTP/register/login-compatible tokens; legacy destructive DELETE blocked')

sim = '89882280666'+str(int(tag,16))[-8:]
did = sql("INSERT INTO devices(device_uid,iccid,owner_id,api_key_hash,display_name,last_lat,last_lng,last_fix_at) VALUES(%s,%s,%s,'fixture','fixture',37.1,127.1,now()) RETURNING id", (tag+'-sim',sim,uid))
detached = sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'fixture') RETURNING id", (tag+'-detached',foreign))
for d,u,s in ((did,uid,1),(did,foreign,2),(did,None,3),(detached,uid,4),(detached,foreign,5)):
    sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES(%s,%s,now()-%s*interval '1 day','l80',true,37.1,127.1)",(d,u,s))
for u in (uid,foreign):
    sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES(%s,%s,now()-interval '90 days'-%s*interval '1 second','l80',true,37.1,127.1)",(detached,u,u))
sql("SELECT count(compress_chunk(c)) FROM show_chunks('location_records',older_than=>interval '30 days') c")
foreign_fingerprint = sql("SELECT md5(string_agg(to_jsonb(r)::text,',' ORDER BY device_id,recorded_at)) FROM location_records r WHERE user_id IS DISTINCT FROM %s",(uid,))
sql("INSERT INTO share_tokens(token,device_id,created_by,expires_at) VALUES(%s,%s,%s,now()+interval '1 day')",(tag+'share',did,uid))
sql("INSERT INTO fcm_tokens(user_id,token,platform) VALUES(%s,%s,'android')",(uid,tag+'fcm'))
sql("INSERT INTO location_1min(device_id,bucket) VALUES(%s,date_trunc('minute',now())-interval '10 days')",(did,))
root = pathlib.Path(cfg['UPLOAD_DIR'])
file = root/'device_documents'/str(uid)/str(did)/(str(uuid.uuid4())+'_fixture.pdf')
file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(b'%PDF-1.7 fake')
doc = sql("INSERT INTO device_documents(user_id,device_id,kind,filename,stored_path,mime,size_bytes) VALUES(%s,%s,'other','fixture.pdf',%s,'application/pdf',13) RETURNING id",(uid,did,str(file)))
assert call('GET',f'/share/{tag}share')[0] == 200
r = intake(owner)
ws=websocket.create_connection(base.replace('http:','ws:')+'/gps-tracker/ws/realtime?token='+owner['access_token'],timeout=5)
assert json.loads(ws.recv())['type']=='hello'
assert start(r,other['access_token'])[0] == 403
assert call('POST',f"/admin/privacy/requests/{r['id']}/close-account",{'revision':999},admin['access_token'])[0] == 409
assert sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s',(uid,)) is False
check('password-authenticated idempotent intake / foreign admin and stale revision denied')

# Closure waits for earlier guarded writes, so no write can land behind its commit.
inflight = psycopg2.connect(dsn)
sql("INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,'fixture',now())",(did,uid),inflight)
with concurrent.futures.ThreadPoolExecutor() as pool:
    pending = pool.submit(start,r,admin['access_token']);time.sleep(.3)
    assert not pending.done()
    inflight.commit()
    status, closed = pending.result()
assert status == 200 and closed['state']=='restricted', (status,closed)
assert start(r,admin['access_token'])[0] == 200
ws.send(json.dumps({'action':'subscribe','device_ids':[did]}))
assert ws.recv()==''
ws.close()
try:websocket.create_connection(base.replace('http:','ws:')+'/gps-tracker/ws/realtime?token='+owner['access_token'],timeout=5)
except websocket.WebSocketBadStatusException as e:assert e.status_code==401
else:raise AssertionError('closed account websocket upgraded')
check('closure drains a guarded transaction / start is safely repeatable')
check('active WebSocket closes on next command; new WebSocket with old JWT denied')

for path in ('/auth/me','/devices','/privacy/requests',f'/documents/{doc}/download'):
    assert call('GET',path,bearer=owner['access_token'])[0] == 401, path
status, notice=call('POST','/auth/login',{'email':owner['email'],'password':password})
assert status == 409 and str(r['id']) in notice
assert call('POST','/auth/login',{'email':owner['email'],'password':'wrong'})[0] == 401
assert call('POST','/auth/refresh',{'refresh_token':owner['refresh_token']})[0] == 401
assert call('GET',f'/share/{tag}share')[0] == 404
assert sql('SELECT count(*) FROM fcm_tokens WHERE user_id=%s',(uid,)) == 0
assert call('PATCH',f"/admin/privacy/requests/{r['id']}",{'revision':closed.get('revision',2),'status':'rejected','message':'bad override','evidence_reference':'fixture'},admin['access_token'])[0] == 409
check('existing access/refresh/login/share/file access revoked; completion/rejection bypass denied')

for query,args in [
 ("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix) VALUES(%s,%s,now(),'l80',false)",(did,uid)),
 ("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix) VALUES(%s,NULL,now(),'l80',false)",(did,)),
 ("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix) VALUES(%s,%s,now(),'l80',false)",(detached,uid)),
 ("UPDATE devices SET last_lat=37.4 WHERE id=%s",(did,)),
 ("UPDATE devices SET owner_id=%s WHERE id=%s",(uid,detached)),
 ("INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES(%s,'late',now()+interval '1 day')",(uid,)),
]:
    try:sql(query,args)
    except psycopg2.Error as e:assert e.pgcode=='55000',e.pgcode
    else:raise AssertionError('late write accepted')
check('stale writers blocked for current SIM, detached owner history, NULL-owner bypass and new sessions')

key=hashlib.sha256(b'synthetic-closure-key').digest();auth=tag+'hardware'
sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)',(auth,key,uid))
raw=json.dumps({'iccid':sim,'l80':{'fix':True,'lat':37.9,'lng':127.9}},separators=(',',':')).encode()
sig=hmac.new(key,f'{auth}\n1\n'.encode()+raw,hashlib.sha256).hexdigest()
req=urllib.request.Request(base+'/gps-tracker/ingest',data=raw,headers={'Content-Type':'application/json','X-GPS-Auth-Version':'2','X-GPS-UID':auth,'X-GPS-Counter':'1','X-GPS-Signature':sig})
with urllib.request.urlopen(req,timeout=15) as response:ack=json.load(response)
assert hmac.compare_digest(ack['signature'],hmac.new(key,f"response\n{auth}\n1\n{ack['payload']}".encode(),hashlib.sha256).hexdigest())
assert json.loads(base64.b64decode(ack['payload']))['stored'] is False
assert sql('SELECT key_digest FROM hardware_credentials WHERE auth_uid=%s',(auth,)).tobytes()==key
check('authenticated device gets signed non-storage ACK; SIM and hardware credentials preserved')

dry=process(worker,r['id'])
assert dry['personal_scope_eligible'] and file.exists()
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(uid,)) == 3
# Simulate a worker error after DELETE: its transaction must restore all rows.
real_count=closure_module.count
seen=[]
def fail_after_delete(q,t,c,u):
    seen.append(t)
    if t=='connection_alert_episodes' and seen.count(t)==2:raise RuntimeError('fixture')
    return real_count(q,t,c,u)
with patch('privacy_account_closure.count',side_effect=fail_after_delete):
    try:execute(worker,r['id'])
    except RuntimeError:pass
    else:raise AssertionError('failure missing')
assert sql("SELECT state FROM privacy_account_closures WHERE request_id=%s",(r['id'],))=='retry'
result=execute(worker,r['id'])
assert result['deleted_counts']['location_records']==3
assert not result['personal_scope_verified'] and file.exists()
assert 'private_files_pending_or_shared' in result['review_reasons']
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(uid,)) == 0
assert foreign_fingerprint == sql("SELECT md5(string_agg(to_jsonb(r)::text,',' ORDER BY device_id,recorded_at)) FROM location_records r WHERE user_id IS DISTINCT FROM %s",(uid,))
assert sql('SELECT count(*) FROM location_1min WHERE device_id=%s',(did,)) == 1
assert sql('SELECT owner_id FROM devices WHERE id=%s',(did,)) == uid
check('dry-run / failure retry / scoped erasure including detached history; foreign+NULL+legacy records unchanged')
while process_one(worker,cfg) is not None:pass
assert not file.exists()
verified=execute(worker,r['id'])
assert verified['personal_scope_verified'] and not verified['external_copies_verified'] and not verified['request_fulfilled']
counts=verified['deleted_counts']
revision_before=sql('SELECT revision FROM privacy_requests WHERE id=%s',(r['id'],))
assert execute(worker,r['id'])['deleted_counts'] == counts
assert sql('SELECT revision FROM privacy_requests WHERE id=%s',(r['id'],)) == revision_before
assert sql('SELECT status FROM privacy_requests WHERE id=%s',(r['id'],))=='in_review'
check('durable attachment cleanup / retry without double count / local verification never claims all-copy erasure')

# Employee closure must not erase the employer's records or snapshots.
staff=sql("INSERT INTO staff(user_id,name) VALUES(%s,'fixture employee') RETURNING id",(company['user_id'],))
sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(company['user_id'],staff,other['user_id']))
employer_fingerprint=sql("SELECT md5(to_jsonb(s)::text) FROM staff s WHERE id=%s",(staff,))
employee_request=intake(other);assert start(employee_request,admin['access_token'])[0]==200
employee=execute(worker,employee_request['id'])
assert not employee['personal_scope_eligible'] and 'company_membership_subject_review' in employee['review_reasons']
assert sql('SELECT count(*) FROM fleet_staff_accounts WHERE account_id=%s',(other['user_id'],))==0
assert employer_fingerprint==sql('SELECT md5(to_jsonb(s)::text) FROM staff s WHERE id=%s',(staff,))
remaining_employee=account(5)
staff2=sql("INSERT INTO staff(user_id,name) VALUES(%s,'remaining employee') RETURNING id",(company['user_id'],))
sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(company['user_id'],staff2,remaining_employee['user_id']))
company_device=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'fixture') RETURNING id",(tag+'company',company['user_id']))
contract=sql("INSERT INTO rental_contracts(user_id,device_id,renter_name,starts_at,ends_at) VALUES(%s,%s,'fixture',now()+interval '20 days',now()+interval '21 days') RETURNING id",(company['user_id'],company_device))
handoff=sql("INSERT INTO rental_handoff_tokens(contract_id,user_id,purpose,token,expires_at) VALUES(%s,%s,'pickup',%s,now()+interval '1 day') RETURNING id",(contract,company['user_id'],tag+'handoff'))
photo=sql("INSERT INTO rental_photos(contract_id,user_id,kind,bytes,uploaded_by_token) VALUES(%s,%s,'pickup_odometer',%s,%s) RETURNING id",(contract,company['user_id'],b'synthetic photo',handoff))
photo_fingerprint=sql('SELECT md5(to_jsonb(p)::text) FROM rental_photos p WHERE id=%s',(photo,))
company_request=intake(company);status,closed_company=start(company_request,admin['access_token']);assert status==200,(status,closed_company)
retained=execute(worker,company_request['id'])
assert not retained['personal_scope_eligible'] and retained['retained_review_counts']['staff']==2
assert call('GET','/corporate/vehicles',bearer=remaining_employee['access_token'],headers={'X-Fleet-Owner':str(company['user_id'])})[0]==401
assert call('GET','/auth/me',bearer=remaining_employee['access_token'])[0]==200
check('employee access unlink preserves company data; company-owned scope stops automatic deletion')
assert sql('SELECT revoked_at IS NOT NULL FROM rental_handoff_tokens WHERE id=%s',(handoff,))
assert photo_fingerprint==sql('SELECT md5(to_jsonb(p)::text) FROM rental_photos p WHERE id=%s',(photo,))
check('closing company denies delegated access; handoff revocation preserves contract photo and FK provenance')

# Seed a durable backlog while workers are stopped, then start real workers.
# The closed account sorts before the active account to expose batch starvation.
closed_batch,active_batch=account(6),account(7)
batch_request=intake(closed_batch)
subprocess.check_call(['docker','stop',API],stdout=subprocess.DEVNULL)
batch=[]
for n,a in enumerate((closed_batch,active_batch)):
    d=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,last_seen_at) VALUES(%s,%s,'fixture',now()-interval '25 hours') RETURNING id",(tag+'batch'+str(n),a['user_id']))
    e=sql("INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,'fixture_batch',now()) RETURNING id",(d,a['user_id']))
    reservation=sql("INSERT INTO vehicle_reservations(user_id,device_id,starts_at,ends_at,status) VALUES(%s,%s,now()-interval '2 hours',now()-interval '1 hour','planned') RETURNING id",(a['user_id'],d))
    rental=sql("INSERT INTO rental_contracts(user_id,device_id,renter_name,starts_at,ends_at) VALUES(%s,%s,'fixture',now()-interval '2 hours',now()-interval '1 hour') RETURNING id",(a['user_id'],d))
    batch.append((d,e,reservation,rental))
sql('SELECT privacy_start_account_closure(%s,%s,%s)',(batch_request['id'],batch_request['revision'],admin['user_id']))
subprocess.check_call(['docker','start',API],stdout=subprocess.DEVNULL)
for attempt in range(40):
    if (sql('SELECT notified_at IS NOT NULL FROM events WHERE id=%s',(batch[1][1],))
            and sql('SELECT status FROM vehicle_reservations WHERE id=%s',(batch[1][2],))=='completed'
            and sql('SELECT count(*) FROM connection_alert_episodes WHERE device_id=%s',(batch[1][0],))):break
    time.sleep(1)
else:raise AssertionError('active account batch stalled behind closed account')
assert sql('SELECT notified_at IS NULL FROM events WHERE id=%s',(batch[0][1],))
assert sql('SELECT status FROM vehicle_reservations WHERE id=%s',(batch[0][2],))=='planned'
assert sql('SELECT status FROM rental_contracts WHERE id=%s',(batch[0][3],))=='draft'
assert sql('SELECT status FROM rental_contracts WHERE id=%s',(batch[1][3],))=='overdue'
assert sql('SELECT count(*) FROM connection_alert_episodes WHERE device_id=%s',(batch[0][0],))==0
check('real background workers skip closed account; active notification/reservation/rental batches continue')

# The timer runs the script (`--pending --execute`), an entry point the calls above never take.
# Five closures held only by undeleted files are older than a new request: it must still start.
def held_closure(n):
    a=account(n)
    d=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'fixture') RETURNING id",(f'{tag}held{n}',a['user_id']))
    f=root/'device_documents'/str(a['user_id'])/str(d)/(str(uuid.uuid4())+'_held.pdf')
    f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(b'%PDF-1.7 fake')
    sql("INSERT INTO device_documents(user_id,device_id,kind,filename,stored_path,mime,size_bytes) VALUES(%s,%s,'other','held.pdf',%s,'application/pdf',13)",(a['user_id'],d,str(f)))
    q=intake(a);assert start(q,admin['access_token'])[0]==200
    assert 'private_files_pending_or_shared' in execute(worker,q['id'])['review_reasons']
    return q['id'],f
closure=lambda rid:sql('SELECT to_jsonb(c) FROM privacy_account_closures c WHERE request_id=%s',(rid,))
held=[held_closure(n) for n in range(8,13)]
held_before={rid:closure(rid) for rid,_ in held}
timer_request=intake(account(13));assert start(timer_request,admin['access_token'])[0]==200
assert closure(timer_request['id'])['state']=='restricted'
timer_env=pathlib.Path(tempfile.mkdtemp())/'timer.env'
timer_env.write_text('DATABASE_URL='+dsn+'\n')
def timer(*flags):
    run=subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name('privacy_account_closure.py')),'--env-file',str(timer_env),'--pending',*flags],capture_output=True,text=True,timeout=300)
    assert run.returncode==0,(run.returncode,run.stderr[-600:])
    rows=json.loads(run.stdout)
    assert not [x for x in rows if 'error' in x],rows
    return rows
snapshot=lambda:sql("SELECT md5(coalesce(string_agg(to_jsonb(c)::text,',' ORDER BY request_id),'')) FROM privacy_account_closures c")
before=snapshot();listed=timer()
assert listed and not any(x['execute'] for x in listed) and snapshot()==before
check('timer entry point dry run (--pending) lists pending closures and writes nothing')
for attempt in range(10):
    timer('--execute')
    if closure(timer_request['id'])['state']!='restricted':break
else:raise AssertionError('new closure starved behind file-held closures')
assert closure(timer_request['id'])['state']=='review_required'
# A recheck that changes nothing writes nothing, and the held files are untouched.
assert all(closure(rid)==held_before[rid] and f.exists() for rid,f in held)
check('timer entry point (--pending --execute) runs; file-held closures do not starve a new request')
while process_one(worker,cfg) is not None:pass
assert not any(f.exists() for _,f in held)
for attempt in range(20):
    timer('--execute')
    if all(closure(rid)['personal_scope_verified'] for rid,_ in held):break
else:raise AssertionError('file-held closures were not rechecked')
assert not any('private_files_pending_or_shared' in closure(rid)['review_reasons'] for rid,_ in held)
timer_env.unlink();timer_env.parent.rmdir()
check('timer rechecks file-held closures once their files are gone')

print(json.dumps({'integration_groups':len(passed),'groups':passed,'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'real_accounts_modified':False,'external_messages_sent':False},ensure_ascii=False))
