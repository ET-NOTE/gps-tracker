"""Dev-only HTTP/DB equivalence tests. Only this run's synthetic devices are removed."""
import base64
import concurrent.futures
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
import psycopg2

env_path, base = sys.argv[1:3]
assert base in ('http://127.0.0.1:3042', 'https://dev-gps.serial.kr')
env = dict(l.split('=', 1) for l in pathlib.Path(env_path).read_text().splitlines() if '=' in l and not l.startswith('#'))
env = {k:v.strip().strip('"').strip("'") for k,v in env.items()}
assert urllib.parse.urlparse(env['DATABASE_URL']).path.startswith('/gps_tracker_dev')
db = psycopg2.connect(env['DATABASE_URL']); db.autocommit = True
cur = db.cursor(); cur.execute("SET statement_timeout='8s'"); cur.execute("SET work_mem='4MB'")
def sql(query, args=()):
    cur.execute(query,args)
    return cur.fetchone()[0] if cur.description else None
uid = None; devices = []; timings = {}
run = uuid.uuid4().hex
api = '/gps-tracker/api/v1'
def request(path, body=None, expected=200):
    headers = {'Content-Type':'application/json','Authorization':'Bearer '+token}
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base+path, data=data, headers=headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req,timeout=30) as response: status=response.status; raw=response.read()
    except urllib.error.HTTPError as error: status=error.code; raw=error.read()
    assert status == expected, (path,status,raw[:180])
    return json.loads(raw), round((time.monotonic()-started)*1000,1)
def device(label):
    name='dev-sim-regression-'+run+'-'+label
    did=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name) VALUES(%s,%s,'','Dev fault regression') RETURNING id",(name,uid))
    devices.append(did)
    return did,name
def count(did): return sql('SELECT count(*) FROM location_points WHERE device_id=%s AND user_id=%s',(did,uid))
def post(name, seconds, origin, boot=1, with_uptime=True):
    now=time.time()
    fixes=[dict(lat=round(37+s*.00001,7),lng=127,sat=12,age_ms=round((now-origin-s)*1000),speed_kmh=4) for s in seconds]
    if with_uptime:
        for f,s in zip(fixes,seconds): f['up_ms']=s*1000
    body=dict(device_uid=name,boot=boot,ts=max(0,int(now-origin)),fixes=fixes,
              l80=dict(fix=True,lat=fixes[-1]['lat'],lng=127,sat=12))
    return request('/gps-tracker/ingest',body)
def paged(did,since,until,limit=2000):
    rows=[]; cursor=None; pages=0; first_cursor=None
    while True:
        q=dict(since=since,until=until,limit=limit,fix_only='true')
        if cursor:q['cursor']=cursor
        result,_=request(api+f'/devices/{did}/locations/page?'+urllib.parse.urlencode(q))
        rows.extend(result['items']); pages+=1
        assert result['has_more']==bool(result['next_cursor'])
        cursor=result['next_cursor']; first_cursor=first_cursor or cursor
        if not cursor:break
        assert pages<100
    keys=[(p['recorded_at'],p['source']) for p in rows]
    assert len(keys)==len(set(keys)) and keys==sorted(keys,reverse=True)
    return rows,pages,first_cursor

