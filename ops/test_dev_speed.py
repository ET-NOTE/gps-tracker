"""Dev-only coordinate-speed contract tests. --migration validates in a rollback transaction."""
import base64
import datetime as dt
import hashlib
import hmac
import json
import math
import os
import pathlib
import socket
import ssl
import struct
import sys
import time
import urllib.parse
import urllib.request
import uuid
import psycopg2

env = dict(line.split('=', 1) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()
           if '=' in line and not line.startswith('#'))
url = env['DATABASE_URL'].strip().strip('"').strip("'")
assert urllib.parse.urlparse(url).path.startswith('/gps_tracker_dev')
base = sys.argv[2].rstrip('/')
assert base in ('http://127.0.0.1:3042', 'https://dev-gps.serial.kr')
migration = sys.argv[sys.argv.index('--migration') + 1] if '--migration' in sys.argv else None
db = psycopg2.connect(url)
db.autocommit = not bool(migration)
cur = db.cursor()
devices = []
uid = None

def sql(query, args=()):
    cur.execute(query, args)
    return cur.fetchall() if cur.description else []

def fixture(label, samples, raw_speed=123, start='2026-09-23T12:00:00Z', batch=False):
    did = sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",
              ('dev-sim-speed-' + run + '-' + label, uid))[0][0]
    devices.append(did)
    origin = dt.datetime.fromisoformat(start.replace('Z', '+00:00'))
    if batch:
        anchor = max(s[0] for s in samples)
        fixes = [dict(at_ms=round((s-anchor)*1000),lat=m/6371000*180/math.pi,lng=0,
                      sat=12,speed_kmh=raw_speed) for s,m in samples]
        sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,raw,fixes_jsonb) VALUES(%s,%s,%s,'l80',true,0,0,'{}',%s)",
            (did,uid,origin+dt.timedelta(seconds=anchor),json.dumps(fixes)))
    else:
        for s,m in samples:
            sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat,speed_kmh,raw) VALUES(%s,%s,%s,'l80',true,%s,0,12,%s,'{}')",
                (did,uid,origin+dt.timedelta(seconds=s),m/6371000*180/math.pi,raw_speed))
    return did, origin

def speeds(did, start=None, end=None):
    return sql("SELECT recorded_at,speed_kmh,speed_reason,reported_speed_kmh FROM location_speed_points_between(%s,%s,%s,%s) ORDER BY recorded_at",(did,uid,start,end))

def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base+path,data=data,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=20) as response:
        return json.load(response)

def verify_websocket():
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
        live,_=fixture('websocket',[])
        name=sql('SELECT device_uid FROM devices WHERE id=%s',(live,))[0][0]
        send(json.dumps(dict(action='subscribe',device_ids=[live])).encode())
        ack=receive();assert ack['type']=='ack' and ack['accepted']==[live]
        fixes=[dict(lat=s*5/6371000*180/math.pi,lng=0,sat=12,age_ms=(8-s)*1000,up_ms=s*1000) for s in [0,2,4,6]]
        request('/gps-tracker/ingest',dict(device_uid=name,boot=1,fixes=fixes))
        event=receive()
        while event['type']!='location':event=receive()
        assert len(event['fixes'])==4 and event['speed_kmh']==18
        history=request('/gps-tracker/api/v1'+f'/devices/{live}/locations?limit=2')
        saved={p['recorded_at']:p for p in history}
        for f in event['fixes']:
            p=saved[f['recorded_at']]
            assert p['speed_kmh']==f['speed_kmh'] and p['reported_speed_kmh'] is None
        print('PASS actual WebSocket subscribe, speedless HTTP batch, DB timestamp precision and REST equality')
    finally:
        stream.close();sock.close()

