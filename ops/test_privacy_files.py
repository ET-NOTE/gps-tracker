"""Synthetic-only integration regression on the isolated round-4 Docker network."""
import base64
import concurrent.futures
import hashlib
import hmac
import json
import os
import pathlib
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from unittest.mock import patch

import psycopg2
from privacy_file_cleanup import process_one, unlink_local
from privacy_scope_inventory import account_scope, copies_inventory

NETWORK = 'gps-privacy-files-test-20261105'
DB = 'gps-privacy-files-db-20261105'
API = 'gps-privacy-files-api-20261105'
inspect = lambda kind, name: json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]
assert inspect('network', NETWORK)['Internal']
di, ai = inspect('container', DB), inspect('container', API)
assert di['Config']['Image'] == 'timescale/timescaledb:2.19.3-pg14'
assert 'APP_ENV=test' in ai['Config']['Env']
assert 'DATABASE_URL=postgres://postgres:files-test-only@files-db:5432/gps_files_test' in ai['Config']['Env']
dsn = f"postgres://postgres:files-test-only@{di['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_files_test"
base = f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043/gps-tracker/api/v1"
cfg = dict(v.split('=', 1) for v in ai['Config']['Env'] if '=' in v)
root = pathlib.Path(cfg['UPLOAD_DIR'])
private = pathlib.Path(cfg['PRIVATE_UPLOAD_DIR'])
assert root.parent.name == 'test-storage' and private.parent == root.parent
root.mkdir(parents=True, exist_ok=True); private.mkdir(parents=True, exist_ok=True)
db = psycopg2.connect(dsn); db.autocommit = True
worker = psycopg2.connect(dsn)
passed = []


def sql(query, args=(), connection=db):
    with connection.cursor() as q:
        q.execute(query, args)
        return q.fetchone()[0] if q.description else None


def check(name):
    passed.append(name)
    print('PASS '+name, flush=True)


tag = uuid.uuid4().hex
users = [sql("INSERT INTO users(email,password_hash,phone) VALUES(%s,'fixture','01000000000') RETURNING id", (f'{tag}-{n}@example.invalid',)) for n in range(2)]
owner, other = users
devices = [sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'fixture') RETURNING id", (f'{tag}-{n}', u)) for n, u in enumerate(users)]
did, detached = devices


def token(uid):
    enc = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=')
    msg = enc(b'{"alg":"HS256"}') + b'.' + enc(json.dumps({'sub': str(uid), 'exp': int(time.time())+300, 'iat': int(time.time()), 'typ': 'access'}).encode())
    return (msg+b'.'+enc(hmac.new(b'files-test-only-jwt-key-32-characters', msg, hashlib.sha256).digest())).decode()


def request(uid, method, path, data=None, content_type=None):
    headers = {'Authorization': 'Bearer '+token(uid)}
    if content_type:
        headers['Content-Type'] = content_type
    req = urllib.request.Request(base+path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def document(name='fixture.pdf', path=None):
    p = path or root/'device_documents'/str(owner)/str(did)/(str(uuid.uuid4())+'_'+name)
    if path is None:
        p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b'%PDF-1.7 fixture')
    row = sql("INSERT INTO device_documents(user_id,device_id,kind,filename,stored_path,mime,size_bytes) VALUES(%s,%s,'other','fixture.pdf',%s,'application/pdf',16) RETURNING id", (owner, did, str(p)))
    return row, p


def drain():
    results = []
    for _ in range(100):
        r = process_one(worker, cfg)
        if r is None:
            return results
        results.append(r)
    raise AssertionError('Unbounded queue')


