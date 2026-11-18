"""Round143 functional workflow in an internal synthetic TLS/runtime DB only."""
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
 return {name:sql(f"SELECT md5(coalesce(string_agg(to_jsonb(x)::text,',' ORDER BY to_jsonb(x)::text),'')) FROM {name} x")[0][0] for name in ('privacy_requests','privacy_company_reviews','privacy_company_link_history','staff','fleet_staff_accounts')}
def main():
    t.migrate('migration143',t.DSN)
    ring=json.dumps({'active':'synthetic143','keys':{'synthetic143':base64.b64encode(os.urandom(32)).decode()}})
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
    officer,operator,handler,user,owner,other_owner,other_user=[t.account(n) for n in range(7)]
    for who,role in ((officer,'officer'),(operator,'operator'),(handler,'handler')):
        sql("UPDATE users SET role='admin' WHERE id=%s",(who['user_id'],))
        sql("INSERT INTO admin_principals(user_id,role,allowed_cidrs) VALUES(%s,%s,ARRAY['127.0.0.1/32'])",(who['user_id'],role))
    status,parent,_=t.call('POST','/privacy/requests',dict(request_key=str(uuid.uuid4()),kind='access',scope='PRIVATE-REQUEST-SCOPE',password=t.PASSWORD),user);assert status==202
    status,other_parent,_=t.call('POST','/privacy/requests',dict(request_key=str(uuid.uuid4()),kind='access',scope='OTHER-SUBJECT',password=t.PASSWORD),other_user);assert status==202
    rid=parent['id'];now=datetime.now(timezone.utc);start=now-timedelta(days=2);end=now-timedelta(days=1)
    for who,name in ((owner,'Archive 100%_ Company'),(other_owner,'합성 회사')):
        sql('INSERT INTO corporate_info(user_id,company_name) VALUES(%s,%s)',(who['user_id'],name))
    pairs=[]
    # Interleaved staff IDs exercise the (company, staff) ordering boundary.
    for n in range(107):
        cid=(owner if n%2==0 else other_owner)['user_id']
        sid=sql("INSERT INTO staff(user_id,name) VALUES(%s,'PRIVATE-NAME') RETURNING id",(cid,))[0][0]
        pairs.append((cid,sid))
        sql("INSERT INTO privacy_company_link_history(subject_id,company_owner_id,staff_id,action,effective_at,captured_at) VALUES(%s,%s,%s,'unlinked',%s,%s)",(user['user_id'],cid,sid,end,end))
        if n<2:sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(cid,sid,user['user_id']))
    # A history-only pair remains useful after current staff ownership changes.
    archived=pairs[-1]
    sql('UPDATE staff SET user_id=%s WHERE id=%s',(other_owner['user_id'],archived[1]))
    foreign=sql("INSERT INTO staff(user_id,name) VALUES(%s,'FOREIGN-NAME') RETURNING id",(owner['user_id'],))[0][0]
    sql("INSERT INTO privacy_company_link_history(subject_id,company_owner_id,staff_id,action,effective_at) VALUES(%s,%s,%s,'observed',now())",(other_user['user_id'],owner['user_id'],foreign))
    route=f'/admin/privacy/requests/{rid}/company-candidates';template='/admin/privacy/requests/:id/company-candidates'
    def read(who=operator,params=None,extra=None,target=rid):return t.call('GET',f'/admin/privacy/requests/{target}/company-candidates?'+urlencode(params or {}),who=who,extra=extra)
    assert read(None)[0]==401 and read(user)[0]==403 and read(owner)[0]==403 and read(operator)[0]==403
    for who in (officer,operator,handler):t.enroll(who)
    assert read(handler)[0]==403 and read(officer)[0]==200 and read()[0]==200
    assert read(extra={'X-Fleet-Owner':str(owner['user_id'])})[0]==403
    ok('admin security ON: anonymous/user/company/unverified admin/handler/delegation denied; enrolled officer and operator allowed')
    before=fingerprint();collected=[];lengths=[];params={}
    fields={'owner_id','staff_id','company_name','first_observed','last_observed','currently_linked'}
    while True:
        status,data,headers=read(params=params);assert status==200,(status,data)
        assert 'no-store' in {k.lower():v for k,v in headers.items()}['cache-control']
        assert data['identity_confirmed'] is False and data['more']==(data['next'] is not None)
        assert all(set(e)==fields for e in data['items']) and 'PRIVATE-' not in json.dumps(data)
        collected += [(r['owner_id'],r['staff_id']) for r in data['items']];lengths.append(len(data['items']))
        if data['next'] is None:break
        params={'after_owner':data['next']['owner_id'],'after_staff':data['next']['staff_id']}
    assert collected==sorted(pairs) and lengths==[50,50,7] and before==fingerprint()
    assert len(read(target=other_parent['id'])[1]['items'])==1
    ok('107 grouped historical links traverse50/50/7 exactly across company boundary; strict metadata/no-store; subject scoped and source hashes unchanged')
    for q in ('100%_','  archive  ','%_'):
        first=read(params={'q':q})[1];last=read(params={'q':q,**{'after_owner':first['next']['owner_id'],'after_staff':first['next']['staff_id']}})[1]
        assert len(first['items'])==50 and len(last['items'])==4 and last['next'] is None
    assert read(params={'q':'100X_'})[1]['items']==[]
    assert len(read(params={'q':str(archived[1])})[1]['items'])==1
    assert len(read(params={'q':str(other_owner['user_id'])})[1]['items'])==50
    assert len(read(params={'linked':'linked'})[1]['items'])==2
    unlinked=[];p={'linked':'unlinked'}
    while True:
        d=read(params=p)[1];unlinked+=d['items']
        if not d['next']:break
        p.update(after_owner=d['next']['owner_id'],after_staff=d['next']['staff_id'])
    assert len(unlinked)==105 and all(not e['currently_linked'] for e in unlinked)
    for bad in ({'after_owner':1},{'after_staff':1},{'after_owner':0,'after_staff':1},{'after_owner':1,'after_staff':-1},{'after_owner':'abc','after_staff':1},{'linked':''},{'linked':'invalid'},{'q':'가'*81},{'subject_id':other_user['user_id']},{'limit':500}):assert read(params=bad)[0]==400,bad
    assert read(params={'q':'가'*80})[0]==200 and read(params={'q':'   '})[0]==200 and read(target=99999999)[0]==404
    assert read(params={'after_owner':99999999,'after_staff':99999999})[1]['items']==[] and before==fingerprint()
    ok('literal/case-insensitive company search, exact IDs, linked2/unlinked105, paired cursor validation, Unicode80 bound, unknown request404 and empty page')
    assert sql("SELECT count(*) FROM admin_security_events WHERE route=%s AND action='access' AND outcome='authorized'",(template,))[0][0]>0
    assert sql("SELECT count(*) FROM admin_security_events WHERE route=%s AND action='response' AND outcome='ready'",(template,))[0][0]>0
    sql("CREATE FUNCTION synthetic143_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.route='/admin/privacy/requests/:id/company-candidates' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$")
    sql('CREATE TRIGGER synthetic143_failure BEFORE INSERT ON admin_security_events FOR EACH ROW EXECUTE FUNCTION synthetic143_audit_failure()')
    assert read()[0]==500
    sql('DROP TRIGGER synthetic143_failure ON admin_security_events');sql('DROP FUNCTION synthetic143_audit_failure()')
    assert read()[0]==200 and before==fingerprint()
    ok('candidate GET records admin access/response evidence; audit-write failure fails closed and recovers without source mutation')
    lock=psycopg2.connect(t.DSN);lock.autocommit=False
    with lock.cursor() as c:c.execute('LOCK TABLE privacy_company_link_history IN ACCESS EXCLUSIVE MODE')
    client=t.connection();pattern='%WITH candidates AS%'
    try:
        client.request('GET',t.BASE+route,headers=t.headers(operator))
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND wait_event_type='Lock' AND query LIKE %s",(pattern,))[0][0]==1:break
            time.sleep(.05)
        else:raise AssertionError('candidate query did not reach held SQL lock')
        client.close()
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND state<>'idle' AND query LIKE %s",(pattern,))[0][0]==0:break
            time.sleep(.05)
        else:raise AssertionError('cancel left candidate SQL running')
    finally:client.close();lock.rollback();lock.close()
    assert read()[0]==200 and before==fingerprint()
    ok('one blocked candidate SELECT cancelled by TLS disconnect, SQL ends and next read200; no sustained/concurrent load')
    path=f'/admin/privacy/requests/{rid}/company-reviews'
    def body():return dict(revision=sql('SELECT revision FROM privacy_requests WHERE id=%s',(rid,))[0][0],company_owner_id=archived[0],staff_id=archived[1],category='files',from_at=start.isoformat(),until_at=end.isoformat(),due_at=(now+timedelta(days=7)).isoformat())
    def approve(payload):
        status,a,_=t.call('POST','/admin/security/approvals',dict(method='POST',path=path,payload=payload,reason='Synthetic historical candidate review'),operator);assert status==200,(status,a)
        assert t.call('POST',f"/admin/security/approvals/{a['id']}/decision",dict(approve=True),officer)[0]==200
        return {'X-Admin-Approval':str(a['id'])}
    b=body();assert t.call('POST',path,b,operator)[0]==409 and t.call('POST',path,b,officer)[0]==403
    approval=approve(b)
    assert t.call('POST',path,{**b,'staff_id':foreign},operator,approval)[0]==409
    status,item,_=t.call('POST',path,b,operator,approval);assert status==200,(status,item)
    assert item['identity']=='pending' and item['status']=='identity_pending' and item['inventory']['identity_confirmed'] is False and item['inventory']['counts_are_candidates'] is True
    b=body();assert t.call('POST',path,b,operator,approve(b))[0]==409
    assert sql('SELECT count(*) FROM privacy_company_reviews WHERE request_id=%s',(rid,))==[(1,)]
    assert sql('SELECT count(*) FROM privacy_company_tasks')==[(0,)]
    assert sql("SELECT status FROM privacy_requests WHERE id=%s",(rid,))[0][0] not in ('fulfilled','completed')
    ok('explicit operator execution needs officer approval; changed payload denied; archived link creates only identity_pending review; duplicate rejected and no company task/disclosure')
    sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['203.0.113.9/32'] WHERE user_id=%s",(operator['user_id'],))
    assert read(extra={'X-Real-IP':'203.0.113.9','X-Forwarded-For':'203.0.113.9'})[0]==403
    sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['127.0.0.1/32'],enabled=false WHERE user_id=%s",(operator['user_id'],));assert read()[0]==403
    sql('UPDATE admin_principals SET enabled=true WHERE user_id=%s',(operator['user_id'],));assert read()[0]==200
    sql('UPDATE admin_sessions SET revoked_at=now() WHERE user_id=%s',(operator['user_id'],));assert read()[0]==403
    rev=sql('SELECT revision FROM privacy_requests WHERE id=%s',(rid,))[0][0]
    assert t.call('POST',f'/privacy/requests/{rid}/cancel',dict(revision=rev),user)[0]==200
    closed=fingerprint();assert len(read(officer)[1]['items'])==50 and closed==fingerprint()
    assert sql('SELECT max(version) FROM _sqlx_migrations')==[(114,)]
    ok('IP spoofing, disabled principal and revoked step-up denied; cancelled parent history remains auditable; schema114 unchanged')
    t.stop_api()
    (ROOT/'out/functional143.json').write_text(json.dumps(dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),passed=passed,schema=114,
      api_sha256=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest(),fixture=dict(accounts=7,history_pairs=107,foreign_pairs=1,page_lengths=lengths,current_links=2,created_reviews=1),
      read_only_hashes=before,db_role_report=roles,production_accessed=False,sustained_load_executed=False,
      environment='internal TLS1.2; PostgreSQL14/Timescale; separated gps_runtime; encryption ON; admin security ON with TOTP and IP'),indent=2)+'\n')
    print('PASS all',len(passed),'functional groups',flush=True)
if __name__=='__main__':main()