try:
    uid=sql("INSERT INTO users(email,password_hash,phone,display_name,role) VALUES(%s,'no-login','01000000000','Dev regression','admin') RETURNING id",(f'fault-{run}@example.invalid',))
    encode=lambda x:base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).rstrip(b'=')
    msg=encode({'alg':'HS256','typ':'JWT'})+b'.'+encode({'sub':str(uid),'iat':int(time.time()),'exp':int(time.time())+1800,'typ':'access'})
    token=(msg+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),msg,hashlib.sha256).digest()).rstrip(b'=')).decode()
    did,name=device('faults'); origin=time.time()-180
    post(name,[100,102,104],origin); assert count(did)==3
    post(name,[100,102,104],origin); assert count(did)==3
    post(name,[102,104,106],origin); assert count(did)==4
    latest_before=sql('SELECT last_fix_at FROM devices WHERE id=%s',(did,))
    post(name,[96,98],origin); assert count(did)==6
    assert sql('SELECT last_fix_at FROM devices WHERE id=%s',(did,))==latest_before
    post(name,[112,108,110],origin); assert count(did)==9
    assert sql('SELECT last_lat FROM devices WHERE id=%s',(did,))==round(37+112*.00001,7)
    post(name,[114,114,116],origin); assert count(did)==11
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _:post(name,[118,120],origin),range(2)))
    assert count(did)==13
    post(name,[100,102],time.time()-105,boot=2); assert count(did)==15
    print('PASS duplicate, overlapping, delayed, unordered, concurrent and rebooted GPS batches')

    legacy,legacy_name=device('legacy')
    post(legacy_name,[50,52],origin,with_uptime=False)
    post(legacy_name,[50,52],origin,with_uptime=False); assert count(legacy)==2
    request('/gps-tracker/ingest',dict(device_uid=legacy_name,l80=dict(fix=False,sat=0)))
    previous=sql('SELECT last_fix_at FROM devices WHERE id=%s',(legacy,))
    request('/gps-tracker/ingest',dict(device_uid=legacy_name,fixes=[dict(lat=91,lng=127)]),expected=400)
    request('/gps-tracker/ingest',dict(device_uid=legacy_name,fixes=[dict(lat=37,lng=127,age_ms=-1)]),expected=400)
    assert sql('SELECT last_fix_at FROM devices WHERE id=%s',(legacy,))==previous
    print('PASS legacy retry compatibility, missing fix and invalid payload rejection')

    # A batch crosses KST midnight, but its anchor is in the second day.
    midnight=dt.datetime(2026,9,19,15,tzinfo=dt.timezone.utc).timestamp()
    post(name,[100,104],midnight-102,boot=3)
    dates,_=request(api+f'/devices/{did}/active-dates')
    assert {'2026-09-19','2026-09-20'}<=set(dates)
    assert sql("SELECT count(*) FROM stats_rebuild_queue WHERE device_id=%s AND date IN ('2026-09-19','2026-09-20')",(did,))==2
    result,_=request(api+f'/admin/devices/{did}/recompute-stats',{})
    assert result['dates_failed']==0
    assert sql('SELECT sum(fix_count) FROM daily_stats WHERE device_id=%s',(did,))==count(did)
    before=sql('SELECT sum(distance_m) FROM daily_stats WHERE device_id=%s',(did,))
    post(name,[100,104],midnight-102,boot=3)
    request(api+f'/admin/devices/{did}/recompute-stats',{})
    assert abs(sql('SELECT sum(distance_m) FROM daily_stats WHERE device_id=%s',(did,))-before)<1e-6
    print('PASS KST midnight backfill, original-point/stat counts and duplicate distance invariance')

    page_id,_=device('pages')
    sql("""INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng)
       SELECT %s,%s,'2026-09-22T00:00:00Z'::timestamptz+i*interval '2 seconds','l80',true,37,127
       FROM generate_series(0,10004) i""",(page_id,uid))
    # Same timestamp, different source exercises the compound cursor tie-breaker.
    sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES(%s,%s,'2026-09-22T01:00:00Z','phone',true,37,127)",(page_id,uid))
    bounds=('2026-09-22T00:00:00Z','2026-09-23T00:00:00Z')
    started=time.monotonic(); rows,pages,cursor=paged(page_id,*bounds)
    timings['10006_points_all_pages_ms']=round((time.monotonic()-started)*1000)
    assert len(rows)==10006 and pages==6
    bad=urllib.parse.urlencode(dict(since=bounds[0],until=bounds[1],fix_only='true',cursor=cursor))
    request(api+f'/devices/{did}/locations/page?'+bad,expected=400)
    changed=urllib.parse.urlencode(dict(since='2026-09-21T00:00:00Z',until=bounds[1],fix_only='true',cursor=cursor))
    request(api+f'/devices/{page_id}/locations/page?'+changed,expected=400)
    print('PASS complete 10,006-point paging, equal-time sources and cursor query isolation')

    # Exact windows, positive/negative offsets, overlap dedup and source ownership.
    edge_id,_=device('edges')
    fixes=[dict(at_ms=x,lat=37,lng=127,sat=12) for x in [-1000,0,1000,2000]]
    sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb) VALUES(%s,%s,'2026-09-20T15:00:00Z','l80',true,37,127,%s)",(edge_id,uid,json.dumps(fixes)))
    edge,pages,_=paged(edge_id,'2026-09-20T14:59:59Z','2026-09-20T15:00:02Z',limit=2)
    assert len(edge)==3 and pages==2
    latest,_=request(api+f'/devices/{edge_id}/locations/latest')
    assert latest['recorded_at'].startswith('2026-09-20T15:00:02')
    for timezone in ['UTC','America/New_York','Asia/Seoul']:
        sql('SET TIME ZONE %s',(timezone,))
        assert sql("SELECT count(*) FROM ((SELECT * FROM location_points WHERE device_id=%s AND user_id=%s) EXCEPT (SELECT * FROM location_points_between(%s,%s,NULL,NULL))) t",(edge_id,uid,edge_id,uid))==0
        assert sql("SELECT count(*) FROM ((SELECT * FROM location_points_between(%s,%s,NULL,NULL)) EXCEPT (SELECT * FROM location_points WHERE device_id=%s AND user_id=%s)) t",(edge_id,uid,edge_id,uid))==0
    print('PASS page split inside a batch, exclusive boundaries and timezone-independent range equivalence')

    month_id,_=device('month')
    sql("""INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng)
        SELECT %s,%s,'2026-08-01T00:00:00+09:00'::timestamptz+i*interval '5 minutes','l80',true,37,127
        FROM generate_series(0,8927) i""",(month_id,uid))
    start=dt.datetime.fromisoformat('2026-08-01T00:00:00+09:00'); end=start+dt.timedelta(days=31)
    q=dict(bucket='5m',since=start.isoformat(),until=end.isoformat(),until_exclusive='true')
    request(api+f'/devices/{month_id}/locations/aggregated?'+urllib.parse.urlencode(q),expected=400)
    buckets=[]
    while start<end:
        stop=min(start+dt.timedelta(minutes=5*2000),end)
        q.update(since=start.isoformat(),until=stop.isoformat())
        result,_=request(api+f'/devices/{month_id}/locations/aggregated?'+urllib.parse.urlencode(q))
        buckets.extend(result);start=stop
    assert len(buckets)==8928 and sum(r['fix_count'] for r in buckets)==8928
    assert len({r['bucket'] for r in buckets})==8928
    print('PASS complete 31-day aggregate (8,928 buckets), exclusive splits and explicit oversized-query error')

    if '--benchmark' in sys.argv:
        bench,_=device('benchmark')
        batch=json.dumps([dict(at_ms=-i*1000,lat=37+i*.00001,lng=127,sat=12) for i in range(100)])
        sql("""INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb)
          SELECT %s,%s,'2026-09-23T00:00:00Z'::timestamptz+i*interval '100 seconds','l80',true,37,127,%s::jsonb
          FROM generate_series(1,1000) i""",(bench,uid,batch))
        def explain(label,query,args):
            cur.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query,args)
            plan=cur.fetchone()[0][0];timings[label]=plan['Execution Time']
        explain('canonical_latest_ms','SELECT recorded_at,lat,lng FROM location_points WHERE device_id=%s AND user_id=%s ORDER BY recorded_at DESC LIMIT 1',(bench,uid))
        explain('indexed_latest_bound_ms','SELECT location_point_bound(recorded_at,fixes_jsonb,true) FROM location_records WHERE device_id=%s AND user_id=%s ORDER BY location_point_bound(recorded_at,fixes_jsonb,true) DESC LIMIT 1',(bench,uid))
        explain('canonical_dates_ms',"SELECT DISTINCT (recorded_at AT TIME ZONE 'Asia/Seoul')::date FROM location_points WHERE device_id=%s AND user_id=%s",(bench,uid))
        explain('batch_dates_ms','SELECT DISTINCT unnest(location_fix_dates(recorded_at,fixes_jsonb,fix)) FROM location_records WHERE device_id=%s AND user_id=%s',(bench,uid))
        latest,timings['latest_http_100k_ms']=request(api+f'/devices/{bench}/locations/latest')
        assert latest['recorded_at'].startswith('2026-09-24T03:46:40')
    print('MEASUREMENTS '+json.dumps(timings,sort_keys=True))
finally:
    for did in devices:sql('DELETE FROM devices WHERE id=%s',(did,))
    if uid:sql('DELETE FROM users WHERE id=%s',(uid,))
    db.close()
