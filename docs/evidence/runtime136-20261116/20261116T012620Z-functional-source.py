"""Historical binding search and first consent requests, synthetic only."""
import base64,hashlib,json,os,time,uuid,subprocess
from datetime import datetime,timedelta,timezone
from urllib.parse import urlencode
from pathlib import Path
import psycopg2
import test_unattributed132 as t
ROOT,sql=t.ROOT,t.sql
SEARCH='/corporate/subject-bindings'
MAPPINGS='/corporate/subject-mappings'
passed=[]

def ok(message):passed.append(message);print('PASS '+message,flush=True)
def page(who,params=None,owner=None):return t.call('GET',SEARCH+'?'+urlencode(params or {}),who=who,extra={'X-Fleet-Owner':str(owner)} if owner else None)
def fingerprint():
    return {name:sql(f"SELECT md5(coalesce(string_agg(to_jsonb(x)::text,',' ORDER BY to_jsonb(x)::text),'')) FROM {name} x")[0][0] for name in ('location_subject_mappings','location_subject_actions','fleet_vehicle_bindings','location_records')}

def main():
    t.migrate('migration136',t.DSN)
    ring=json.dumps({'active':'synthetic136','keys':{'synthetic136':base64.b64encode(os.urandom(32)).decode()}})
    t.secret(ROOT/'api-keyring.json',ring);os.chown(ROOT/'api-keyring.json',1000,1000)
    t.secret(ROOT/'mfa-key.txt',base64.b64encode(os.urandom(32)).decode())
    sql("SELECT set_config('gps.storage_keys',%s,false)",(ring,))
    sql('UPDATE location_storage_policy SET enabled=true,activated_at=now()')
    roles=t.separate(t.DSN,True,ROOT/'test-runtime.json')
    sql('GRANT CREATE ON TABLESPACE gps121_sort TO gps_runtime')
    sql("ALTER ROLE gps_runtime IN DATABASE gps_closure_test SET temp_tablespaces='gps121_sort'")
    for name in ('uploads','private'):
        p=ROOT/'test-storage'/name;p.mkdir(exist_ok=True);os.chown(p,1000,1000)
    t.start();t.tls()
    for _ in range(80):
        try:
            c=t.connection();c.request('GET','/gps-tracker/health');r=c.getresponse();r.read();c.close()
            if r.status==200:break
        except OSError:pass
        time.sleep(.1)
    else:raise AssertionError('TLS proxy not ready')
    owner,driver,other,admin,member,manager=[t.account(n) for n in range(6)]
    uid,subject=owner['user_id'],driver['user_id']
    def staff(who,role='member'):
        sid=sql("INSERT INTO staff(user_id,name,active,access_role) VALUES(%s,'Synthetic136 staff',true,%s) RETURNING id",(uid,role))[0][0]
        sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(uid,sid,who['user_id']))
        return sid
    sid=staff(driver);admin_staff=staff(admin,'admin');staff(member);staff(manager,'department_manager')
    did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'synthetic136-main','') RETURNING id",(uid,))[0][0]
    aux=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'synthetic136-aux','') RETURNING id",(uid,))[0][0]
    vid=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'합성 차량') RETURNING id",(uid,))[0][0]
    begin=datetime.now(timezone.utc).replace(microsecond=123000)-timedelta(days=2);end=begin+timedelta(minutes=30)
    binding=sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at,ended_at) VALUES(%s,%s,%s,%s,%s,%s) RETURNING id",(uid,vid,did,'Archive 100%_ unit',begin-timedelta(days=5),end+timedelta(hours=1)))[0][0]
    sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at,ended_at) SELECT %s,%s,%s,'Recent unit',%s::timestamptz-n*interval '1 day',%s::timestamptz-n*interval '1 day'+interval '1 hour' FROM generate_series(1,206) n",(uid,vid,aux,begin,begin))
    sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,terminal_name,started_at,ended_at) VALUES(%s,%s,'No SIM',%s,%s)",(uid,vid,begin,end))
    foreign_vid=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'Foreign vehicle') RETURNING id",(other['user_id'],))[0][0]
    foreign_did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'synthetic136-foreign','') RETURNING id",(other['user_id'],))[0][0]
    foreign=sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at,ended_at) VALUES(%s,%s,%s,'Archive foreign',%s,%s) RETURNING id",(other['user_id'],foreign_vid,foreign_did,begin-timedelta(days=5),end))[0][0]
    assert page(None)[0]==401
    for who in (driver,member,manager):assert page(who,owner=uid)[0]==403
    assert page(other,owner=uid)[0]==403
    assert [r['id'] for r in page(other)[1]['items']]==[foreign]
    assert page(admin,owner=uid)[0]==200
    assert t.call('POST',SEARCH,{},admin,{'X-Fleet-Owner':str(uid)})[0]==403
    expected=[r[0] for r in sql('SELECT id FROM fleet_vehicle_bindings WHERE owner_id=%s AND device_id IS NOT NULL ORDER BY id DESC',(uid,))]
    before=fingerprint();ids=[];lengths=[];params={}
    allowed={'id','vehicle_id','device_id','starts_at','ends_at','vehicle_name','terminal_name'}
    while True:
        status,data,headers=page(owner,params);assert status==200
        assert 'no-store' in {k.lower():v for k,v in headers.items()}['cache-control']
        assert all(set(r)==allowed for r in data['items'])
        ids.extend(r['id'] for r in data['items']);lengths.append(len(data['items']))
        if data['next_before'] is None:break
        params={'before':data['next_before']}
    assert ids==expected and lengths==[50,50,50,50,7] and before==fingerprint()
    assert [r['id'] for r in page(admin,owner=uid)[1]['items']]==expected[:50]
    legacy=t.call('GET',MAPPINGS,who=owner)[1]
    assert len(legacy['bindings'])==200 and binding not in {x['id'] for x in legacy['bindings']}
    assert legacy['items']==[]
    ok('owner/admin only, foreign/no-SIM excluded, explicit metadata fields;207 bindings50/50/50/50/7; old unrequested binding beyond200 is reachable without writes')
    for q in ('archive','ARCHIVE','  archive  ','%_','100%_'):
        found=page(owner,{'q':q})[1];assert [r['id'] for r in found['items']]==[binding] and found['next_before'] is None,q
    assert len(page(owner,{'q':'합성'})[1]['items'])==50
    assert binding in {r['id'] for r in page(owner,{'q':str(did)})[1]['items']}
    assert page(owner,{'q':"' OR true --"})[1]['items']==[]
    assert page(owner,{'q':'No SIM'})[1]['items']==[]
    assert page(owner,{'q':'no result'})[1]['next_before'] is None
    assert page(owner,{'before':binding+1,'limit':1})[1]['next_before'] is None
    assert page(owner,{'limit':100})[1]['next_before']==expected[99]
    for bad in ({'before':0},{'before':-1},{'limit':0},{'limit':101},{'limit':'x'},{'q':'한'*81},{'q':'bad\nquery'},{'owner_id':uid},{'status':'all'}):assert page(owner,bad)[0]==400,bad
    assert before==fingerprint()
    ok('literal case-insensitive name/Korean/SIM search, wildcard and injection text remain literal; exact last-page and input/owner override rejection')
    lock=psycopg2.connect(t.DSN);lock.autocommit=False
    with lock.cursor() as c:c.execute('LOCK TABLE fleet_vehicle_bindings IN ACCESS EXCLUSIVE MODE')
    client=t.connection()
    try:
        client.request('GET',t.BASE+SEARCH,headers=t.headers(owner))
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND wait_event_type='Lock' AND query LIKE 'SELECT jsonb_build_object(%%fleet_vehicle_bindings%%'")[0][0]==1:break
            time.sleep(.05)
        else:raise AssertionError('binding search did not reach lock')
        client.close()
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND state<>'idle' AND query LIKE 'SELECT jsonb_build_object(%%fleet_vehicle_bindings%%'")[0][0]==0:break
            time.sleep(.05)
        else:raise AssertionError('binding cancellation left SQL')
    finally:client.close();lock.rollback();lock.close()
    assert page(owner)[0]==200 and before==fingerprint()
    ok('one blocked TLS search cancels SQL and releases read slot; retry200 and source unchanged; no sustained load')
    sql("UPDATE location_subject_policy SET enabled=true,reference='synthetic136-policy',push_enabled=false")
    env=Path('/etc/gps121/api.env');t.secret(env,env.read_text().replace('GPS_SUBJECT_PROVISION=off','GPS_SUBJECT_PROVISION=on'))
    subprocess.run(['systemctl','restart','gps121-api'],check=True)
    for _ in range(100):
        try:
            if page(owner)[0]==200:break
        except OSError:pass
        time.sleep(.1)
    else:raise AssertionError('API not ready')
    def proposal(**changes):return dict(request_key=str(uuid.uuid4()),staff_id=sid,binding_id=binding,starts_at=begin.isoformat(),ends_at=end.isoformat(),**changes)
    found=page(owner,{'q':'archive'})[1]['items'][0];assert found['id']==binding
    p=proposal();p['binding_id']=found['id']
    status,m,_=t.call('POST',MAPPINGS,p,admin,{'X-Fleet-Owner':str(uid)});assert status==200,(status,m)
    mid=m['id'];assert t.call('POST',MAPPINGS,p,owner)[1]['id']==mid
    row=sql('SELECT status,proposed_by,subject_id,starts_at,ends_at FROM location_subject_mappings WHERE id=%s',(mid,))[0]
    assert row==('pending',admin['user_id'],subject,begin,end)
    assert t.call('GET',f'{MAPPINGS}/{mid}/locations',who=owner)[0]==404
    def decision(id,action='confirmed',who=driver,revision=None):
        rev=sql('SELECT revision FROM location_subject_mappings WHERE id=%s',(id,))[0][0] if revision is None else revision
        return t.call('POST',f'/privacy/subject-mappings/{id}/decision',dict(action=action,revision=rev,consent_version='fleet-subject-v1'),who)
    assert decision(mid,who=other)[0]==404 and decision(mid,revision=99)[0]==409
    assert decision(mid)[0]==200
    sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',%s,37.136,127.136,true)",(did,uid,begin+timedelta(minutes=1)))
    status,locations,_=t.call('GET',f'{MAPPINGS}/{mid}/locations',who=owner);assert status==200 and len(locations['items'])==1
    assert len(t.call('GET','/privacy/provision-notices',who=driver)[1]['items'])==1
    ok('old never-requested binding creates first pending request via delegated admin; idempotent retry, exact interval, subject-only fresh consent before encrypted location and notice')
    assert decision(mid,'revoked')[0]==200
    assert t.call('GET',f'{MAPPINGS}/{mid}/locations',who=owner)[0]==404
    # Search/selection must not bypass withdrawal, even for a fresh request key.
    status,plain,_=t.call('POST',MAPPINGS,proposal(),owner);assert status==200
    assert decision(plain['id'])[0]==409
    assert sql('SELECT status FROM location_subject_mappings WHERE id=%s',(plain['id'],))==[('pending',)]
    assert t.call('GET',f"{MAPPINGS}/{plain['id']}/locations",who=owner)[0]==404
    p=proposal(replaces_id=mid,replaces_revision=sql('SELECT revision FROM location_subject_mappings WHERE id=%s',(mid,))[0][0],change_kind='reconsent')
    status,m,_=t.call('POST',MAPPINGS,p,owner);assert status==200
    renewed=m['id'];assert t.call('GET',f'{MAPPINGS}/{renewed}/locations',who=owner)[0]==404
    assert decision(renewed)[0]==200
    assert t.call('GET',f'{MAPPINGS}/{renewed}/locations',who=owner)[0]==200
    assert len(t.call('GET','/privacy/provision-notices',who=driver)[1]['items'])==2
    ok('search cannot undo revocation; ordinary new request stays pending and confirmation409; explicit identical reconsent requires subject confirmation; second notice retained')
    bad=proposal();bad['binding_id']=foreign;assert t.call('POST',MAPPINGS,bad,owner)[0]==404
    bad=proposal();bad['starts_at']=(begin-timedelta(days=10)).isoformat();assert t.call('POST',MAPPINGS,bad,owner)[0]==404
    sql('UPDATE fleet_vehicle_bindings SET ended_at=%s WHERE id=%s',(begin+timedelta(minutes=5),binding))
    assert t.call('POST',MAPPINGS,proposal(),owner)[0]==404
    sql('UPDATE fleet_vehicle_bindings SET ended_at=%s WHERE id=%s',(end+timedelta(hours=1),binding))
    sql('DELETE FROM fleet_staff_accounts WHERE owner_id=%s AND staff_id=%s',(uid,sid))
    assert t.call('POST',MAPPINGS,proposal(),owner)[0]==404
    sql('DELETE FROM fleet_staff_accounts WHERE owner_id=%s AND staff_id=%s',(uid,admin_staff))
    assert page(admin,owner=uid)[0]==403
    ok('proposal rechecks selected binding owner/period and active subject; closed binding, removed staff or revoked delegated access cannot reuse stale search authority')
    t.start(False)
    assert page(owner,{'q':'archive'})[1]['enabled'] is False
    assert t.call('POST',MAPPINGS,proposal(),owner)[0]==409
    assert decision(renewed,'revoked')[0]==200
    assert t.call('GET',f'{MAPPINGS}/{renewed}/locations',who=owner)[0]==404
    assert sql('SELECT count(*),count(*) FILTER(WHERE lat IS NOT NULL OR lng IS NOT NULL),count(lat_sealed) FROM location_records')==[(1,0,1)]
    ok('feature OFF permits historical metadata only; new proposal409, existing consent can still be revoked, encrypted storage retained')
    t.stop_api()
    (ROOT/'out/functional136.json').write_text(json.dumps(dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),schema=114,passed=passed,
        api_sha256=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest(),fixture=dict(accounts=6,owned_sim_bindings=207,null_sim_bindings=1,foreign_bindings=1,page_lengths=lengths),
        read_only_source_hashes=before,db_role_report=roles,production_accessed=False,sustained_load_executed=False,
        environment='internal TLS1.2; PostgreSQL14/Timescale; separated gps_runtime; synthetic only'),indent=2)+'\n')
    print('PASS all',len(passed),'functional groups',flush=True)

if __name__=='__main__':main()
