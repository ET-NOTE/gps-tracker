"""Rights queue API functionality with115 small synthetic requests, no load run."""
import base64,hashlib,json,os,time
import psycopg2
from urllib.parse import urlencode
import test_unattributed132 as t

ROOT,sql=t.ROOT,t.sql
PRIVATE='/privacy/requests/page'
ADMIN='/admin/privacy/requests'
ASOF='2026-11-15T00:00:00Z'
passed=[]
def ok(message):passed.append(message);print('PASS '+message,flush=True)
def query(who,params=None,admin=False):
    return t.call('GET',(ADMIN if admin else PRIVATE)+'?'+urlencode(params or {}),who=who)
def snapshot():
    return {name:sql(f"SELECT md5(coalesce(string_agg(to_jsonb(x)::text,',' ORDER BY id),'')) FROM {name} x")[0][0]
            for name in ('privacy_requests','privacy_request_events')}

def main():
    t.migrate('migration133',t.DSN)
    ring=json.dumps({'active':'synthetic133','keys':{'synthetic133':base64.b64encode(os.urandom(32)).decode()}})
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
    officer,operator,handler,user,other=[t.account(n) for n in range(5)]
    for who,role in ((officer,'officer'),(operator,'operator'),(handler,'handler')):
        sql("UPDATE users SET role='admin' WHERE id=%s",(who['user_id'],))
        sql("INSERT INTO admin_principals(user_id,role,allowed_cidrs) VALUES(%s,%s,ARRAY['127.0.0.1/32'])",(who['user_id'],role))
    assert query(None)[0]==401 and query(user,admin=True)[0]==403 and query(operator,admin=True)[0]==403
    for who in (officer,operator,handler):t.enroll(who)
    assert query(handler,admin=True)[0]==403 and query(officer,admin=True)[0]==200
    ok('personal login and existing admin MFA/role boundary; handler and ordinary accounts denied global list')
    for who,count in ((user,106),(other,3)):
        sql("INSERT INTO privacy_requests(user_id,request_key,kind,scope,status,evidence_reference,due_at) SELECT %s,gen_random_uuid(),'access','Synthetic request '||n,'cancelled','INTERNAL-DO-NOT-EXPOSE','2026-10-01T00:00:00Z' FROM generate_series(1,%s) n",(who['user_id'],count))
    fixtures=[(user,'access','in_review','2026-11-14T23:59:59Z',operator),
              (user,'rectification','needs_information',None,None),
              (user,'erasure','in_review',ASOF,officer),
              (user,'account_closure','received','2026-11-16T00:00:00Z',None),
              (other,'access','received','2026-11-14T00:00:00Z',officer),
              (other,'rectification','in_review',None,operator)]
    ids=[]
    for who,kind,status,due,assigned in fixtures:
        ids.append(sql("INSERT INTO privacy_requests(user_id,request_key,kind,scope,status,due_at,assigned_to,evidence_reference) VALUES(%s,gen_random_uuid(),%s,'Synthetic workflow',%s,%s,%s,'INTERNAL-DO-NOT-EXPOSE') RETURNING id",(who['user_id'],kind,status,due,assigned['user_id'] if assigned else None))[0][0])
    before=snapshot();expected=[v[0] for v in sql('SELECT id FROM privacy_requests WHERE user_id=%s ORDER BY id DESC',(user['user_id'],))]
    found=[];params={};lengths=[]
    for _ in range(4):
        status,data,headers=query(user,params);assert status==200,(status,data)
        assert 'no-store' in {k.lower():v for k,v in headers.items()}['cache-control']
        assert 'INTERNAL-DO-NOT-EXPOSE' not in json.dumps(data) and 'evidence_reference' not in json.dumps(data)
        assert {x['user_id'] for x in data['items']}=={user['user_id']}
        found.extend(x['id'] for x in data['items']);lengths.append(len(data['items']))
        if not data['next']:break
        params={'before':data['next'],'as_of':data['as_of']}
    assert found==expected and lengths==[50,50,10]
    legacy=t.call('GET','/privacy/requests',who=user)
    assert legacy[0]==200 and isinstance(legacy[1],list) and len(legacy[1])==100
    assert [x['id'] for x in legacy[1]]==expected[:100]
    assert len(query(other)[1]['items'])==5
    assert len(query(user,{'kind':'rectification'})[1]['items'])==1
    assert all(x['status']=='cancelled' for x in query(user,{'status':'cancelled'})[1]['items'])
    ok('110 personal rows reached across50/50/10 pages with exact IDs; other-account exclusion; legacy100-array compatible; no internal evidence')
    def admin_ids(params):
        s,d,_=query(operator,{'as_of':ASOF,**params},True);assert s==200,(s,d)
        assert d['as_of']=='2026-11-15T00:00:00Z';return [x['id'] for x in d['items']]
    assert admin_ids({'due':'overdue'})==[ids[4],ids[0]]
    assert admin_ids({'due':'undated'})==[ids[5],ids[1]]
    assert admin_ids({'due':'overdue','assignment':'mine'})==[ids[0]]
    assert admin_ids({'due':'undated','assignment':'unassigned'})==[ids[1]]
    assert admin_ids({'assignment':'mine'})==[ids[5],ids[0]]
    assert admin_ids({'kind':'erasure','status':'in_review'})==[ids[2]]
    assert admin_ids({'due':'overdue','status':'cancelled'})==[]
    assert admin_ids({'due':'overdue','kind':'account_closure'})==[]
    s,d,_=query(officer,{'assignment':'mine'},True);assert s==200 and [x['id'] for x in d['items']]==[ids[4],ids[2]]
    all_admin=[];params={}
    for _ in range(4):
        s,d,_=query(operator,params,True);assert s==200
        all_admin.extend(x['id'] for x in d['items'])
        if d['next'] is None:break
        params={'before':d['next'],'as_of':d['as_of']}
    assert all_admin==[x[0] for x in sql('SELECT id FROM privacy_requests ORDER BY id DESC')]
    ok('admin kind/status/overdue/undated/mine/unassigned filters; exact due boundary and closed-request exclusion;115 rows paginated')
    for admin,who in ((False,user),(True,operator)):
        for bad in ({'before':0},{'before':-1},{'status':'bogus'},{'kind':'bogus'},{'due':'bogus'},{'assignment':'bogus'},{'user_id':other['user_id']},{'as_of':'bad-date'}):
            assert query(who,bad,admin)[0]==400,bad
    for bad in ({'due':'overdue'},{'assignment':'mine'}):assert query(user,bad)[0]==400
    sql("INSERT INTO privacy_processing_controls(user_id,use_paused,provision_paused) VALUES(%s,true,true)",(user['user_id'],))
    assert query(user)[0]==200
    sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['203.0.113.9/32'] WHERE user_id=%s",(operator['user_id'],))
    assert query(operator,admin=True)[0]==403
    sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['127.0.0.1/32'] WHERE user_id=%s",(operator['user_id'],))
    assert before==snapshot()
    ok('invalid/owner override filters rejected; processing pause still permits personal rights lookup; IP restriction retained; source rows unchanged')
    lock=psycopg2.connect(t.DSN);lock.autocommit=False
    with lock.cursor() as c:c.execute('LOCK TABLE privacy_requests IN ACCESS EXCLUSIVE MODE')
    client=t.connection()
    try:
        client.request('GET',t.BASE+PRIVATE,headers=t.headers(user))
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM privacy_requests%'")[0][0]==1:break
            time.sleep(.05)
        else:raise AssertionError('read did not reach lock')
        client.close()
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND state<>'idle' AND query LIKE 'SELECT * FROM privacy_requests%'")[0][0]==0:break
            time.sleep(.05)
        else:raise AssertionError('cancel left active SQL')
    finally:client.close();lock.rollback();lock.close()
    assert query(user)[0]==200 and before==snapshot()
    ok('single blocked TLS read cancels SQL and releases slot; retry succeeds; immutable requests/events')
    # Existing mutation semantics still work from an older-page request ID.
    assert t.call('POST',f'/privacy/requests/{ids[0]}/cancel',{'revision':1},other)[0]==404
    status,value,_=t.call('POST',f'/privacy/requests/{ids[0]}/cancel',{'revision':1},user)
    assert status==200 and value['status']=='cancelled' and value['revision']==2
    assert t.call('POST',f'/privacy/requests/{ids[0]}/cancel',{'revision':1},user)[0]==409
    assert admin_ids({'due':'overdue','assignment':'mine'})==[]
    assert sql('SELECT count(*) FROM privacy_request_events WHERE request_id=%s',(ids[0],))==[(1,)]
    assert sql("SELECT count(*) FROM admin_security_events WHERE route='/admin/privacy/requests' AND action='access'")[0][0]>0
    ok('owner-only request cancellation, stale revision409 and single history row; refreshed admin filter removes completed work')
    t.stop_api()
    evidence=dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),schema=114,passed=passed,
        api_sha256=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest(),
        fixture=dict(accounts=5,requests=115,personal_page_lengths=lengths),read_only_source_hashes=before,
        environment='internal TLS1.2; PostgreSQL14/Timescale; separated gps_runtime; synthetic only',
        db_role_report=roles,production_accessed=False,sustained_load_executed=False)
    (ROOT/'out/functional133.json').write_text(json.dumps(evidence,indent=2)+'\n')
    print('PASS all',len(passed),'functional groups',flush=True)

if __name__=='__main__':main()
