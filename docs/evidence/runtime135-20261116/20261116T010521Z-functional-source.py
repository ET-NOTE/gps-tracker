"""Small company mapping pagination and consent fixtures; no sustained load."""
import base64,hashlib,json,os,time,uuid,subprocess
from datetime import datetime,timedelta,timezone
from urllib.parse import urlencode
from pathlib import Path
import psycopg2
import test_unattributed132 as t
ROOT,sql=t.ROOT,t.sql
ROUTE='/corporate/subject-mappings'
passed=[]
def ok(message):passed.append(message);print('PASS '+message,flush=True)
def page(who,params=None,owner=None):return t.call('GET',ROUTE+'?'+urlencode(params or {}),who=who,extra={'X-Fleet-Owner':str(owner)} if owner else None)
def fingerprint():
    return {name:sql(f"SELECT md5(coalesce(string_agg(to_jsonb(x)::text,',' ORDER BY id),'')) FROM {name} x")[0][0] for name in ('location_subject_mappings','location_subject_actions','fleet_vehicle_bindings','location_records')}
def main():
    t.migrate('migration135',t.DSN)
    ring=json.dumps({'active':'synthetic135','keys':{'synthetic135':base64.b64encode(os.urandom(32)).decode()}})
    t.secret(ROOT/'api-keyring.json',ring);os.chown(ROOT/'api-keyring.json',1000,1000)
    t.secret(ROOT/'mfa-key.txt',base64.b64encode(os.urandom(32)).decode())
    sql("SELECT set_config('gps.storage_keys',%s,false)",(ring,))
    sql('UPDATE location_storage_policy SET enabled=true,activated_at=now()')
    roles=t.separate(t.DSN,True,ROOT/'test-runtime.json')
    sql('GRANT CREATE ON TABLESPACE gps121_sort TO gps_runtime')
    sql("ALTER ROLE gps_runtime IN DATABASE gps_closure_test SET temp_tablespaces='gps121_sort'")
    for name in ('uploads','private'):
        path=ROOT/'test-storage'/name;path.mkdir(exist_ok=True);os.chown(path,1000,1000)
    t.start();t.tls()
    for _ in range(80):
        try:
            c=t.connection();c.request('GET','/gps-tracker/health');r=c.getresponse();r.read();c.close()
            if r.status==200:break
        except OSError:pass
        time.sleep(.1)
    else:raise AssertionError('TLS proxy not ready')
    owner,driver,other,admin,member,manager=[t.account(n) for n in range(6)]
    uid=owner['user_id'];sid_user=driver['user_id']
    def staff(who,role='member'):
        sid=sql("INSERT INTO staff(user_id,name,active,access_role) VALUES(%s,'Synthetic135 staff',true,%s) RETURNING id",(uid,role))[0][0]
        sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(uid,sid,who['user_id']))
        return sid
    sid=staff(driver);staff(admin,'admin');staff(member);staff(manager,'department_manager')
    did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'synthetic135-main','') RETURNING id",(uid,))[0][0]
    aux=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'synthetic135-binding','') RETURNING id",(uid,))[0][0]
    vid=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'Synthetic135 vehicle') RETURNING id",(uid,))[0][0]
    begin=datetime.now(timezone.utc).replace(microsecond=0)-timedelta(hours=1);end=begin+timedelta(minutes=30)
    binding=sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at) VALUES(%s,%s,%s,'Synthetic old binding',%s) RETURNING id",(uid,vid,did,begin-timedelta(days=5)))[0][0]
    sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at,ended_at) SELECT %s,%s,%s,'Synthetic binding '||n,%s::timestamptz-n*interval '1 day',%s::timestamptz-n*interval '1 day'+interval '1 hour' FROM generate_series(1,205) n",(uid,vid,aux,begin,begin))
    assert page(None)[0]==401
    for who in (driver,member,manager):assert page(who,owner=uid)[0]==403
    assert page(other)[1]['items']==[] and page(other)[1]['people']==[] and page(other)[1]['bindings']==[]
    assert page(admin,owner=uid)[0]==200
    assert page(other,owner=uid)[0]==403
    ok('company owner/admin authorized; anonymous401, member/department/foreign-delegation403; unrelated company has no rows or options')
    # Enable only inside this isolated fixture; no notification credentials.
    sql("UPDATE location_subject_policy SET enabled=true,reference='synthetic135-policy',push_enabled=false")
    env_path=Path('/etc/gps121/api.env')
    t.secret(env_path,env_path.read_text().replace('GPS_SUBJECT_PROVISION=off','GPS_SUBJECT_PROVISION=on'))
    subprocess.run(['systemctl','restart','gps121-api'],check=True)
    for _ in range(100):
        try:
            if page(owner)[0]==200:break
        except OSError:pass
        time.sleep(.1)
    else:raise AssertionError('subject-enabled API not ready')
    def proposal(parent=None,kind=None):
        p=dict(request_key=str(uuid.uuid4()),staff_id=sid,binding_id=binding,starts_at=begin.isoformat(),ends_at=end.isoformat())
        if parent is not None:p.update(replaces_id=parent,replaces_revision=sql('SELECT revision FROM location_subject_mappings WHERE id=%s',(parent,))[0][0],change_kind=kind)
        return p
    status,root,_=t.call('POST',ROUTE,proposal(),owner);assert status==200,(status,root)
    root=root['id']
    sql("INSERT INTO location_subject_mappings(request_key,owner_id,subject_id,proposed_by,staff_id,vehicle_id,binding_id,device_id,starts_at,ends_at,status) SELECT gen_random_uuid(),%s,%s,%s,%s,%s,%s,%s,%s::timestamptz-interval '2 days'+n*interval '1 minute',%s::timestamptz-interval '2 days'+n*interval '1 minute'+interval '30 seconds',(ARRAY['pending','rejected','revoked','superseded'])[1+n%%4] FROM generate_series(1,206) n",(uid,sid_user,uid,sid,vid,binding,did,begin,begin))
    expected=[x[0] for x in sql('SELECT id FROM location_subject_mappings WHERE owner_id=%s ORDER BY id DESC',(uid,))]
    before=fingerprint();ids=[];lengths=[];params={'limit':50}
    for _ in range(6):
        status,data,headers=page(owner,params);assert status==200,(status,data)
        assert 'no-store' in {k.lower():v for k,v in headers.items()}['cache-control']
        assert all(x['owner_id']==uid for x in data['items'])
        assert binding in {x['id'] for x in data['bindings']} and len(data['bindings'])==201
        ids.extend(x['id'] for x in data['items']);lengths.append(len(data['items']))
        if data['next_before'] is None:break
        params={'limit':50,'before':data['next_before']}
    assert ids==expected and lengths==[50,50,50,50,7]
    legacy=page(owner)[1];assert [x['id'] for x in legacy['items']]==expected[:200]
    assert page(owner,{'before':legacy['next_before']})[1]['items'][-1]['id']==root
    assert [x['id'] for x in page(admin,{'limit':50},uid)[1]['items']]==expected[:50]
    assert before==fingerprint()
    ok('207 mappings50/50/50/50/7 exact; default200 compatibility; old binding beyond recent200 retained; delegate same owner scope; read-only hashes')
    for state in ('pending','confirmed','rejected','revoked','superseded'):
        expected_state=[x[0] for x in sql('SELECT id FROM location_subject_mappings WHERE owner_id=%s AND status=%s ORDER BY id DESC',(uid,state))]
        items=[];params={'status':state,'limit':50}
        while True:
            status,data,_=page(owner,params);assert status==200
            items.extend(x['id'] for x in data['items'])
            if data['next_before'] is None:break
            params['before']=data['next_before']
        assert items==expected_state,state
    for bad in ({'before':0},{'before':-1},{'limit':0},{'limit':201},{'limit':'bad'},{'status':'wrong'},{'owner_id':other['user_id']}):assert page(owner,bad)[0]==400,bad
    assert page(owner,{'limit':1,'before':root+1})[1]['next_before'] is None
    assert before==fingerprint()
    ok('all five statuses with exact filtered pagination; empty confirmed/last-page has no false continuation; invalid/owner override400')
    lock=psycopg2.connect(t.DSN);lock.autocommit=False
    with lock.cursor() as c:c.execute('LOCK TABLE location_subject_mappings IN ACCESS EXCLUSIVE MODE')
    client=t.connection()
    try:
        client.request('GET',t.BASE+ROUTE+'?limit=50',headers=t.headers(owner))
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND wait_event_type='Lock' AND query LIKE 'SELECT to_jsonb(m)%'")[0][0]==1:break
            time.sleep(.05)
        else:raise AssertionError('mapping read did not reach lock')
        client.close()
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND state<>'idle' AND query LIKE 'SELECT to_jsonb(m)%'")[0][0]==0:break
            time.sleep(.05)
        else:raise AssertionError('mapping cancellation left active SQL')
    finally:client.close();lock.rollback();lock.close()
    assert page(owner)[0]==200 and before==fingerprint()
    ok('single blocked TLS list cancels SQL and returns read slot; retry200 and source unchanged; no sustained load')
    def decision(mid,action='confirmed',who=driver,revision=None):
        rev=sql('SELECT revision FROM location_subject_mappings WHERE id=%s',(mid,))[0][0] if revision is None else revision
        return t.call('POST',f'/privacy/subject-mappings/{mid}/decision',dict(action=action,revision=rev,consent_version='fleet-subject-v1'),who)
    # Reach the old row, then use its exact revision for real correction.
    old=page(owner,{'before':root+1,'limit':50})[1]['items'][0];assert old['id']==root
    assert decision(root)[0]==200
    sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',%s,37.135,127.135,true)",(did,uid,begin+timedelta(minutes=1)))
    assert t.call('GET',f'{ROUTE}/{root}/locations',who=owner)[0]==200
    payload=proposal(root,'correction')
    status,child,_=t.call('POST',ROUTE,payload,owner);assert status==200,(status,child)
    child=child['id']
    assert t.call('POST',ROUTE,payload,owner)[1]['id']==child
    assert t.call('POST',ROUTE,{**payload,'request_key':str(uuid.uuid4())},owner)[0]==409
    assert t.call('GET',f'{ROUTE}/{root}/locations',who=owner)[0]==404
    assert t.call('GET',f'{ROUTE}/{child}/locations',who=owner)[0]==404
    filtered=page(owner,{'status':'superseded','limit':200})[1]['items']
    assert next(x for x in filtered if x['id']==root)['has_successor']
    assert decision(child,who=other)[0]==404 and decision(child,revision=99)[0]==409
    assert decision(child)[0]==200
    status,locations,_=t.call('GET',f'{ROUTE}/{child}/locations',who=owner);assert status==200 and len(locations['items'])==1
    ok('old-page correction uses owned historical binding; old access stops immediately; duplicate/stale guards; exact subject fresh consent required')
    assert decision(child,'revoked')[0]==200
    assert t.call('GET',f'{ROUTE}/{child}/locations',who=owner)[0]==404
    assert t.call('POST',ROUTE,proposal(child,'correction'),owner)[0]==409
    status,renewed,_=t.call('POST',ROUTE,proposal(child,'reconsent'),owner);assert status==200
    renewed=renewed['id'];assert t.call('GET',f'{ROUTE}/{renewed}/locations',who=owner)[0]==404
    assert decision(renewed)[0]==200
    assert t.call('GET',f'{ROUTE}/{renewed}/locations',who=owner)[0]==200
    assert all(x['owner_id']==uid for x in page(admin,{'status':'confirmed'},uid)[1]['items'])
    notices=t.call('GET','/privacy/provision-notices',who=driver)[1]['items'];assert len(notices)==3
    assert t.call('GET','/privacy/provision-notices',who=other)[1]['items']==[]
    sql('DELETE FROM fleet_staff_accounts WHERE owner_id=%s AND staff_id=%s',(uid,sid))
    assert next(x for x in page(owner,{'status':'confirmed'})[1]['items'] if x['id']==renewed)['effective'] is False
    assert t.call('GET',f'{ROUTE}/{renewed}/locations',who=owner)[0]==404
    ok('withdrawal cannot be corrected away; exact reconsent required; three scoped provision notices retained; staff unlink marks ineffective and blocks locations')
    t.start(False) # The helper restarts with subjects OFF inside the fixture.
    status,data,_=page(owner,{'status':'confirmed','limit':50});assert status==200 and data['enabled'] is False
    assert decision(renewed,'revoked')[0]==200 and decision(root,revision=0)[0]==409
    assert next(x for x in page(owner,{'status':'revoked','limit':200})[1]['items'] if x['id']==renewed)['effective'] is False
    ok('feature OFF retains historical list and existing subject withdrawal; no consent auto-restoration or new proposal enablement')
    t.stop_api()
    evidence=dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),schema=114,passed=passed,
        api_sha256=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest(),fixture=dict(accounts=6,initial_mappings=207,bindings=206,page_lengths=lengths),
        read_only_source_hashes=before,db_role_report=roles,production_accessed=False,sustained_load_executed=False,
        environment='internal TLS1.2; PostgreSQL14/Timescale; separated gps_runtime; synthetic only')
    (ROOT/'out/functional135.json').write_text(json.dumps(evidence,indent=2)+'\n')
    print('PASS all',len(passed),'functional groups',flush=True)

if __name__=='__main__':main()
