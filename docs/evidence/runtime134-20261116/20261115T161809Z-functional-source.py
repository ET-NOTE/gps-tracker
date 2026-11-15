"""Owner-only public request history; small fixtures and functional checks only."""
import base64,hashlib,json,os,time,uuid
import psycopg2
from urllib.parse import urlencode
import test_unattributed132 as t
ROOT,sql=t.ROOT,t.sql
passed=[]
def ok(message):passed.append(message);print('PASS '+message,flush=True)
def history(who,rid,params=None):
    return t.call('GET',f'/privacy/requests/{rid}/history?'+urlencode(params or {}),who=who)
def fingerprint():
    return {name:sql(f"SELECT md5(coalesce(string_agg(to_jsonb(x)::text,',' ORDER BY id),'')) FROM {name} x")[0][0] for name in ('privacy_requests','privacy_request_events')}
def main():
    t.migrate('migration134',t.DSN)
    ring=json.dumps({'active':'synthetic134','keys':{'synthetic134':base64.b64encode(os.urandom(32)).decode()}})
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
    for who in (officer,operator,handler):t.enroll(who)
    created=[]
    for who in (user,other):
        status,row,_=t.call('POST','/privacy/requests',dict(request_key=str(uuid.uuid4()),kind='access',scope='Synthetic134 rights review',password=t.PASSWORD),who)
        assert status==202,(status,row)
        created.append(row['id'])
    rid,foreign=created
    assert history(None,rid)[0]==401
    for who,target in ((other,rid),(user,foreign),(operator,rid),(user,999999999)):
        result=history(who,target)
        assert result[0]==404,(who['user_id'],target,result[:2])
    status,data,headers=history(user,rid)
    assert status==200 and data['items'][0]['status']=='received' and data['through']==1
    assert t.call('GET',f'/privacy/requests/{rid}/history',who=user,extra={'X-Fleet-Owner':str(user['user_id'])})[0]==403
    assert 'no-store' in {k.lower():v for k,v in headers.items()}['cache-control']
    ok('real request creation; owner-only history, anonymous401 and foreign/missing/admin404; no-store')

    for revision,state,message,due in [(1,'in_review','확인 중입니다.','2026-11-20T00:00:00Z'),(2,'needs_information','대상 기간을 확인해 주세요.','2026-11-21T00:00:00Z'),(3,'rejected','대상 자료를 확인할 수 없습니다.',None)]:
        path=f'/admin/privacy/requests/{rid}'
        payload=dict(revision=revision,status=state,message=message,due_at=due,evidence_reference='INTERNAL-134-DO-NOT-EXPOSE')
        assert t.call('PATCH',path,payload,operator)[0]==409
        status,proposal,_=t.call('POST','/admin/security/approvals',dict(method='PATCH',path=path,payload=payload,reason='Synthetic134 reviewed request'),operator)
        assert status==200,(status,proposal)
        assert t.call('POST',f"/admin/security/approvals/{proposal['id']}/decision",{'approve':True},officer)[0]==200
        status,row,_=t.call('PATCH',path,payload,operator,{'X-Admin-Approval':str(proposal['id'])})
        assert status==200,(status,row)
    status,data,_=history(user,rid);assert status==200
    assert [x['status'] for x in data['items']]==['rejected','needs_information','in_review','received']
    assert data['items'][1]['message']=='대상 기간을 확인해 주세요.'
    assert data['items'][1]['due_at']=='2026-11-21T00:00:00+00:00'
    assert all(set(x)=={'revision','status','message','due_at','created_at'} for x in data['items'])
    assert set(data)=={'request_id','through','current_revision','items','next'}
    assert 'INTERNAL-134' not in json.dumps(data) and 'actor_id' not in json.dumps(data)
    admin=t.call('GET',f'/admin/privacy/requests/{rid}',who=operator)
    assert admin[0]==200 and admin[1]['events'][-1]['evidence_reference']=='INTERNAL-134-DO-NOT-EXPOSE'
    ok('real administrator review3 transitions after officer approval and operator execution; historical messages/deadlines; exact public projection excludes internal evidence and actor IDs')

    long_id=sql("INSERT INTO privacy_requests(user_id,request_key,kind,scope,status,revision) VALUES(%s,gen_random_uuid(),'rectification','Synthetic long history','cancelled',56) RETURNING id",(user['user_id'],))[0][0]
    sql("INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message,evidence_reference,due_at,created_at) SELECT %s,%s,n,'in_review','Synthetic public note '||n,'INTERNAL-SECRET-'||n,'2026-11-13T00:00:00Z','2026-11-10T00:00:00Z'::timestamptz+n*interval '1 minute' FROM generate_series(1,56) n",(long_id,operator['user_id']))
    before=fingerprint();found=[];lengths=[];params={}
    for _ in range(4):
        status,d,_=history(user,long_id,params);assert status==200
        assert d['through']==56
        found.extend(x['revision'] for x in d['items']);lengths.append(len(d['items']))
        if d['next'] is None:break
        params={'before':d['next'],'through':d['through']}
    assert found==list(range(56,0,-1)) and lengths==[25,25,6] and before==fingerprint()
    sql("UPDATE privacy_requests SET revision=57 WHERE id=%s",(long_id,))
    sql("INSERT INTO privacy_request_events(request_id,revision,status,message) VALUES(%s,57,'cancelled','Synthetic later update')",(long_id,))
    status,d,_=history(user,long_id,{'through':56});assert status==200 and d['current_revision']==57 and d['items'][0]['revision']==56
    assert history(user,long_id)[1]['items'][0]['revision']==57
    empty_id=sql("INSERT INTO privacy_requests(user_id,request_key,kind,scope,status) VALUES(%s,gen_random_uuid(),'rectification','Synthetic legacy without events','cancelled') RETURNING id",(user['user_id'],))[0][0]
    assert history(user,empty_id)[1]['items']==[]
    ok('56 historical revisions25/25/6 exact and read-only; frozen upper revision excludes later append; refresh sees57; legacy empty stays empty')

    for params in ({'before':0},{'through':-1},{'through':9999},{'before':2147483648},{'before':'bad'},{'user_id':other['user_id']},{'include_internal':'true'}):
        assert history(user,rid,params)[0]==400,params
    sql("INSERT INTO privacy_processing_controls(user_id,use_paused,provision_paused) VALUES(%s,true,true)",(user['user_id'],))
    assert history(user,rid)[0]==200
    before=fingerprint()
    ok('invalid/unknown/oversized cursors rejected; collection-use/provision controls do not prevent own rights history')

    lock=psycopg2.connect(t.DSN);lock.autocommit=False
    with lock.cursor() as c:c.execute('LOCK TABLE privacy_request_events IN ACCESS EXCLUSIVE MODE')
    client=t.connection()
    try:
        client.request('GET',t.BASE+f'/privacy/requests/{rid}/history',headers=t.headers(user))
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND wait_event_type='Lock' AND query LIKE 'SELECT r.revision,%'")[0][0]==1:break
            time.sleep(.05)
        else:raise AssertionError('history read did not reach lock')
        client.close()
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND state<>'idle' AND query LIKE 'SELECT r.revision,%'")[0][0]==0:break
            time.sleep(.05)
        else:raise AssertionError('history cancellation left active SQL')
    finally:client.close();lock.rollback();lock.close()
    assert history(user,rid)[0]==200 and before==fingerprint()
    ok('one blocked TLS history read cancels SQL and releases query capacity; retry200 and source hash unchanged; no sustained load')

    assert t.call('POST',f'/privacy/requests/{foreign}/cancel',{'revision':1},user)[0]==404
    assert t.call('POST',f'/privacy/requests/{foreign}/cancel',{'revision':1},other)[0]==200
    assert t.call('POST',f'/privacy/requests/{foreign}/cancel',{'revision':1},other)[0]==409
    assert [x['status'] for x in history(other,foreign)[1]['items']]==['cancelled','received']
    ok('owner cancellation adds exactly one public history transition; foreign denial and stale revision409 retained')

    sql('UPDATE privacy_account_controls SET restricted=true,restricted_at=now() WHERE user_id=%s',(user['user_id'],))
    assert history(user,rid)[0]==401
    status,result,_=t.call('POST','/privacy/result',dict(email='round132-3@example.invalid',password=t.PASSWORD,request_id=rid))
    assert status==200 and len(result['history'])==4 and result['account_restricted']
    assert 'INTERNAL-134' not in json.dumps(result) and 'actor_id' not in json.dumps(result)
    assert t.call('POST','/privacy/result',dict(email='round132-3@example.invalid',password='wrong',request_id=rid))[0]==401
    assert t.call('POST','/privacy/result',dict(email='round132-3@example.invalid',password=t.PASSWORD,request_id=foreign))[0]==401
    ok('restricted account session cannot query new route; existing password-only result portal retains scoped public history without session restoration')
    t.stop_api()
    evidence=dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),schema=114,passed=passed,
        api_sha256=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest(),
        fixture=dict(accounts=5,requests=4,history_page_lengths=lengths),read_only_source_hashes=before,
        environment='internal TLS1.2; PostgreSQL14/Timescale; separated gps_runtime; synthetic only',
        db_role_report=roles,production_accessed=False,sustained_load_executed=False)
    (ROOT/'out/functional134.json').write_text(json.dumps(evidence,indent=2)+'\n')
    print('PASS all',len(passed),'functional groups',flush=True)

if __name__=='__main__':main()
