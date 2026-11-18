"""Round141 functional workflow in an internal synthetic TLS/runtime DB only."""
import base64,hashlib,json,os,time,uuid
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import urlencode
import psycopg2
import test_unattributed132 as t
ROOT,sql=t.ROOT,t.sql
INBOX='/privacy/company-tasks'
passed=[]
def ok(value):passed.append(value);print('PASS '+value,flush=True)
def get(who,params=None,extra=None):return t.call('GET',INBOX+'?'+urlencode(params or {}),who=who,extra=extra)
def ids(data):return [r['id'] for r in data['items']]
def fingerprint():
 return {name:sql(f"SELECT md5(coalesce(string_agg(to_jsonb(x)::text,',' ORDER BY to_jsonb(x)::text),'')) FROM {name} x")[0][0] for name in ('privacy_requests','privacy_company_reviews','privacy_company_tasks','privacy_company_submissions','privacy_company_task_events')}
def main():
    t.migrate('migration141',t.DSN)
    ring=json.dumps({'active':'synthetic141','keys':{'synthetic141':base64.b64encode(os.urandom(32)).decode()}})
    t.secret(ROOT/'api-keyring.json',ring);os.chown(ROOT/'api-keyring.json',1000,1000)
    t.secret(ROOT/'mfa-key.txt',base64.b64encode(os.urandom(32)).decode())
    sql("SELECT set_config('gps.storage_keys',%s,false)",(ring,))
    sql('UPDATE location_storage_policy SET enabled=true,activated_at=now()')
    roles=t.separate(t.DSN,True,ROOT/'test-runtime.json')
    sql('GRANT CREATE ON TABLESPACE gps121_sort TO gps_runtime')
    sql("ALTER ROLE gps_runtime IN DATABASE gps_closure_test SET temp_tablespaces='gps121_sort'")
    for name in ('uploads','private'):
        p=ROOT/'test-storage'/name;p.mkdir(exist_ok=True);os.chown(p,1000,1000)
    t.start(False);t.tls()
    for _ in range(80):
        try:
            c=t.connection();c.request('GET','/gps-tracker/health');r=c.getresponse();r.read();c.close()
            if r.status==200:break
        except OSError:pass
        time.sleep(.1)
    else:raise AssertionError('TLS proxy not ready')
    subject,owner,other,admin=[t.account(n) for n in range(4)]
    uid,oid=subject['user_id'],owner['user_id']
    sql("UPDATE users SET role='admin' WHERE id=%s",(admin['user_id'],))
    staff=sql("INSERT INTO staff(user_id,name) VALUES(%s,'PRIVATE-NAME') RETURNING id",(oid,))[0][0]
    sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(oid,staff,uid))
    status,parent,_=t.call('POST','/privacy/requests',dict(request_key=str(uuid.uuid4()),kind='access',scope='PRIVATE-SCOPE',password=t.PASSWORD),subject);assert status==202,(status,parent)
    rid=parent['id'];now=datetime.now(timezone.utc);due=now+timedelta(days=7);start=now-timedelta(days=2);end=start+timedelta(days=1)
    reviews=[];tasks=[]
    categories=('staff','trips','reservations','expenses','files','snapshots')
    def fixture(n,company=oid,identity='confirmed',state='requested',expired=False):
        rev=sql("INSERT INTO privacy_company_reviews(request_id,company_owner_id,staff_id,category,from_at,until_at,status,identity,identity_evidence,internal_reason,due_at,updated_by) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,'PRIVATE-IDENTITY','PRIVATE-REASON',%s,%s) RETURNING id",(rid,company,staff,categories[n%6],start+timedelta(seconds=n),end+timedelta(seconds=n),'awaiting_company' if identity=='confirmed' else 'identity_pending',identity,due,admin['user_id']))[0][0]
        tid=sql("INSERT INTO privacy_company_tasks(review_id,company_owner_id,instructions,status,expires_at,created_at,updated_by) VALUES(%s,%s,'Scoped synthetic instruction',%s,%s,%s,%s) RETURNING id",(rev,company,state,now-timedelta(days=1) if expired else due,now-timedelta(days=2) if expired else now,admin['user_id']))[0][0]
        return tid,rev
    for n in range(107):
        tid,rev=fixture(n,state='requested' if n<100 else ('submitted','changes_requested','accepted')[n%3]);tasks.append(tid);reviews.append(rev)
    expired,_=fixture(108,expired=True);revoked,_=fixture(109,state='revoked');unconfirmed,_=fixture(110,identity='pending');foreign,_=fixture(111,company=other['user_id'])
    before=fingerprint();collected=[];lengths=[];params={}
    allowed={'id','revision','status','instructions','feedback','created_at','expires_at','staff_id','category','from_at','until_at','kind'}
    while True:
        status,data,headers=get(owner,params);assert status==200,(status,data)
        assert 'no-store' in {k.lower():v for k,v in headers.items()}['cache-control']
        assert all(set(r)==allowed for r in data['items'])
        assert 'PRIVATE' not in json.dumps(data)
        collected+=ids(data);lengths.append(len(data['items']))
        if data['next'] is None:break
        params={'after':data['next']}
    assert collected==tasks and lengths==[50,50,7] and before==fingerprint()
    assert get(None)[0]==401 and get(subject)[1]['items']==[] and ids(get(other)[1])==[foreign]
    assert get(subject,extra={'X-Fleet-Owner':str(oid)})[0]==403
    ok('107 available tasks traverse50/50/7 in publication order; strict projection/no-store; owner-only; expired/revoked/unconfirmed/foreign excluded; GET writes nothing')
    for state in ('requested','submitted','changes_requested','accepted'):
        for category in categories:
            actual=get(owner,{'status':state,'category':category})[1]
            expected=[v[0] for v in sql("SELECT t.id FROM privacy_company_tasks t JOIN privacy_company_reviews c ON c.id=t.review_id WHERE t.id=ANY(%s) AND t.status=%s AND c.category=%s ORDER BY t.id",(tasks,state,category))]
            assert ids(actual)==expected
    first=get(owner,{'status':'requested'})[1];last=get(owner,{'status':'requested','after':first['next']})[1]
    assert len(last['items'])==50 and last['next'] is None
    for bad in ({'after':-1},{'after':'bad'},{'status':'revoked'},{'status':''},{'category':'bad'},{'owner_id':oid},{'limit':100}):assert get(owner,bad)[0]==400,bad
    assert get(owner,{'after':999999})[1]['items']==[] and before==fingerprint()
    ok('24 status/category combinations, exact100 filtered final cursor, legacy after0, invalid/identity override400 and empty page verified')
    lock=psycopg2.connect(t.DSN);lock.autocommit=False
    with lock.cursor() as c:c.execute('LOCK TABLE privacy_company_tasks IN ACCESS EXCLUSIVE MODE')
    client=t.connection()
    try:
        client.request('GET',t.BASE+INBOX,headers=t.headers(owner))
        pattern='%FROM privacy_company_tasks t JOIN privacy_company_reviews%'
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND wait_event_type='Lock' AND query LIKE %s",(pattern,))[0][0]==1:break
            time.sleep(.05)
        else:raise AssertionError('inbox did not reach held SQL lock')
        client.close()
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND state<>'idle' AND query LIKE %s",(pattern,))[0][0]==0:break
            time.sleep(.05)
        else:raise AssertionError('cancel left SQL running')
    finally:client.close();lock.rollback();lock.close()
    assert get(owner)[0]==200 and before==fingerprint()
    ok('one held inbox read cancelled over TLS; SQL ended, next request200, no mutation and no sustained load')
    target=tasks[98];review=reviews[98];path=f'{INBOX}/{target}'
    def task():return t.call('GET',path,who=owner)[1]['task']
    def revisions():return sql('SELECT r.revision,c.revision,t.revision FROM privacy_company_tasks t JOIN privacy_company_reviews c ON c.id=t.review_id JOIN privacy_requests r ON r.id=c.request_id WHERE t.id=%s',(target,))[0]
    def readproof(sid,who=admin):
        c=t.connection()
        try:
            c.request('POST',t.BASE+('/admin' if who is admin else '')+path+f'/proof/{sid}',headers=t.headers(who));r=c.getresponse();raw=r.read();return r.status,raw,dict(r.getheaders())
        finally:c.close()
    payload=b'%PDF-1.4\n% Synthetic141 evidence, no real personal data\n%%EOF'
    def body():return dict(revision=revisions()[2],outcome='provided',executed_at=(datetime.now(timezone.utc)-timedelta(minutes=1)).isoformat(),affected_count=1,summary='Synthetic scoped transfer',evidence_reference='TEST-141',filename='proof.pdf',mime='application/pdf',file_base64=base64.b64encode(payload).decode(),confirmed=True)
    assert target in ids(get(owner,{'after':tasks[49]})[1])
    for who in (subject,other):assert t.call('GET',path,who=who)[0]==404 and t.call('POST',path,body(),who)[0]==404
    assert t.call('GET',path,who=owner,extra={'X-Fleet-Owner':str(oid)})[0]==403
    assert t.call('POST',path,{**body(),'confirmed':False},owner)[0]==400
    assert t.call('POST',path,{**body(),'revision':999},owner)[0]==409
    status,proof1,_=t.call('POST',path,body(),owner);assert status==200,(status,proof1)
    assert task()['status']=='submitted'
    assert target not in ids(get(owner,{'after':tasks[49],'status':'requested'})[1])
    assert t.call('POST',path,body(),owner)[0]==409
    assert proof1['sha256']==hashlib.sha256(payload).hexdigest()
    assert sql('SELECT count(*),count(file_bytes),count(file_bytes_sealed) FROM privacy_company_submissions')==[(1,0,1)]
    ok('old page opens fresh detail; foreign404/delegation403/stale409/attestation400; submission leaves requested filter, does not auto-complete, file stored sealed')
    def decision(proof,accept=False,**overrides):
        rr,cr,tr=revisions();b=dict(request_revision=rr,review_revision=cr,revision=tr,submission_id=proof['id'],sha256=proof['sha256'],accept=accept,confirmed=True,feedback='Synthetic scope checked',public_message='Scoped review result');b.update(overrides)
        return t.call('POST',f'/admin/privacy/company-tasks/{target}/decision',b,admin)
    assert decision(proof1)[0]==409
    assert readproof(proof1['id'],owner)[1]==payload
    assert decision(proof1)[0]==409
    status,raw,headers=readproof(proof1['id']);assert status==200 and raw==payload
    assert decision(proof1,confirmed=False)[0]==400
    assert decision(proof1)[0]==200 and task()['status']=='changes_requested'
    assert target in ids(get(owner,{'status':'changes_requested'})[1])
    status,proof2,_=t.call('POST',path,body(),owner);assert status==200
    assert decision(proof1,True)[0]==409 and decision(proof2,True)[0]==409
    assert readproof(proof2['id'])[1]==payload
    assert decision(proof2,True)[0]==200 and task()['status']=='accepted'
    assert sql('SELECT status FROM privacy_requests WHERE id=%s',(rid,))==[('received',)]
    assert sql('SELECT status,evidence_reference FROM privacy_company_reviews WHERE id=%s',(review,))==[('verified',f"company-task:{target}/submission:{proof2['id']}")]
    ok('operator must download exact latest proof and attest; company download insufficient; changes requested/resubmit/new proof/accept preserves whole-request status and immutable earlier submission')
    rr,_,tr=revisions()
    assert t.call('POST',f'/admin/privacy/company-tasks/{target}/revoke',dict(request_revision=rr,revision=tr,reason='Synthetic re-scope'),admin)[0]==200
    assert t.call('GET',path,who=owner)[0]==409 and t.call('POST',path,body(),owner)[0]==409 and readproof(proof2['id'],owner)[0]==409
    assert readproof(proof2['id'])[1]==payload and target not in ids(get(owner,{'after':tasks[49]})[1])
    for tid in (expired,unconfirmed):assert t.call('GET',f'{INBOX}/{tid}',who=owner)[0]==409
    # Cancel the open personal request through its existing endpoint. All other
    # tasks for that request become unavailable without deleting evidence.
    current=sql('SELECT revision FROM privacy_requests WHERE id=%s',(rid,))[0][0]
    assert t.call('POST',f'/privacy/requests/{rid}/cancel',dict(revision=current),subject)[0]==200
    assert get(owner)[1]['items']==[] and t.call('GET',f'{INBOX}/{tasks[0]}',who=owner)[0]==409
    assert readproof(proof2['id'])[1]==payload
    ok('revoke/expiry/unconfirmed identity/cancelled parent deny company detail/submission/proof; reviewed evidence remains available to operator')
    final=fingerprint();sql('UPDATE privacy_account_controls SET restricted=true WHERE user_id=%s',(oid,))
    assert get(owner)[0] in (401,403) and t.call('GET',path,who=owner)[0] in (401,403)
    assert readproof(proof2['id'],owner)[0] in (401,403) and final==fingerprint()
    assert sql('SELECT count(*),count(file_bytes),count(file_bytes_sealed) FROM privacy_company_submissions')==[(2,0,2)]
    assert sql('SELECT max(version) FROM _sqlx_migrations')==[(114,)]
    ok('restricted company cannot use saved task/proof routes; evidence and parent history remain intact; schema114/no automatic erasure')
    t.stop_api()
    (ROOT/'out/functional141.json').write_text(json.dumps(dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),passed=passed,schema=114,
      api_sha256=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest(),fixture=dict(accounts=4,visible_tasks=107,excluded_tasks=4,page_lengths=lengths,proofs=2),
      read_only_hashes=before,db_role_report=roles,production_accessed=False,sustained_load_executed=False,
      environment='internal TLS1.2; PostgreSQL14/Timescale; separated gps_runtime; encryption ON; existing admin-security OFF for scoped workflow fixture'),indent=2)+'\n')
    print('PASS all',len(passed),'functional groups',flush=True)
if __name__=='__main__':main()
