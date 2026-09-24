"""Dev-only coordinate-speed contract tests. --migration validates in a rollback transaction."""
import base64
import datetime as dt
import hashlib
import hmac
import json
import math
import pathlib
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
finally:
    if migration:
        db.rollback()
    else:
        for did in devices:sql('DELETE FROM devices WHERE id=%s',(did,))
        if uid:sql('DELETE FROM users WHERE id=%s',(uid,))
    db.close()
