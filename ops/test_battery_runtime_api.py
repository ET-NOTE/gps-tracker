"""Dev-only integration regression. Temporary synthetic accounts/devices are removed.
Run with access to the private dev env file. No real device commands or external calls.
"""
import base64
import datetime as dt
import hashlib
import hmac
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import struct
import zlib
import socket
import ssl
import os
import psycopg2

env_path, base = sys.argv[1:3]
assert base in ("http://127.0.0.1:3042", "http://127.0.0.1:3041", "https://dev-gps.serial.kr")
env = dict(line.split("=",1) for line in pathlib.Path(env_path).read_text().splitlines() if "=" in line and not line.startswith("#"))
env = {k:v.strip().strip('"').strip("'") for k,v in env.items()}
assert urllib.parse.urlparse(env['DATABASE_URL']).path.startswith('/gps_tracker_dev')
db = psycopg2.connect(env['DATABASE_URL']); db.autocommit = True
cur = db.cursor()
run = uuid.uuid4().hex
users=[]; devices=[]; files=[]; photos=[]

def query(sql,args=()):
    cur.execute(sql,args)
    return cur.fetchone()[0] if cur.description else None

def jwt(uid):
    encode=lambda value: base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).rstrip(b'=')
    msg=encode({'alg':'HS256','typ':'JWT'})+b'.'+encode({'sub':str(uid),'iat':int(time.time()),'exp':int(time.time())+1800,'typ':'access'})
    return (msg+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),msg,hashlib.sha256).digest()).rstrip(b'=')).decode()

def request(path,uid=None,method='GET',body=None,raw=None,content_type=None,expected=200):
    headers={}
    if uid: headers['Authorization']='Bearer '+jwt(uid)
    if body is not None: raw=json.dumps(body).encode(); content_type='application/json'
    if content_type: headers['Content-Type']=content_type
    req=urllib.request.Request(base+path,data=raw,method=method,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=30) as response: status=response.status; data=response.read()
    except urllib.error.HTTPError as error: status=error.code; data=error.read()
    assert status==expected, (path,status,expected,data[:120])
    return json.loads(data) if data and data[:1] in (b'{',b'[') else data

