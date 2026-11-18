"""Personal mappings/notices functional fixtures; internal synthetic TLS only."""
import base64,hashlib,hmac,json,os,time,uuid,subprocess
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import urlencode
import psycopg2
import test_unattributed132 as t
ROOT,sql=t.ROOT,t.sql
MAP='/privacy/subject-mappings'
NOTICE='/privacy/provision-notices'
passed=[]
def ok(text):passed.append(text);print('PASS '+text,flush=True)
def get(route,who,params=None,extra=None):return t.call('GET',route+'?'+urlencode(params or {}),who=who,extra=extra)
def ids(result):return [r['id'] for r in result['items']]
def fingerprint():
 return {name:sql(f"SELECT md5(coalesce(string_agg(to_jsonb(x)::text,',' ORDER BY to_jsonb(x)::text),'')) FROM {name} x")[0][0] for name in ('location_subject_mappings','location_subject_actions','location_provision_notices','location_notice_attempts')}
def main():
    t.migrate('migration140',t.DSN)
    ring=json.dumps({'active':'synthetic140','keys':{'synthetic140':base64.b64encode(os.urandom(32)).decode()}})
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
    owner,driver,other=[t.account(n) for n in range(3)]
    uid,subject=owner['user_id'],driver['user_id']
    sid=sql("INSERT INTO staff(user_id,name,active) VALUES(%s,'Synthetic140',true) RETURNING id",(uid,))[0][0]
    sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(uid,sid,subject))
    did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'synthetic140','') RETURNING id",(uid,))[0][0]
    vid=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'Synthetic140 vehicle') RETURNING id",(uid,))[0][0]
    begin=datetime.now(timezone.utc)-timedelta(days=10)
    binding=sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at) VALUES(%s,%s,%s,'Synthetic140',%s) RETURNING id",(uid,vid,did,begin))[0][0]
    mapping_ids=[r[0] for r in sql("""INSERT INTO location_subject_mappings(request_key,owner_id,subject_id,proposed_by,staff_id,vehicle_id,binding_id,device_id,starts_at,ends_at,status)
      SELECT gen_random_uuid(),%s,%s,%s,%s,%s,%s,%s,%s::timestamptz+n*interval '1 hour',%s::timestamptz+n*interval '1 hour'+interval '30 min',
      CASE n%%5 WHEN 1 THEN 'pending' WHEN 2 THEN 'confirmed' WHEN 3 THEN 'rejected' WHEN 4 THEN 'revoked' ELSE 'superseded' END
      FROM generate_series(1,207) n RETURNING id""",(uid,subject,uid,sid,vid,binding,did,begin,begin))]
    foreign_map=sql("INSERT INTO location_subject_mappings(request_key,owner_id,subject_id,proposed_by,staff_id,vehicle_id,binding_id,device_id,starts_at,ends_at) VALUES(gen_random_uuid(),%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",(uid,other['user_id'],uid,sid,vid,binding,did,begin,begin+timedelta(minutes=30)))[0][0]
    notice_ids=[r[0] for r in sql("""INSERT INTO location_provision_notices(event_id,mapping_id,subject_id,owner_id,actor_id,device_id,vehicle_id,purpose,consent_version,policy_reference,range_from,range_until,started_at,delivery,read_at)
      SELECT n,%s,%s,%s,%s,%s,%s,'fleet_operations','fleet-subject-v1','synthetic140',%s,%s,%s,
      CASE WHEN n=1 THEN 'review' WHEN n=108 THEN 'waiting' WHEN n=109 THEN 'not_provided' ELSE 'provider_accepted' END,
      CASE WHEN n BETWEEN 101 AND 107 THEN now() ELSE NULL END FROM generate_series(1,109) n RETURNING id""",(mapping_ids[0],subject,uid,uid,did,vid,begin,begin+timedelta(minutes=30),begin))]
    foreign_notice=sql("INSERT INTO location_provision_notices(event_id,mapping_id,subject_id,owner_id,actor_id,device_id,vehicle_id,purpose,consent_version,policy_reference,range_from,range_until,started_at,delivery) VALUES(999,%s,%s,%s,%s,%s,%s,'fleet_operations','fleet-subject-v1','synthetic140',%s,%s,%s,'review') RETURNING id",(foreign_map,other['user_id'],uid,uid,did,vid,begin,begin+timedelta(minutes=30),begin))[0][0]
    before=fingerprint()
    lengths={}
    for route,expected,legacy in ((MAP,list(reversed(mapping_ids)),200),(NOTICE,list(reversed(notice_ids[:107])),100)):
        status,data,headers=get(route,driver);assert status==200,(status,data)
        assert len(data['items'])==legacy and data['next_before']==expected[legacy-1]
        all_ids=[];sizes=[];params={'limit':50}
        while True:
            status,data,headers=get(route,driver,params);assert status==200,(status,data)
            assert 'no-store' in {k.lower():v for k,v in headers.items()}['cache-control']
            assert all(r['subject_id']==subject for r in data['items'])
            if route==NOTICE:assert all('lease_id' not in r and 'lease_until' not in r for r in data['items'])
            all_ids+=ids(data);sizes.append(len(data['items']))
            if data['next_before'] is None:break
            params['before']=data['next_before']
        assert all_ids==expected
        lengths[route]=sizes
        assert get(route,None)[0]==401
        assert get(route,driver,extra={'X-Fleet-Owner':str(uid)})[0]==403
        assert get(route,owner)[1]['items']==[]
        assert get(route,other)[1]['items'][0]['subject_id']==other['user_id']
        token=driver['access_token'].split('.')
        claims=json.loads(base64.urlsafe_b64decode(token[1]+'='*((-len(token[1]))%4)));claims['act']=str(uid)
        token[1]=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
        token[2]=base64.urlsafe_b64encode(hmac.new(b'synthetic132-only','.'.join(token[:2]).encode(),hashlib.sha256).digest()).decode().rstrip('=')
        assert get(route,{'access_token':'.'.join(token)})[0]==403
    assert lengths[MAP]==[50,50,50,50,7] and lengths[NOTICE]==[50,50,7] and before==fingerprint()
    ok('207 mappings and107 visible notices traverse exactly; defaults200/100 remain; subject-only/no-store; owner, impersonation and fleet context cannot read for subject; GET changes no rows')
    for state in ('pending','confirmed','rejected','revoked','superseded'):
        expected=[r[0] for r in sql('SELECT id FROM location_subject_mappings WHERE subject_id=%s AND status=%s ORDER BY id DESC',(subject,state))]
        assert ids(get(MAP,driver,{'status':state})[1])==expected
    unread=get(NOTICE,driver,{'read_state':'unread'})[1];assert ids(unread)==list(reversed(notice_ids[:100])) and unread['next_before'] is None
    first=get(NOTICE,driver,{'read_state':'unread','limit':50})[1]
    last=get(NOTICE,driver,{'read_state':'unread','limit':50,'before':first['next_before']})[1]
    assert len(last['items'])==50 and last['next_before'] is None
    assert ids(get(NOTICE,driver,{'read_state':'read'})[1])==list(reversed(notice_ids[100:107]))
    for route in (MAP,NOTICE):
        for bad in ({'before':0},{'before':-1},{'before':'x'},{'limit':0},{'limit':201 if route==MAP else 101},{'subject_id':subject},{'owner_id':uid},{'status':'invalid'},{'read_state':'invalid'},{'read_state':'unread'} if route==MAP else {'status':'confirmed'}):
            assert get(route,driver,bad)[0]==400,(route,bad)
        assert get(route,driver,{'before':1})[1]['items']==[]
    assert before==fingerprint()
    ok('five mapping states and read/unread filters exact; full100/full50 final pages have no phantom cursor; invalid, cross-kind and identity-override parameters400; hidden delivery states excluded')
    for route,table in ((MAP,'location_subject_mappings'),(NOTICE,'location_provision_notices')):
        lock=psycopg2.connect(t.DSN);lock.autocommit=False
        with lock.cursor() as c:c.execute('LOCK TABLE '+table+' IN ACCESS EXCLUSIVE MODE')
        client=t.connection()
        pattern='%FROM '+table+'%'
        try:
            client.request('GET',t.BASE+route,headers=t.headers(driver))
            for _ in range(100):
                if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND wait_event_type='Lock' AND query LIKE %s",(pattern,))[0][0]==1:break
                time.sleep(.05)
            else:raise AssertionError('read did not reach held lock '+table)
            client.close()
            for _ in range(100):
                if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND state<>'idle' AND query LIKE %s",(pattern,))[0][0]==0:break
                time.sleep(.05)
            else:raise AssertionError('cancel left SQL '+table)
        finally:client.close();lock.rollback();lock.close()
        assert get(route,driver)[0]==200
    assert before==fingerprint()
    ok('one deliberately blocked request per endpoint cancels SQL on disconnect; retry200 and read slot released; no sustained load')
    sql("UPDATE location_subject_policy SET enabled=true,reference='synthetic140-policy',push_enabled=false")
    env=Path('/etc/gps121/api.env');t.secret(env,env.read_text().replace('GPS_SUBJECT_PROVISION=off','GPS_SUBJECT_PROVISION=on'))
    subprocess.run(['systemctl','restart','gps121-api'],check=True)
    for _ in range(100):
        try:
            if get(MAP,driver)[0]==200:break
        except OSError:pass
        time.sleep(.1)
    else:raise AssertionError('API not ready')
    def decision(mid,action='confirmed',who=driver,revision=0,version='fleet-subject-v1'):
        return t.call('POST',f'{MAP}/{mid}/decision',dict(action=action,revision=revision,consent_version=version),who)
    old=mapping_ids[0]
    assert old in ids(get(MAP,driver,{'before':mapping_ids[7],'limit':50})[1])
    assert decision(old,who=other)[0]==404 and decision(old,revision=99)[0]==409 and decision(old,version='old')[0]==400
    assert decision(old)[0]==200
    assert old not in ids(get(MAP,driver,{'status':'pending','before':mapping_ids[7]})[1])
    assert decision(old,'revoked',revision=0)[0]==409
    assert decision(old,'revoked',revision=1)[0]==200
    assert sql('SELECT count(*) FROM location_subject_effective WHERE id=%s',(old,))==[(0,)]
    assert decision(mapping_ids[5],'rejected')[0]==200
    ok('old-page fresh consent uses exact revision/version; foreign404 stale409 bad-version400; confirm/reject leave pending filter; withdrawal removes effective mapping')
    n=notice_ids[0]
    assert t.call('POST',f'{NOTICE}/{foreign_notice}/read',{},driver)[0]==404
    assert t.call('POST',f'{NOTICE}/{foreign_notice}/retry',{},driver)[0]==409
    assert t.call('POST',f'{NOTICE}/{notice_ids[107]}/read',{},driver)[0]==404
    assert t.call('POST',f'{NOTICE}/{n}/read',{},driver)[0]==200
    seen=sql('SELECT read_at FROM location_provision_notices WHERE id=%s',(n,))[0][0]
    assert t.call('POST',f'{NOTICE}/{n}/read',{},driver)[0]==200 and sql('SELECT read_at FROM location_provision_notices WHERE id=%s',(n,))[0][0]==seen
    assert n not in ids(get(NOTICE,driver,{'read_state':'unread'})[1])
    assert t.call('POST',f'{NOTICE}/{n}/retry',{},driver)[0]==200
    assert t.call('POST',f'{NOTICE}/{n}/retry',{},driver)[0]==409
    assert sql('SELECT delivery,attempts,read_at FROM location_provision_notices WHERE id=%s',(n,))==[('pending',0,seen)]
    assert sql("SELECT count(*) FROM location_notice_attempts WHERE notice_id=%s AND result='subject_retry_requested'",(n,))==[(1,)]
    ok('explicit acknowledgement idempotent and removes unread row; review-only retry records one attempt; foreign/hidden notices protected; provider acceptance never implies read')
    t.start(False)
    assert get(MAP,driver)[1]['enabled'] is False
    assert decision(mapping_ids[10])[0]==409
    assert decision(mapping_ids[1],'revoked')[0]==200
    assert sql('SELECT count(*) FROM location_subject_effective WHERE id=%s',(mapping_ids[1],))==[(0,)]
    assert get(NOTICE,driver)[0]==200
    ok('feature OFF retains historical reads and existing withdrawal; new consent409; no production policy changed')
    t.stop_api()
    assert sql('SELECT max(version) FROM _sqlx_migrations')==[(114,)]
    (ROOT/'out/functional140.json').write_text(json.dumps(dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),schema=114,passed=passed,
      api_sha256=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest(),fixture=dict(accounts=3,mappings=208,notices=110,page_lengths=lengths),
      read_only_hashes=before,db_role_report=roles,production_accessed=False,sustained_load_executed=False,
      environment='internal TLS1.2; PostgreSQL14/Timescale; separated gps_runtime; synthetic only'),indent=2)+'\n')
    print('PASS all',len(passed),'functional groups',flush=True)
if __name__=='__main__':main()
