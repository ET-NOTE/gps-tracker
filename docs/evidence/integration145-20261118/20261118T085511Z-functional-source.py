"""Notion delta integration only. Runs in the labelled, internal145 container.

Actual114->115 migration, restricted API DB role, odometer/exports/corrections.
Existing corporate test fixtures are adapted in memory to this disposable DB;
their assertions and cleanup remain unchanged. No deployed server connection.
"""
import base64, datetime, hashlib, hmac, io, json, os, subprocess, sys, time
from pathlib import Path
import urllib.error, urllib.request, zipfile, xml.etree.ElementTree as ET
import psycopg2
import runtime121_control as runtime
from admin_db_roles import run as separate

ROOT, DSN = runtime.ROOT, runtime.DSN
assert Path('/etc/runtime121-test-only').read_text().strip() == 'synthetic'
BASE = 'http://127.0.0.1:3043'
JWT = 'synthetic-cumulative-migration-only'
checks = []
db = psycopg2.connect(DSN); db.autocommit = True


def sql(query, args=()):
    with db.cursor() as c:
        c.execute(query, args or None)
        return c.fetchall() if c.description else None


def ok(message):
    checks.append(message); print('PASS '+message, flush=True)


def call(user, method, path, body=None, expected=200, binary=False):
    enc=lambda value:base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=')
    raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(user),'typ':'access','iat':int(time.time()),'exp':int(time.time())+1800})
    token=(raw+b'.'+base64.urlsafe_b64encode(hmac.new(JWT.encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()
    request=urllib.request.Request(BASE+'/gps-tracker/api/v1'+path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method=method)
    try:
        with urllib.request.urlopen(request,timeout=30) as response:status=response.status;data=response.read()
    except urllib.error.HTTPError as error:status=error.code;data=error.read()
    assert status==expected,(method,path,status,data[:300])
    return data if binary else json.loads(data)


def cells(blob):
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        strings=[''.join(si.itertext()) for si in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('s:si',ns)]
        result={}
        for cell in ET.fromstring(archive.read('xl/worksheets/sheet1.xml')).findall('.//s:sheetData/s:row/s:c',ns):
            value=cell.find('s:v',ns)
            if value is not None:result[cell.attrib['r']]=strings[int(value.text)] if cell.attrib.get('t')=='s' else float(value.text)
        return result


def main():
    runtime.stop_api()
    binary=Path('/opt/gps-tracker-api')
    assert binary.is_symlink()
    binary.unlink();binary.symlink_to(ROOT/'out/gps-tracker-api144')
    runtime.migrate('migration145-baseline114',DSN)
    assert sql('SELECT max(version) FROM _sqlx_migrations')==[(114,)]
    owner=sql("INSERT INTO users(email,password_hash,display_name,phone) VALUES('odometer145@example.invalid','synthetic','Synthetic145','01000000000') RETURNING id")[0][0]
    outsider=sql("INSERT INTO users(email,password_hash,display_name,phone) VALUES('outsider145@example.invalid','synthetic','Synthetic145','01000000001') RETURNING id")[0][0]
    device=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES('odometer145',%s,'') RETURNING id",(owner,))[0][0]
    start=datetime.datetime(2026,11,10,tzinfo=datetime.timezone.utc)
    sql("INSERT INTO trip_annotations(device_id,user_id,trip_started_at,purpose,note) VALUES(%s,%s,%s,'business','legacy114')",(device,owner,start))
    before=sql('SELECT to_jsonb(t) FROM trip_annotations t WHERE device_id=%s',(device,))[0][0]
    binary.unlink();binary.symlink_to(ROOT/'out/gps-tracker-api')
    runtime.migrate('migration145-upgrade115',DSN)
    assert sql('SELECT max(version) FROM _sqlx_migrations')==[(115,)]
    after=sql('SELECT to_jsonb(t) FROM trip_annotations t WHERE device_id=%s',(device,))[0][0]
    assert {k:v for k,v in after.items() if not k.startswith('odometer_')}==before
    assert after['odometer_before_km'] is None and after['odometer_after_km'] is None
    ok('actual114->115 SQLx migration preserves existing annotation and leaves new readings NULL')
    roles=separate(DSN,True,ROOT/'test-runtime.json')
    credentials=json.loads((ROOT/'test-runtime.json').read_text())
    app_dsn=DSN.replace('postgres:closure-test-only',credentials['user']+':'+credentials['password'])
    for name in ('uploads','private'):
        folder=ROOT/'test-storage'/name;folder.mkdir(exist_ok=True);os.chown(folder,1000,1000)
    runtime.boot_settled(dict(RUNTIME_DSN=app_dsn))
    assert sql("SELECT rolsuper FROM pg_roles WHERE rolname='gps_runtime'")==[(False,)]
    sql("INSERT INTO subscriptions(user_id,kind,expires_at) VALUES(%s,'corporate_report',now()+interval '1 day')",(owner,))
    sql("INSERT INTO corporate_info(user_id,company_name,business_number) VALUES(%s,'Synthetic145','000-00-00000')",(owner,))
    vehicle=call(owner,'POST','/corporate/vehicles',dict(name='검증 차량',enabled=True,profile={}))['id']
    binding=sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,is_primary,started_at) VALUES(%s,%s,%s,'Synthetic145',true,%s) RETURNING id",(vehicle,owner,device,start-datetime.timedelta(days=1)))[0][0]
    for kind,minute in [('wake',0),('sleep_enter',20)]:
        sql('INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,%s,%s)',(device,owner,kind,start+datetime.timedelta(minutes=minute)))
    for minute in range(0,21,5):
        sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,%s,127,%s)",(device,owner,37+minute*.001,start+datetime.timedelta(minutes=minute)))
    root=f'/corporate/vehicles/{vehicle}'
    def trips():return call(owner,'GET',root+'/trips?from=2026-11-10&to=2026-11-10')
    trip=trips()[0]
    key=dict(binding_id=binding,source_device_id=device,trip_started_at=trip['source_started_at'])
    patch=dict(key,purpose='business',odometer_before_km=1000.25,odometer_after_km=1012.75)
    route=root+'/trips/annotation'
    saved=call(owner,'PATCH',route,patch)
    assert saved['odometer_before_km']==1000.25 and saved['odometer_after_km']==1012.75
    assert trips()[0]['distance_m']==trip['distance_m']
    omitted=call(owner,'PATCH',route,dict(key,purpose='business',note='old client'))
    assert omitted['odometer_before_km']==1000.25
    for invalid in ({'odometer_before_km':1},{'odometer_before_km':3,'odometer_after_km':2},{'odometer_before_km':-1,'odometer_after_km':2},{'odometer_before_km':1.001,'odometer_after_km':2},{'odometer_before_km':10000000,'odometer_after_km':10000000}):
        call(owner,'PATCH',route,dict(key,**invalid),expected=400)
    call(outsider,'PATCH',route,patch,expected=404)
    ok('restricted runtime role saves/readbacks readings; omitted old-client fields preserve, invalid values and other tenant denied')
    blob=call(owner,'GET',f'/corporate/report.xlsx?scope=vehicles&type=nts&month=2026-11&vehicle_ids={vehicle}',binary=True)
    workbook=cells(blob)
    row=next(int(k[1:]) for k,v in workbook.items() if k.startswith('D') and v==1000.25)
    assert workbook[f'E{row}']==1012.75 and workbook[f'F{row}']==12.5
    (ROOT/'out/odometer145-synthetic.xlsx').write_bytes(blob)
    ok('actual XLSX contains entered before/after readings and their12.5km difference; original GPS distance unchanged')
    source_hash=sql("SELECT md5(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text)) FROM location_records t WHERE device_id=%s",(device,))[0][0]
    request=dict(action='split',reason='Synthetic145 split',from_date='2026-11-10',to_date='2026-11-10',trips=[key],split_at=(start+datetime.timedelta(minutes=10)).isoformat())
    # Match the existing public correction request's date field names.
    request['from']=request.pop('from_date');request['to']=request.pop('to_date')
    preview=call(owner,'POST',root+'/trips/corrections',request)
    assert all((item.get('annotation') or {}).get('odometer_before_km') is None for item in preview['after'])
    correction=call(owner,'POST',root+'/trips/corrections',dict(request,preview_token=preview['preview_token']))
    call(owner,'PATCH',route,patch,expected=409)
    assert sql('SELECT odometer_before_km::float8,odometer_after_km::float8 FROM trip_annotations WHERE device_id=%s AND trip_started_at=%s',(device,start))==[(1000.25,1012.75)]
    call(owner,'POST',root+f"/trips/corrections/{correction['id']}/restore",{'reason':'Synthetic145 restore'})
    assert trips()[0]['annotation']['odometer_before_km']==1000.25
    cleared=call(owner,'PATCH',route,dict(key,purpose='business',odometer_before_km=None,odometer_after_km=None))
    assert cleared['odometer_before_km'] is None and cleared['odometer_after_km'] is None
    assert sql("SELECT md5(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text)) FROM location_records t WHERE device_id=%s",(device,))[0][0]==source_hash
    ok('split omits derived readings, original survives, corrected edit409, restore recovers, explicit NULL clears, raw GPS hash unchanged')
    # Run changed export/quality assertions on this same bounded internal API.
    envfile=ROOT/'fixture145.env'
    runtime.secret(envfile,'DATABASE_URL='+DSN+'\nJWT_SECRET='+JWT+'\n')
    for name in ('test_corporate_template.py','test_fleet_trip_quality.py'):
        source=(ROOT/name).read_text()
        assert source.count("assert base=='http://127.0.0.1:3042'")==1
        assert source.count("=='/gps_tracker_dev_prodreview_20261020'")==1
        source=source.replace("assert base=='http://127.0.0.1:3042'","assert base=='http://127.0.0.1:3043'").replace("=='/gps_tracker_dev_prodreview_20261020'","=='/gps_closure_test'")
        adapted=ROOT/('adapted145-'+name);adapted.write_text(source)
        result=subprocess.run([sys.executable,str(adapted),str(envfile),BASE],capture_output=True,text=True,timeout=180)
        (ROOT/'out'/('145-'+name+'.log')).write_text(result.stdout+result.stderr)
        print(result.stdout[-5000:]+result.stderr[-2000:],flush=True)
        assert result.returncode==0,name
        ok(name+' changed assertions pass on restricted runtime API')
    runtime.stop_api()
    (ROOT/'out/functional145.json').write_text(json.dumps(dict(checks=checks,schema=115,production_accessed=False,load_expanded=False,
        api_sha256=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest(),db_roles=roles,
        flags='same as team-review: encryption/ledger/subject-provision/admin-security OFF; no activation claim'),indent=2)+'\n')
    print('PASS all',len(checks),'integration groups',flush=True)


if __name__=='__main__':main()
