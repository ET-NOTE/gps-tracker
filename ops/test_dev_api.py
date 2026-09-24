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
try:
    for label in ['a','b']:
        uid=query("INSERT INTO users(email,password_hash,phone,display_name,credits) VALUES(%s,'test-only-no-login','01000000000','Dev regression',1000) RETURNING id",(f'review-{run}-{label}@example.invalid',)); users.append(uid)
    a,b=users
    did=query("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name,paired_at) VALUES(%s,%s,'','Dev regression',now()) RETURNING id",('review-'+run,b)); devices.append(did)
    anchor=dt.datetime(2026,9,20,15,0,5,tzinfo=dt.timezone.utc)
    points=[{'at_ms':offset,'lat':37+i*.00027,'lng':127,'sat':9,'speed_kmh':7.2} for i,offset in enumerate([-20000,-10000,0])]
    query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb) VALUES(%s,%s,%s,'l80',true,37.1,127,%s)",(did,b,anchor,json.dumps(points)))
    query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES(%s,%s,%s-interval '2 hours','l80',true,38,128)",(did,a,anchor))
    query("INSERT INTO daily_stats(device_id,user_id,date,fix_count) VALUES(%s,%s,'2026-09-01',999)",(did,a))
    token='review-'+run
    query("INSERT INTO share_tokens(token,device_id,created_by,expires_at) VALUES(%s,%s,%s,now()+interval '1 hour')",(token,did,b))
    rows=request(api+f'/share/{token}/locations')
    assert len(rows)==3 and all(r['lat']<38 for r in rows)
    assert len(request(api+f'/share/{token}/locations?limit=1'))==3
    assert len(request(api+f'/devices/{did}/locations?limit=1',b))==3
    assert request(api+f'/share/{token}/daily_stats')==[]
    request(api+f'/devices/{did}/locations',a,expected=404)
    print('PASS shared owner isolation and batch expansion')

    bounds=urllib.parse.urlencode({'since':'2026-09-20T14:59:44Z','until':'2026-09-20T14:59:56Z'})
    rows=request(api+f'/devices/{did}/locations?'+bounds,b)
    assert len(rows)==2 and rows[0]['speed_kmh']>7
    grouped=request(api+f'/devices/{did}/locations?grouped=true&'+bounds,b)
    assert sum(len(p['fixes']) for p in grouped)==2
    buckets=request(api+f'/devices/{did}/locations/aggregated?bucket=1m&'+bounds,b)
    assert sum(r['fix_count'] for r in buckets)==2
    print('PASS batch boundaries, grouped history, speed and bucket counts')

    updated=request(api+f'/devices/{did}',b,'PATCH',{'next_service_date':'2026-12-01','next_service_km':20000,'car_model':'Review'})
    assert updated['next_service_date']=='2026-12-01'
    updated=request(api+f'/devices/{did}',b,'PATCH',{'next_service_date':None})
    assert updated['next_service_date'] is None and updated['next_service_km']==20000
    print('PASS nullable maintenance PATCH')

    boundary='review'+run
    document=(f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nreceipt\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="regression.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode()+b'%PDF-1.4\n'+b' '*2_000_000+f'\r\n--{boundary}--\r\n'.encode())
    result=request(api+f'/devices/{did}/documents',b,'POST',raw=document,content_type='multipart/form-data; boundary='+boundary)
    docid=result['id']; files.append(docid)
    request(api+f'/documents/{docid}/download',a,expected=404)
    request(api+f'/documents/{docid}',b,'DELETE'); files.remove(docid)
    print('PASS upload above 1 MiB and document ownership')
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\x00\x00\x00\x00'))+chunk(b'IEND',b'')
    image=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+png+f'\r\n--{boundary}--\r\n'.encode())
    result=request(api+f'/devices/{did}/car-image',b,'POST',raw=image,content_type='multipart/form-data; boundary='+boundary)
    photos.append(result['url'])
    if base.startswith('https:'): assert request(result['url'])==png
    print('PASS car photo upload and public asset delivery')

    delete=urllib.parse.urlencode({'from':'2026-09-20T14:59:54Z','until':'2026-09-20T14:59:56Z'})
    result=request(api+f'/devices/{did}/range?'+delete,b,'DELETE')
    assert result['deleted_locations']==1
    assert len(request(api+f'/devices/{did}/locations',b))==2
    assert query('SELECT count(*) FROM stats_rebuild_queue WHERE device_id=%s',(did,))>=1
    assert query('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s',(did,a))==1
    print('PASS partial batch deletion, durable invalidation and prior-owner preservation')

    request('/gps-tracker/ingest',method='POST',body={'device_uid':'review-'+run,'ts':120,'l80':{'fix':True,'lat':37.1,'lng':127.1,'sat':8,'speed_kmh':12.5}})
    latest=request(api+f'/devices/{did}/locations/latest',b)
    assert latest['speed_kmh'] is None and latest['reported_speed_kmh']==12.5
    print('PASS firmware-compatible ingest with optional GPS speed')

    query('UPDATE devices SET owner_id=%s WHERE id=%s',(a,did))
    request(api+f'/share/{token}/locations',expected=404)
    print('PASS stale share revoked by ownership change')
finally:
    for fid in files:
        try: request(api+f'/documents/{fid}',users[-1],'DELETE')
        except Exception: pass
    for did in devices: query('DELETE FROM devices WHERE id=%s',(did,))
    for uid in users: query('DELETE FROM users WHERE id=%s',(uid,))
    for url in photos:
        assert url.startswith('/uploads/car-images/dev_')
        root=pathlib.Path(env['UPLOAD_DIR']).resolve()
        file=(root/url.removeprefix('/uploads/')).resolve()
        assert file.is_relative_to(root)
        file.unlink(missing_ok=True)
    db.close()