# Real upload endpoint -> foreign delete denied -> preview no-store -> durable delete.
boundary = 'privacy-files-boundary'
body = (f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nother\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7 fixture\r\n--{boundary}--\r\n').encode()
status, _, data = request(owner, 'POST', f'/devices/{did}/documents', body, f'multipart/form-data; boundary={boundary}')
assert status == 200, (status, data)
doc = json.loads(data)['id']; path = pathlib.Path(sql('SELECT stored_path FROM device_documents WHERE id=%s', (doc,)))
assert path.exists()
assert request(other, 'DELETE', f'/documents/{doc}')[0] == 404
status, headers, _ = request(owner, 'GET', f'/documents/{doc}/preview')
assert status == 200 and headers.get('cache-control') == 'private, no-store', headers
status, _, data = request(owner, 'DELETE', f'/documents/{doc}')
assert status == 200 and json.loads(data)['file_cleanup'] == 'queued' and path.exists()
assert request(owner, 'GET', f'/documents/{doc}/download')[0] == 404
assert drain()[0]['state'] == 'local_absent' and not path.exists()
check('authenticated upload / cross-account denial / access revoke / durable file deletion')

# Rollback must preserve both reference and file; cascades must enqueue.
doc, path = document()
tx = psycopg2.connect(dsn)
sql('DELETE FROM device_documents WHERE id=%s', (doc,), tx); tx.rollback()
assert sql('SELECT count(*) FROM privacy_file_cleanup WHERE storage_key=%s', (str(path),)) == 0 and path.exists()
sql('DELETE FROM device_documents WHERE id=%s', (doc,)); drain()
assert not path.exists()
cascade_device = sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id", (tag+'-cascade', owner))
doc, path = document(); sql('UPDATE device_documents SET device_id=%s WHERE id=%s', (cascade_device, doc))
sql('DELETE FROM devices WHERE id=%s', (cascade_device,)); drain()
assert not path.exists()
check('transaction rollback and FK cascade keep cleanup obligations correct')

# Shared dev image copied to independent fleet asset survives one reference removal.
image_name = f'dev_{did}_{uuid.uuid4()}.jpg'
image_path = private/'car-images'/image_name; image_path.parent.mkdir(exist_ok=True); image_path.write_bytes(b'fixture')
url = '/uploads/car-images/'+image_name
sql('UPDATE devices SET car_image_url=%s WHERE id=%s', (url, did))
vehicle = sql("INSERT INTO fleet_vehicles(owner_id,name,profile) VALUES(%s,'fixture',jsonb_build_object('car_image_url',%s)) RETURNING id", (other, url))
sql('UPDATE devices SET car_image_url=NULL WHERE id=%s', (did,))
assert drain()[0]['state'] == 'shared' and image_path.exists()
sql("UPDATE fleet_vehicles SET profile=profile-'car_image_url' WHERE id=%s", (vehicle,))
assert drain()[0]['state'] == 'local_absent' and not image_path.exists()
assert sql('SELECT count(DISTINCT s.owner_id) FROM privacy_file_cleanup_sources s JOIN privacy_file_cleanup j ON j.id=s.job_id WHERE j.storage_key=%s', (url,)) == 2
check('shared image preserved until every device/fleet reference is removed')

# A failed filesystem call is not a successful deletion; retry is idempotent.
doc, path = document(); sql('DELETE FROM device_documents WHERE id=%s', (doc,))
with patch('privacy_file_cleanup.os.unlink', side_effect=PermissionError(13, 'fixture')):
    result = process_one(worker, cfg)
assert result['state'] == 'retry' and path.exists()
sql("UPDATE privacy_file_cleanup SET next_attempt_at=now() WHERE id=%s", (result['job_id'],))
assert drain()[0]['state'] == 'local_absent' and not path.exists()
assert drain() == []
check('filesystem failure retained, retried and verified without silent success')

# Simulate crash/DB failure after successful unlink; the next attempt verifies absence.
doc, path = document(); sql('DELETE FROM device_documents WHERE id=%s', (doc,))
assert unlink_local('document', str(path), cfg)[0] == 'local_absent'
result = drain()[0]
assert result['state'] == 'local_absent' and result['reason'] == 'already_absent'
check('crash between unlink and DB commit recovered by repeatable absence check')

# Reference writes block cleanup; worker cannot delete while a new owner references it.
doc, path = document(); sql('DELETE FROM device_documents WHERE id=%s', (doc,))
sql("INSERT INTO device_documents(user_id,device_id,kind,filename,stored_path,mime,size_bytes) VALUES(%s,%s,'other','shared',%s,'application/pdf',16)", (other, detached, str(path)), tx)
with concurrent.futures.ThreadPoolExecutor() as pool:
    future = pool.submit(process_one, worker, cfg)
    time.sleep(.2); assert not future.done()
    tx.commit(); result = future.result(5)
assert result['state'] == 'shared' and path.exists()
check('concurrent reference creation is serialized before unlink')

# Path escape, symlink leaf/parents/root, hardlinks and missing mount root fail closed.
with tempfile.TemporaryDirectory(prefix='gps-files-fixture-') as temp:
    outside = pathlib.Path(temp)/'keep'; outside.write_bytes(b'keep')
    doc, p = document(); p.unlink(); p.symlink_to(outside)
    assert unlink_local('document', str(p), cfg)[0] == 'blocked' and outside.exists()
    symlink_parent = root/'device_documents'/'999999'; symlink_parent.symlink_to(pathlib.Path(temp), target_is_directory=True)
    assert unlink_local('document', str(symlink_parent/'1'/'file'), cfg)[0] == 'blocked'
    assert unlink_local('document', str(root/'device_documents'/'1'/'1'/'..'/'keep'), cfg)[0] == 'blocked'
    assert unlink_local('document', str(outside), cfg)[0] == 'blocked'
    hard = root/'device_documents'/'1'/'1'/'hard'; hard.parent.mkdir(parents=True, exist_ok=True); os.link(outside, hard)
    assert unlink_local('document', str(hard), cfg)[0] == 'blocked'
    assert unlink_local('car_image', 'https://external.invalid/photo', cfg)[0] == 'blocked'
    missing = dict(cfg, UPLOAD_DIR=str(pathlib.Path(temp)/'missing'))
    assert unlink_local('document', missing['UPLOAD_DIR']+'/device_documents/1/1/file', missing) == ('retry', 'storage_root_unavailable')
    root_link = pathlib.Path(temp)/'rootlink'; root_link.symlink_to(root, target_is_directory=True)
    assert unlink_local('document', str(root_link/'device_documents'/'1'/'1'/'file'), dict(cfg, UPLOAD_DIR=str(root_link)))[0] == 'blocked'
check('traversal, external URL, symlink, hardlink and unavailable-root guards')

# Collection-time account follows SIM history, not the latest device owner.
for i, (d, u) in enumerate(((did, owner), (did, other), (did, None), (detached, owner))):
    sql("INSERT INTO location_records(device_id,recorded_at,source,fix,user_id) VALUES(%s,now()+%s*interval '1 second','l80',false,%s)", (d, i, u))
staff = sql("INSERT INTO staff(user_id,name) VALUES(%s,'fixture employee') RETURNING id", (other,))
sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)', (other, staff, owner))
invdb = psycopg2.connect(dsn)
try:
    report = account_scope(invdb, owner)
finally:
    invdb.close()
assert report['telemetry']['location_records'] == {'collected_for_account': 2, 'detached_or_transferred_history': 1, 'other_accounts_on_current_sims_excluded': 1, 'unattributed_on_current_sims_needs_review': 1}, report
assert report['company_membership_only']['companies'] == 1 and not report['company_membership_only']['company_data_auto_delete']
assert report['owned_or_linked_record_counts']['fleet_vehicles'] == 0 and not report['deletion_ready']
assert sql('SELECT count(*) FROM location_records') == 4
check('read-only account scope keeps detached, foreign, NULL and company data distinct')
copies = copies_inventory([str(root), str(root/'not-present')])
assert not copies['external_copies_verified'] and copies['roots'][1]['status'] == 'unavailable'
check('backup inventory cannot imply verified destruction or full coverage')
print(json.dumps({'passed': passed, 'count': len(passed), 'production_data_used': False}))