try:
    if migration:
        cur.execute(pathlib.Path(migration).read_text())
    cur.execute("SET statement_timeout='8s'")
    run = uuid.uuid4().hex[:10]
    uid = sql("INSERT INTO users(email,password_hash,phone,display_name,role) VALUES(%s,'no-login','01000000000','Speed regression','admin') RETURNING id",
              ('speed-'+run+'@example.invalid',))[0][0]
    samples = [(s,s*5) for s in range(0,21,2)]
    did, origin = fixture('constant',samples)
    rows = speeds(did)
    assert rows[0][1] is None and rows[1][1] is None
    assert all(abs(row[1]-18)<.01 and row[3]==123 for row in rows[2:]), rows
    batch,_ = fixture('batch',samples,batch=True)
    missing,_ = fixture('no-receiver-speed',samples,raw_speed=None,batch=True)
    assert [r[1:3] for r in rows] == [r[1:3] for r in speeds(batch)] == [r[1:3] for r in speeds(missing)]
    for row in rows:
        assert speeds(did,row[0],row[0]) == [row], 'range boundary changed speed'
    assert sql('SELECT count(*) FROM location_speed_points_between(%s,%s,NULL,NULL)',(did,uid+999999))[0][0]==0
    print('PASS known 18 km/h, missing/conflicting receiver speed, batch/window/owner independence')

    jitter,_ = fixture('jitter',[(s,(-1)**s) for s in range(30)])
    assert all(r[1]==0 for r in speeds(jitter)[3:])
    walking,_ = fixture('walking',[(s,s*2) for s in range(15)])
    assert all(abs(r[1]-7.2)<.01 for r in speeds(walking)[3:])
    spike,_ = fixture('spike',[(0,0),(5,25),(10,10000),(15,75),(20,100),(25,125)])
    sp = speeds(spike)
    assert sp[2][1] is None and sp[3][1] is None and sp[-1][1]==18, sp
    gap,_ = fixture('gap',[(0,0),(5,25),(100,500),(105,525),(110,550)])
    assert speeds(gap)[2][1] is None and speeds(gap)[-1][1]==18
    reboot,_ = fixture('reboot',samples)
    sql("UPDATE location_records SET raw=jsonb_build_object('boot',CASE WHEN recorded_at<%s THEN 1 ELSE 2 END) WHERE device_id=%s",(origin+dt.timedelta(seconds=10),reboot))
    assert speeds(reboot)[5][1] is None and speeds(reboot)[-1][1]==18
    sql('UPDATE location_records SET sat=2 WHERE device_id=%s',(walking,))
    assert all(r[1] is None for r in speeds(walking))
    for dev in [spike,gap,reboot]:
        for row in speeds(dev):
            assert speeds(dev,row[0],row[0])==[row], (dev,row,speeds(dev,row[0],row[0]))
    # Uptime deltas remove a 1 s HTTP arrival shift at the next batch boundary.
    timed,to = fixture('uptime',[(0,0),(4,20)],batch=True)
    sql("UPDATE location_records SET raw='{\"boot\":1}', fixes_jsonb=jsonb_set(jsonb_set(fixes_jsonb,'{0,up_ms}','0'),'{1,up_ms}','4000') WHERE device_id=%s",(timed,))
    sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,raw,fixes_jsonb) VALUES(%s,%s,%s,'l80',true,0,0,'{\"boot\":1}',%s)",
        (timed,uid,to+dt.timedelta(seconds=9),json.dumps([dict(at_ms=0,lat=40/6371000*180/math.pi,lng=0,sat=12,up_ms=8000)])))
    assert speeds(timed)[-1][1]==18
    sql("UPDATE location_records SET fixes_jsonb=jsonb_set(fixes_jsonb,'{0,up_ms}','1000') WHERE device_id=%s AND recorded_at=%s",(timed,to+dt.timedelta(seconds=9)))
    assert speeds(timed)[-1][1] is None, 'uptime reset must not create a speed'
    print('PASS jitter, low speed, jump/gap/boot recovery, uptime transport correction and satellite quality')

    late,_ = fixture('late',[(0,0),(10,100)])
    assert speeds(late)[-1][1]==36
    sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat) VALUES(%s,%s,%s,'l80',true,%s,0,12)",
        (late,uid,origin+dt.timedelta(seconds=6),30/6371000*180/math.pi))
    assert speeds(late)[-1][1]==63
    sql('DELETE FROM location_records WHERE device_id=%s AND recorded_at=%s',(late,origin+dt.timedelta(seconds=6)))
    assert speeds(late)[-1][1]==36
    midnight, mo = fixture('midnight',samples,start='2026-09-23T14:59:50Z',batch=True)
    assert all(r[1]==18 for r in speeds(midnight,mo+dt.timedelta(seconds=10),None))
    print('PASS late insertion/deletion repair and KST midnight context')

    if not migration:
        encode=lambda x:base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).rstrip(b'=')
        msg=encode({'alg':'HS256','typ':'JWT'})+b'.'+encode({'sub':str(uid),'iat':int(time.time()),'exp':int(time.time())+900,'typ':'access'})
        token=(msg+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),msg,hashlib.sha256).digest()).rstrip(b'=')).decode()
        api='/gps-tracker/api/v1'
        latest=request(api+f'/devices/{did}/locations/latest')
        assert latest['speed_kmh']==18 and latest['reported_speed_kmh']==123
        history=request(api+f'/devices/{did}/locations?limit=100')
        assert [p['speed_kmh'] for p in reversed(history)]==[r[1] for r in rows]
        q=dict(since=origin.isoformat(),until=(origin+dt.timedelta(minutes=1)).isoformat(),limit=3)
        pages=[]
        while True:
            result=request(api+f'/devices/{did}/locations/page?'+urllib.parse.urlencode(q))
            pages.extend(result['items'])
            if not result['next_cursor']:break
            q['cursor']=result['next_cursor']
        assert [(p['recorded_at'],p['speed_kmh']) for p in pages]==[(p['recorded_at'],p['speed_kmh']) for p in history]
        q.update(bucket='1m')
        agg=request(api+f'/devices/{did}/locations/aggregated?'+urllib.parse.urlencode(q))
        assert agg[0]['speed_kmh']==agg[0]['speed_max_kmh']==18 and agg[0]['speed_sample_count']==9
        assert dt.datetime.fromisoformat(agg[0]['recorded_at_last'].replace('Z','+00:00'))==dt.datetime.fromisoformat(latest['recorded_at'].replace('Z','+00:00'))
        request(api+f'/admin/devices/{did}/recompute-stats',{})
        assert sql('SELECT max_speed_kmh FROM daily_stats WHERE device_id=%s',(did,))[0][0]==18
        print('PASS REST latest/history/pages, bucket speed/actual timestamp and daily maximum')
        verify_websocket()
    if '--benchmark' in sys.argv:
        bench, _ = fixture('benchmark',[])
        sql("""INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,raw,fixes_jsonb)
          SELECT %s,%s,'2026-09-22T00:00:00Z'::timestamptz+i*interval '100 seconds','l80',true,37,127,
            jsonb_build_object('boot',1,'fixes',f.points),f.points
          FROM generate_series(1,1000) i CROSS JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object('at_ms',-j*1000,'lat',37+(i*100-j)*0.00001,
              'lng',127,'sat',12,'up_ms',(i*100-j)*1000)) AS points FROM generate_series(0,99) j) f""",(bench,uid))
        metrics = {}
        def measure(label,query,args):
            plan = sql('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query,args)[0][0][0]
            metrics[label] = round(plan['Execution Time'],2)
            metrics[label+'_jit_ms'] = round(plan.get('JIT',{}).get('Timing',{}).get('Total',0),2)
        measure('100k_latest_speed_ms',"""WITH newest AS MATERIALIZED (
          SELECT location_point_bound(recorded_at,fixes_jsonb,true) AS at FROM location_records
          WHERE device_id=%s AND user_id=%s ORDER BY location_point_bound(recorded_at,fixes_jsonb,true) DESC LIMIT 1)
          SELECT p.speed_kmh FROM newest n CROSS JOIN LATERAL location_speed_points_between(%s,%s,n.at,n.at) p""",(bench,uid,bench,uid))
        window = ('2026-09-22T12:00:00Z','2026-09-22T13:00:00Z')
        measure('3600_point_hour_speed_ms','SELECT count(*),max(speed_kmh) FROM location_speed_points_between(%s,%s,%s,%s) WHERE recorded_at<%s',(bench,uid,*window,window[1]))
        if not migration:
            started = time.monotonic()
            assert request(api+f'/devices/{bench}/locations/latest')['speed_kmh'] is not None
            metrics['100k_latest_https_ms'] = round((time.monotonic()-started)*1000,2)
        print('SPEED_BENCHMARK '+json.dumps(metrics))

finally:
    if migration:
        db.rollback()
    else:
        for did in devices:sql('DELETE FROM devices WHERE id=%s',(did,))
        if uid:sql('DELETE FROM users WHERE id=%s',(uid,))
    db.close()
