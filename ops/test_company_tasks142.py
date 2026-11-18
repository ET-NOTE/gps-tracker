"""Round142 functional workflow in an internal synthetic TLS/runtime DB only."""
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
    t.migrate('migration142',t.DSN)
    ring=json.dumps({'active':'synthetic142','keys':{'synthetic142':base64.b64encode(os.urandom(32)).decode()}})
    t.secret(ROOT/'api-keyring.json',ring);os.chown(ROOT/'api-keyring.json',1000,1000)
    t.secret(ROOT/'mfa-key.txt',base64.b64encode(os.urandom(32)).decode())
    sql("SELECT set_config('gps.storage_keys',%s,false)",(ring,))
    sql('UPDATE location_storage_policy SET enabled=true,activated_at=now()')
    roles=t.separate(t.DSN,True,ROOT/'test-runtime.json')
    sql('GRANT CREATE ON TABLESPACE gps121_sort TO gps_runtime')
    sql("ALTER ROLE gps_runtime IN DATABASE gps_closure_test SET temp_tablespaces='gps121_sort'")
    for name in ('uploads','private'):
        p=ROOT/'test-storage'/name;p.mkdir(exist_ok=True);os.chown(p,1000,1000)
    t.start(True);t.tls()
    for _ in range(80):
        try:
            c=t.connection();c.request('GET','/gps-tracker/health');r=c.getresponse();r.read();c.close()
            if r.status==200:break
        except OSError:pass
        time.sleep(.1)
    else:raise AssertionError('TLS proxy not ready')
    officer,operator,handler,user,owner=[t.account(n) for n in range(5)]
    for who,role in ((officer,'officer'),(operator,'operator'),(handler,'handler')):
        sql("UPDATE users SET role='admin' WHERE id=%s",(who['user_id'],))
        sql("INSERT INTO admin_principals(user_id,role,allowed_cidrs) VALUES(%s,%s,ARRAY['127.0.0.1/32'])",(who['user_id'],role))
    status,parent,_=t.call('POST','/privacy/requests',dict(request_key=str(uuid.uuid4()),kind='access',scope='PRIVATE-REQUEST-SCOPE',password=t.PASSWORD),user);assert status==202
    rid=parent['id'];now=datetime.now(timezone.utc);start=now-timedelta(days=2);end=now-timedelta(days=1)
    staff=sql("INSERT INTO staff(user_id,name) VALUES(%s,'PRIVATE-NAME') RETURNING id",(owner['user_id'],))[0][0]
    def review(n):return sql("INSERT INTO privacy_company_reviews(request_id,company_owner_id,staff_id,category,from_at,until_at,status,identity,identity_evidence,internal_reason,due_at,updated_by) VALUES(%s,%s,%s,'files',%s,%s,'awaiting_company','confirmed','PRIVATE-IDENTITY','PRIVATE-REASON',%s,%s) RETURNING id",(rid,owner['user_id'],staff,start+timedelta(seconds=n),end+timedelta(seconds=n),now+timedelta(days=7),operator['user_id']))[0][0]
    scope,other_scope,empty_scope=[review(n) for n in range(3)]
    def task(review_id,n):return sql("INSERT INTO privacy_company_tasks(review_id,company_owner_id,instructions,status,expires_at,created_at,updated_by) VALUES(%s,%s,'PRIVATE-INSTRUCTIONS','revoked',%s,%s,%s) RETURNING id",(review_id,owner['user_id'],end, start,operator['user_id']))[0][0]
    tasks=[task(scope,n) for n in range(3)];foreign=task(other_scope,4)
    payload=b'%PDF-1.4\n% Synthetic142 sealed evidence\n%%EOF';sha=hashlib.sha256(payload).hexdigest()
    proof=sql("INSERT INTO privacy_company_submissions(task_id,actor_id,outcome,executed_at,affected_count,summary,evidence_reference,filename,mime,sha256,file_bytes) VALUES(%s,%s,'provided',%s,1,'PRIVATE-PROOF-SUMMARY','PRIVATE-REFERENCE','proof.pdf','application/pdf',%s,%s) RETURNING id",(tasks[0],owner['user_id'],end,sha,psycopg2.Binary(payload)))[0][0]
    actions=('published','submitted','downloaded','accepted','changes_requested','revoked')
    event_ids=[]
    for n in range(107):
        action='downloaded' if n<100 else ('published','submitted','accepted','changes_requested','revoked','published','submitted')[n-100]
        event_ids.append(sql("INSERT INTO privacy_company_task_events(task_id,actor_id,action,submission_id,detail,created_at) VALUES(%s,%s,%s,%s,%s,%s) RETURNING id",(tasks[n%3],owner['user_id'],action,proof if n%3==0 else None,sha if action=='downloaded' else 'Scoped synthetic decision',end+timedelta(seconds=n)))[0][0])
    sql("INSERT INTO privacy_company_task_events(task_id,actor_id,action,detail) VALUES(%s,%s,'revoked','FOREIGN-REVIEW')",(foreign,operator['user_id']))
    route=f'/admin/privacy/company-reviews/{scope}/task-events'
    template='/admin/privacy/company-reviews/:id/task-events'
    def read(who=operator,params=None,extra=None,target=scope):return t.call('GET',f'/admin/privacy/company-reviews/{target}/task-events?'+urlencode(params or {}),who=who,extra=extra)
    assert read(None)[0]==401 and read(user)[0]==403 and read(operator)[0]==403
    for who in (officer,operator,handler):t.enroll(who)
    assert read(handler)[0]==403 and read(officer)[0]==200 and read()[0]==200
    assert read(extra={'X-Fleet-Owner':str(owner['user_id'])})[0]==403
    ok('admin security ON: anonymous/user/unverified admin/handler/delegation denied; enrolled officer and operator allowed')
    before=fingerprint();collected=[];lengths=[];params={}
    allowed={'id','task_id','actor_id','action','submission_id','detail','created_at'}
    while True:
        status,data,headers=read(params=params);assert status==200,(status,data)
        assert 'no-store' in {k.lower():v for k,v in headers.items()}['cache-control']
        assert all(set(e)==allowed for e in data['items']) and 'PRIVATE-' not in json.dumps(data) and 'FOREIGN-REVIEW' not in json.dumps(data)
        collected+=ids(data);lengths.append(len(data['items']))
        if data['next'] is None:break
        params={'before':data['next']}
    assert collected==event_ids[::-1] and lengths==[50,50,7] and before==fingerprint()
    assert sql('SELECT count(*),count(file_bytes),count(file_bytes_sealed) FROM privacy_company_submissions')==[(1,0,1)]
    ok('107 historical events traverse50/50/7 exactly, strict metadata/no-store, sealed proof excluded, other review excluded, source/evidence hashes unchanged')
    for action in actions:
        for tid in tasks:
            actual=read(params={'action':action,'task_id':tid})[1]
            expected=[r[0] for r in sql('SELECT id FROM privacy_company_task_events WHERE task_id=%s AND action=%s ORDER BY id DESC',(tid,action))]
            assert ids(actual)==expected
    first=read(params={'action':'downloaded'})[1];last=read(params={'action':'downloaded','before':first['next']})[1]
    assert len(first['items'])==len(last['items'])==50 and last['next'] is None
    for bad in ({'before':0},{'before':-1},{'before':'abc'},{'task_id':0},{'task_id':-1},{'action':''},{'action':'invalid'},{'review_id':other_scope},{'limit':500}):assert read(params=bad)[0]==400,bad
    assert read(params={'task_id':foreign})[1]['items']==[]
    assert read(target=empty_scope)[1]=={'items':[],'next':None} and read(target=99999999)[0]==404
    assert before==fingerprint()
    ok('18 action/task combinations; exact100 response events end after50/50; invalid conditions400, foreign task empty, unknown review404')
    # Metadata browsing must not stand in for a proof download or rewrite history.
    assert sql("SELECT count(*) FROM privacy_company_task_events WHERE actor_id=%s AND action='downloaded'",(operator['user_id'],))==[(0,)]
    assert sql("SELECT count(*) FROM admin_security_events WHERE route=%s AND action='access' AND outcome='authorized'",(template,))[0][0]>0
    assert sql("SELECT count(*) FROM admin_security_events WHERE route=%s AND action='response' AND outcome='ready'",(template,))[0][0]>0
    sql("CREATE FUNCTION synthetic142_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.route='/admin/privacy/company-reviews/:id/task-events' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$")
    sql('CREATE TRIGGER synthetic142_failure BEFORE INSERT ON admin_security_events FOR EACH ROW EXECUTE FUNCTION synthetic142_audit_failure()')
    assert read()[0]==500
    sql('DROP TRIGGER synthetic142_failure ON admin_security_events');sql('DROP FUNCTION synthetic142_audit_failure()')
    assert read()[0]==200 and before==fingerprint()
    ok('history GET leaves admin access/response evidence, never creates proof-download attestation; audit-write failure fails closed and recovers')
    lock=psycopg2.connect(t.DSN);lock.autocommit=False
    with lock.cursor() as c:c.execute('LOCK TABLE privacy_company_task_events IN ACCESS EXCLUSIVE MODE')
    client=t.connection();pattern='%FROM privacy_company_task_events e JOIN privacy_company_tasks t%'
    try:
        client.request('GET',t.BASE+route,headers=t.headers(operator))
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND wait_event_type='Lock' AND query LIKE %s",(pattern,))[0][0]==1:break
            time.sleep(.05)
        else:raise AssertionError('history query did not reach held SQL lock')
        client.close()
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND state<>'idle' AND query LIKE %s",(pattern,))[0][0]==0:break
            time.sleep(.05)
        else:raise AssertionError('cancel left history SQL running')
    finally:client.close();lock.rollback();lock.close()
    assert read()[0]==200 and before==fingerprint()
    ok('one blocked history SELECT cancelled by TLS disconnect, SQL ends and next read200; no sustained/concurrent load')
    sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['203.0.113.9/32'] WHERE user_id=%s",(operator['user_id'],))
    assert read(extra={'X-Real-IP':'203.0.113.9','X-Forwarded-For':'203.0.113.9'})[0]==403
    sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['127.0.0.1/32'],enabled=false WHERE user_id=%s",(operator['user_id'],));assert read()[0]==403
    sql('UPDATE admin_principals SET enabled=true WHERE user_id=%s',(operator['user_id'],));assert read()[0]==200
    sql('UPDATE admin_sessions SET revoked_at=now() WHERE user_id=%s',(operator['user_id'],));assert read()[0]==403
    assert read(officer)[0]==200 and before==fingerprint()
    ok('IP restriction ignores spoofed forwarding, disabled principal and revoked step-up session deny saved endpoint without changing evidence')
    legacy=t.call('GET',f'/admin/privacy/company-reviews/{scope}/tasks',who=officer)
    assert legacy[0]==200 and len(legacy[1]['events'])==100 and [e['id'] for e in legacy[1]['events']]==event_ids[::-1][:100]
    rev=sql('SELECT revision FROM privacy_requests WHERE id=%s',(rid,))[0][0]
    assert t.call('POST',f'/privacy/requests/{rid}/cancel',dict(revision=rev),user)[0]==200
    closed=fingerprint();assert len(read(officer)[1]['items'])==50 and closed==fingerprint()
    assert sql('SELECT max(version) FROM _sqlx_migrations')==[(114,)]
    ok('legacy latest100 API unchanged; revoked/expired tasks and cancelled parent remain auditable by authorized admin; schema114 and immutable evidence preserved')
    t.stop_api()
    (ROOT/'out/functional142.json').write_text(json.dumps(dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),passed=passed,schema=114,
      api_sha256=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest(),fixture=dict(accounts=5,events=107,foreign_events=1,tasks=3,page_lengths=lengths,sealed_proofs=1),
      read_only_hashes=before,db_role_report=roles,production_accessed=False,sustained_load_executed=False,
      environment='internal TLS1.2; PostgreSQL14/Timescale; separated gps_runtime; encryption ON; admin security ON with TOTP and IP'),indent=2)+'\n')
    print('PASS all',len(passed),'functional groups',flush=True)
if __name__=='__main__':main()
