"""Synthetic shield v1 contract checks. Refuses production; cleans only test objects."""
import base64
import hashlib
import hmac
import os
import socket
import ssl
import struct
import copy
import json
import pathlib
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
url = env['DATABASE_URL'].strip().strip('"').strip("'")
assert urllib.parse.urlparse(url).path.startswith('/gps_tracker_dev')
db = psycopg2.connect(url)
db.autocommit = True
c = db.cursor()
run = uuid.uuid4().hex
uid = 'uno-shield-' + run
legacy_uid = 'esp-kc-shield-regression-' + run
users = []

def sql(query, args=()):
    c.execute(query, args)
    return c.fetchall() if c.description else []

def send(body, expected=200, path='/gps-tracker/ingest/shield'):
    if base.startswith('https://') and path == '/gps-tracker/ingest/shield':
        path = '/ingest/shield'
    req = urllib.request.Request(base + path, json.dumps(body).encode(), {'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r: status, data = r.status, r.read()
    except urllib.error.HTTPError as e: status, data = e.code, e.read()
    assert status == expected, (status, expected, data[:150])
    return json.loads(data) if status == 200 else None

def stream(device, user):
    return sql("SELECT extract(epoch FROM recorded_at)::bigint,source,lat,lng,speed_kmh,speed_reason FROM location_speed_points_between(%s,%s,now()-interval '20 minutes',now()+interval '1 minute') ORDER BY recorded_at", (device, user))

def verify_websocket(live, user, payload):
    encode=lambda v:base64.urlsafe_b64encode(json.dumps(v,separators=(',',':')).encode()).rstrip(b'=')
    msg=encode({'alg':'HS256','typ':'JWT'})+b'.'+encode({'sub':str(user),'iat':int(time.time()),'exp':int(time.time())+60,'typ':'access'})
    secret=env['JWT_SECRET'].strip().strip('"').strip("'")
    token=(msg+b'.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),msg,hashlib.sha256).digest()).rstrip(b'=')).decode()
    def request(path):
        req=urllib.request.Request(base+path,headers={'Authorization':'Bearer '+token})
        with urllib.request.urlopen(req,timeout=10) as r:return json.load(r)
    # Small RFC 6455 test client: no extra packages on the resource-limited VPS.
    # https://www.rfc-editor.org/rfc/rfc6455#section-5.2
    target = urllib.parse.urlparse(base)
    sock = socket.create_connection((target.hostname,target.port or 443),timeout=8)
    if target.scheme=='https':
        sock = ssl.create_default_context().wrap_socket(sock,server_hostname=target.hostname)
    stream = sock.makefile('rb')
    def send(payload, opcode=1):
        mask=os.urandom(4)
        assert len(payload)<126
        sock.sendall(bytes([0x80|opcode,0x80|len(payload)])+mask+bytes(v^mask[i%4] for i,v in enumerate(payload)))
    def receive():
        while True:
            first,second=stream.read(2)
            assert first&0x80 and not first&0x70 and not second&0x80
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
        endpoint='/gps-tracker/ws/realtime?token='+urllib.parse.quote(token)
        sock.sendall((f'GET {endpoint} HTTP/1.1\r\nHost: {target.netloc}\r\nUpgrade: websocket\r\n'
                      f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        assert b' 101 ' in stream.readline()
        headers={}
        while True:
            line=stream.readline().strip()
            if not line:break
            k,v=line.decode().split(':',1);headers[k.lower()]=v.strip()
        expected=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        assert headers['sec-websocket-accept']==expected
        send(json.dumps(dict(action='subscribe',device_ids=[live])).encode())
        ack=receive()
        if ack['type']=='hello':ack=receive()
        assert ack['type']=='ack' and ack['accepted']==[live]
        globals()['send'](payload)
        event=receive()
        while event['type']!='location':event=receive()
        assert len(event['fixes'])==2 and event['source']=='lte_gnss' and 3.9<event['speed_kmh']<4.1
        history=request('/gps-tracker/api/v1'+f'/devices/{live}/locations?limit=2')
        saved={p['recorded_at']:p for p in history}
        for f in event['fixes']:
            p=saved[f['recorded_at']]
            assert p['speed_kmh']==f['speed_kmh'] and p['reported_speed_kmh'] is None
        print('PASS shield WebSocket point array, LTE source and identical REST per-point speeds')
    finally:
        stream.close();sock.close()

try:
    for name in ('a','b'):
        users.append(sql("INSERT INTO users(email,password_hash,phone,display_name) VALUES(%s,'test-only','01000000000','Shield batch test') RETURNING id", (f'shield-{run}-{name}@example.invalid',))[0][0])
    a, b = users
    device = sql("INSERT INTO devices(device_uid,api_key_hash,owner_id) VALUES(%s,'',%s) RETURNING id", (uid,a))[0][0]
    ts = int(time.time())-150
    points = [[ts+i*10,37000000+i*100,127000000,8] for i in range(6)]
    payload = dict(shield_v=1,device_uid=uid,build_tag='shield-contract-test',ts=1000,csq=20,reg=5,diag=dict(pv_mv=4100,gnss=10),points=points)
    sql("INSERT INTO events(device_id,user_id,kind,occurred_at,data) VALUES(%s,%s,'offline',now()-interval '10 seconds','{}')",(device,a))
    result = send(payload)
    assert result['accepted']==6 and result['duplicate']==0
    actual = stream(device,a)
    assert len(actual)==6 and {x[1] for x in actual}=={'lte_gnss'}
    assert [x[0] for x in actual]==[x[0] for x in points]
    assert abs(actual[-1][2]-37.0005)<1e-9 and actual[-1][3]==127
    assert actual[0][4] is None and all(x[4] is not None and 3.9<x[4]<4.1 for x in actual[1:])
    assert not stream(device,b)
    assert sql('SELECT owner_id FROM devices WHERE id=%s',(device,))[0][0]==a
    assert sql('SELECT count(*) FROM location_records WHERE device_id=%s',(device,))[0][0]==1
    print('PASS one LTE batch row, six UTC points, common speed, owner isolation')

    assert send(payload)['duplicate']==6
    assert sql("SELECT count(*) FROM events WHERE device_id=%s AND user_id=%s AND kind='online'",(device,a))[0][0]==1
    print('PASS one communication recovery event across retries')
    overlap=copy.deepcopy(payload)
    overlap['points']=points[-2:]+[[ts+60,37000600,127000000,8]]
    assert send(overlap)['accepted']==1
    assert send(overlap)['duplicate']==3
    assert len(stream(device,a))==7
    # Out-of-order backfill inserts history without moving the device's latest location.
    backfill=copy.deepcopy(payload);backfill['points']=[[ts-20,37000000,127000000,8]]
    assert send(backfill)['accepted']==1
    assert sql('SELECT extract(epoch FROM last_fix_at)::bigint FROM devices WHERE id=%s',(device,))[0][0]==ts+60
    print('PASS exact retry, partial overlap retry, late backfill and latest-marker guard')

    bads=[]
    for key,value in [('shield_v',2),('device_uid',legacy_uid),('lte',{'fix':True}),('fixes',[])]:
        bad=copy.deepcopy(payload);bad[key]=value;bads.append(bad)
    for value in [points*2,points[::-1],[[int(time.time())+60,0,0,8]],[[ts,91000000,0,8]],[[ts,0,0,3]],[[ts,0,0]],[[ts,0.5,0,8]]]:
        bad=copy.deepcopy(payload);bad['points']=value;bads.append(bad)
    before=sql('SELECT count(*) FROM location_records WHERE device_id=%s',(device,))[0][0]
    for bad in bads: send(bad,400)
    assert sql('SELECT count(*) FROM location_records WHERE device_id=%s',(device,))[0][0]==before
    print('PASS invalid/mixed legacy payloads rejected atomically')

    empty=copy.deepcopy(payload);empty['points']=[];empty['diag']['gnss']=2
    assert send(empty)['accepted']==0
    assert sql('SELECT fix FROM location_records WHERE device_id=%s ORDER BY recorded_at DESC LIMIT 1',(device,))[0][0] is False
    assert sql('SELECT extract(epoch FROM last_fix_at)::bigint FROM devices WHERE id=%s',(device,))[0][0]==ts+60
    # Pairing changes only future records, never migrates previous-owner history.
    sql('UPDATE devices SET owner_id=%s WHERE id=%s',(b,device))
    switched=copy.deepcopy(payload);switched['points']=[[ts+70,37000700,127000000,8]]
    assert send(switched)['accepted']==1
    assert len(stream(device,b))==1
    print('PASS no-fix heartbeat and ownership retention')
    live=copy.deepcopy(payload);live['points']=[[ts+80,37000800,127000000,8],[ts+90,37000900,127000000,8]]
    verify_websocket(device,b,live)

    old = {'device_uid':legacy_uid,'ts':100,'l80':{'fix':True,'lat':37,'lng':127,'sat':8},
           'fixes':[{'lat':37,'lng':127,'sat':8,'age_ms':10000,'up_ms':90000},
                    {'lat':37.0001,'lng':127,'sat':8,'age_ms':0,'up_ms':100000}]}
    response=send(old,path='/gps-tracker/ingest')
    assert 'cmd' not in response and 'post_interval_s' not in response
    rows=sql("SELECT source,jsonb_array_length(fixes_jsonb) FROM location_records WHERE device_id=(SELECT id FROM devices WHERE device_uid=%s)",(legacy_uid,))
    assert rows==[('l80',2)]
    print('PASS unchanged legacy L80 batch parser and response')
finally:
    sql('DELETE FROM devices WHERE device_uid IN (%s,%s)',(uid,legacy_uid))
    for user in users: sql('DELETE FROM users WHERE id=%s',(user,))
    db.close()
