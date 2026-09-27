"""Synthetic integration checks; refuses the production database and external FCM.
Run against a private validation process or dev. Cleans only objects it creates.
"""
import base64
import hashlib
import hmac
import json
import pathlib
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import psycopg2

env_path, base = sys.argv[1:3]
assert base in ('http://127.0.0.1:3042', 'http://127.0.0.1:3041', 'https://dev-gps.serial.kr')
env = dict(l.split('=', 1) for l in pathlib.Path(env_path).read_text().splitlines() if '=' in l and not l.startswith('#'))
env = {k:v.strip().strip('"').strip("'") for k,v in env.items()}
assert urllib.parse.urlparse(env['DATABASE_URL']).path.startswith('/gps_tracker_dev')
assert not env.get('FCM_SERVICE_ACCOUNT_PATH')
db = psycopg2.connect(env['DATABASE_URL']); db.autocommit = True
cur = db.cursor()
run = uuid.uuid4().hex
users, hashes = [], []
device_uid = 'esp-kc-review-' + run
token = 'synthetic-fcm-' + run
api = '/gps-tracker/api/v1'

def sql(query, args=()):
    cur.execute(query, args)
    return cur.fetchone()[0] if cur.description else None

def jwt(uid):
    enc = lambda x: base64.urlsafe_b64encode(json.dumps(x, separators=(',',':')).encode()).rstrip(b'=')
    msg = enc({'alg':'HS256','typ':'JWT'}) + b'.' + enc({'sub':str(uid),'iat':int(time.time()),'exp':int(time.time())+600,'typ':'access'})
    return (msg+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),msg,hashlib.sha256).digest()).rstrip(b'=')).decode()

def request(path, uid=None, data=None, expected=200):
    headers = {'Content-Type':'application/json'}
    if uid: headers['Authorization'] = 'Bearer '+jwt(uid)
    raw = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(base+path, data=raw, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r: status, body = r.status, r.read()
    except urllib.error.HTTPError as e: status, body = e.code, e.read()
    assert status == expected, (path, status, expected, body[:160])
    return json.loads(body) if body[:1] in (b'{', b'[') else body

def binding(generation):
    secret = secrets.token_urlsafe(32)
    hashes.append(hashlib.sha256(secret.encode()).hexdigest())
    return {'token':token,'platform':'android','app_version':'1.0.1+7',
            'installation_id':'test-installation-'+run,'generation':generation,'revocation_key':secret}

try:
    for name in ('A','B'):
        users.append(sql("INSERT INTO users(email,password_hash,phone,display_name) VALUES(%s,'test-only','01000000000','KC push regression') RETURNING id", (f'app-review-{run}-{name}@example.invalid',)))
    a, b = users
    first, second = binding(1), binding(2)
    request(api+'/auth/fcm-token',a,first)
    request(api+'/auth/fcm-token',b,second)
    request(api+'/auth/fcm-token',a,first,expected=400)
    assert sql('SELECT user_id FROM fcm_tokens WHERE token=%s',(token,)) == b
    request(api+'/auth/fcm-token/revoke-installation',data={'token':token,'revocation_key':first['revocation_key']})
    assert sql('SELECT active FROM fcm_tokens WHERE token=%s',(token,))
    print('PASS account reassignment rejects late registration and stale revocation')
    request(api+'/auth/fcm-token/revoke-installation',data={'token':token,'revocation_key':second['revocation_key']})
    request(api+'/auth/fcm-token',b,second,expected=400)
    assert not sql('SELECT active FROM fcm_tokens WHERE token=%s',(token,))
    third = binding(3)
    request(api+'/auth/fcm-token/revoke-installation',data={'token':token,'revocation_key':third['revocation_key']})
    request(api+'/auth/fcm-token',a,third,expected=400)
    print('PASS logout works without JWT and tombstone rejects a delayed first registration')
    # Legacy apps remain compatible while the new APK is distributed.
    request(api+'/auth/fcm-token',a,{'token':token,'platform':'android'})
    request(api+'/auth/fcm-token/revoke',a,{'token':token})
    request(api+'/auth/fcm-token',a,{'token':token,'platform':'invalid'},expected=400)
    print('PASS legacy token API compatibility and input validation')
    response = request('/gps-tracker/ingest',data={'device_uid':device_uid,'iccid':'89990000'+run[:12],
        'reg':1,'csq':15,'vbat_mv':4000,'ts':15,'build_tag':'KC_TEST_BUILD-review',
        'l80':{'fix':False},'diag':{'kc_test':True},'event':'wake','wake':'boot'})
    assert response.get('ok') is True and 'cmd' not in response and 'post_interval_s' not in response
    scanned = request(api+'/devices/scan',a)
    assert device_uid in json.dumps(scanned)
    paired = request(api+'/devices/pair',a,{'device_uid':device_uid,'display_name':'KC synthetic review'})
    assert paired['device_uid'] == device_uid
    assert device_uid not in json.dumps(request(api+'/devices/scan',b))
    print('PASS KC anonymous no-fix ingest, unpaired scan, and UID pairing without commands')
    request('/gps-tracker/dht',data={'device_uid':device_uid,'temp_c':24,'hum_pct':45,'up_ms':5000})
    diag = request('/gps-tracker/diagnostic/data?device_uid='+device_uid)
    assert diag['total'] == 1 and diag['items'][0]['temp_c'] == 24
    assert request('/gps-tracker/diagnostic').startswith(b'<!DOCTYPE') or b'<html' in request('/gps-tracker/diagnostic')
    assert b'<html' in request('/gps-tracker/diagnostic/device')
    device_log = request('/gps-tracker/diagnostic/device/data?uid='+device_uid)
    assert device_uid in json.dumps(device_log)
    print('PASS public diagnostic pages and anonymous DHT telemetry')
finally:
    sql('DELETE FROM diag_dht WHERE device_uid=%s',(device_uid,))
    sql('DELETE FROM devices WHERE device_uid=%s',(device_uid,))
    for uid in users: sql('DELETE FROM users WHERE id=%s',(uid,))
    for digest in hashes: sql('DELETE FROM fcm_revocations WHERE secret_hash=%s',(digest,))
    db.close()