api='/gps-tracker/api/v1'
def verify_runtime_ws(uid, did, name):
    target=urllib.parse.urlparse(base)
    sock=socket.create_connection((target.hostname,target.port or 443),timeout=8)
    if target.scheme=='https': sock=ssl.create_default_context().wrap_socket(sock,server_hostname=target.hostname)
    stream=sock.makefile('rb')
    def send(payload,opcode=1):
        mask=os.urandom(4)
        assert len(payload)<126
        sock.sendall(bytes([0x80|opcode,0x80|len(payload)])+mask+bytes(v^mask[i%4] for i,v in enumerate(payload)))
    def receive():
        while True:
            first,second=stream.read(2)
            length=second&127
            if length==126:length=struct.unpack('!H',stream.read(2))[0]
            elif length==127:length=struct.unpack('!Q',stream.read(8))[0]
            assert length<100000
            data=stream.read(length)
            if first&15==9:send(data,10);continue
            assert first&15==1
            return json.loads(data)
    try:
        key=base64.b64encode(os.urandom(16)).decode()
        endpoint='/gps-tracker/ws/realtime?token='+urllib.parse.quote(jwt(uid))
        sock.sendall((f'GET {endpoint} HTTP/1.1\r\nHost: {target.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        assert b' 101 ' in stream.readline()
        while stream.readline().strip():pass
        send(json.dumps(dict(action='subscribe',device_ids=[did])).encode())
        ack=receive()
        if ack['type']=='hello':ack=receive()
        assert ack['type']=='ack' and ack['accepted']==[did]
        for voltage,expected in [(4118,'estimated'),(4772,'external_power_possible'),(None,'unavailable')]:
            body={'device_uid':name,'ts':200,'l80':{'fix':False,'sat':0}}
            if voltage is not None:body['vbat_mv']=voltage
            request('/gps-tracker/ingest',method='POST',body=body)
            event=receive()
            while event['type']!='location':event=receive()
            runtime=event['battery_runtime']
            rest=request(api+f'/devices/{did}',uid)['battery_runtime']
            assert runtime['status']==expected and rest['status']==expected
            assert runtime['measurement_at']==rest['measurement_at']
            assert runtime['estimated_empty_at']==rest['estimated_empty_at']
            assert event['vbat_mv']==voltage
        print('PASS actual no-fix WebSocket runtime, charging/missing clearing, REST timestamp agreement')
    finally:
        stream.close();sock.close()

try:
    uid=query("INSERT INTO users(email,password_hash,phone,display_name) VALUES(%s,'test-only','01000000000','Battery regression') RETURNING id",(f'battery-{run}@example.invalid',)); users.append(uid)
    name='battery-'+run
    did=query("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name,paired_at) VALUES(%s,%s,'','Battery regression',now()) RETURNING id",(name,uid)); devices.append(did)
    request(api+'/notifications/settings',uid,'PATCH',{'low_batt_alert':True,'low_batt_threshold_mv':3500})
    def ingest(raw):
        body={'device_uid':name,'ts':120,'l80':{'fix':False,'sat':0},'cbc_mv':4100}
        if raw is not None: body['vbat_mv']=raw
        request('/gps-tracker/ingest',method='POST',body=body)
    def reading():
        one=request(api+f'/devices/{did}',uid)
        rows=request(api+'/devices',uid)
        same=next(d for d in rows if d['id']==did)
        assert same['last_vbat_mv']==one['last_vbat_mv'] and same['last_battery_at']==one['last_battery_at']
        if one['battery_runtime'] is None:
            assert same['battery_runtime'] is None
        else:
            assert same['battery_runtime']['status']==one['battery_runtime']['status']
            assert same['battery_runtime']['estimated_empty_at']==one['battery_runtime']['estimated_empty_at']
        return one
    ingest(3510)
    device=reading()
    assert device['last_vbat_mv']==3510 and device['last_cbc_mv']==4100 and device['last_battery_at']
    event=query("SELECT data FROM events WHERE device_id=%s AND kind='low_batt' ORDER BY id DESC LIMIT 1",(did,))
    assert event['vbat_mv']==3510 and event['calibrated_mv']<3500 and event['battery_policy']=='gps-1s-standard-520211-20261014-charging'
    assert query('SELECT vbat_mv FROM location_records WHERE device_id=%s ORDER BY recorded_at DESC LIMIT 1',(did,))==3510
    ingest(2500)
    assert reading()['last_vbat_mv']==2500
    assert query("SELECT count(*) FROM events WHERE device_id=%s AND kind='low_batt'",(did,))==1
    for voltage in (4772,5272,5273,6000):
        ingest(voltage)
        assert reading()['last_vbat_mv']==voltage
        assert reading()['battery_runtime']['status']=='external_power_possible'
        assert reading()['battery_runtime']['remaining_seconds'] is None
        assert query('SELECT vbat_mv FROM location_records WHERE device_id=%s ORDER BY recorded_at DESC LIMIT 1',(did,))==voltage
        assert query("SELECT count(*) FROM events WHERE device_id=%s AND kind='low_batt'",(did,))==1
    ingest(None)
    missing=reading()
    assert missing['last_vbat_mv'] is None and missing['last_cbc_mv']==4100
    assert missing['last_battery_at']!=device['last_battery_at']
    assert missing['battery_runtime']['status']=='unavailable'
    ingest(4118)
    full=reading()['battery_runtime']
    assert full['status']=='estimated' and 183775<=full['remaining_seconds']<=183780
    assert full['reference_seconds']==183780
    assert abs((dt.datetime.fromisoformat(full['estimated_empty_at'].replace('Z','+00:00'))-dt.datetime.fromisoformat(full['measurement_at'].replace('Z','+00:00'))).total_seconds()-183780)<1
    ingest(3901)
    assert 137830<=reading()['battery_runtime']['remaining_seconds']<=137835
    request('/gps-tracker/ingest',method='POST',body={'device_uid':name,'ts':150,'vbat_mv':3901,'event':'sleep_enter','sleep_reason':'motion_idle','l80':{'fix':False,'sat':0}})
    assert reading()['battery_runtime']['status']=='sleeping'
    ingest(4118)
    query("UPDATE location_records SET recorded_at=recorded_at-interval '10 minutes' WHERE device_id=%s",(did,))
    assert reading()['battery_runtime']['status']=='stale'
    ingest(2500)
    assert reading()['battery_runtime']['status']=='depleted'
    assert reading()['battery_runtime']['remaining_seconds']==0
    other=query("INSERT INTO users(email,password_hash,phone,display_name) VALUES(%s,'test-only','01000000000','Other') RETURNING id",(f'battery-other-{run}@example.invalid',));users.append(other)
    request(api+f'/devices/{did}',other,expected=404)
    assert not request(api+'/devices',other)
    verify_runtime_ws(uid,did,name)
    query("UPDATE devices SET device_kind='phone' WHERE id=%s",(did,))
    assert reading()['battery_runtime'] is None
    print('PASS runtime timeline, list/detail consistency, charging/missing/sleep/stale/phone gating and owner isolation')
    print('PASS calibrated ingest threshold, raw preservation, latest no-fix/missing ADC, REST consistency and 24h debounce')
finally:
    for did in devices: query('DELETE FROM devices WHERE id=%s',(did,))
    for uid in users: query('DELETE FROM users WHERE id=%s',(uid,))
    db.close()
