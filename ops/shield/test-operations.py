#!/usr/bin/env python3
"""Shield preview only. Any purchase-path tests require the loopback fake provider."""
import concurrent.futures,copy,importlib.util,json,pathlib,secrets,subprocess,time,urllib.request,uuid
ROOT=pathlib.Path('/home/etcom-hub/build/gps-tracker/shield-platform')
spec=importlib.util.spec_from_file_location('base',pathlib.Path(__file__).with_name('test-integration.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def wait_status(client,id,status):
    for _ in range(100):
        row=next(r for r in client.call('/api/sim-requests')[1] if r['id']==id)
        if row['status']==status:return row
        time.sleep(.1)
    raise AssertionError('Request status did not reach '+status)
def mode(value):
    return json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9043/__mode',data=json.dumps({'mode':value}).encode(),headers={'Content-Type':'application/json'})))
def count():return json.load(urllib.request.urlopen('http://127.0.0.1:9043/__state'))['posts']
def main():
    env=dict(x.split('=',1) for x in (ROOT/'preview.env').read_text().splitlines() if '=' in x)
    assert env['SHIELD_NCE_BASE_URL']=='http://127.0.0.1:9043' and env['SHIELD_NCE_CLIENT_ID']=='mock-only'
    assert c.sql('SELECT current_database()')=='shield_test'
    admin,user,anon=c.Client(),c.Client(),c.Client()
    suffix=secrets.token_hex(4);password=secrets.token_urlsafe(24)
    def signup(client,prefix):
        email=f'{prefix}-{suffix}@example.test'
        assert client.call('/api/auth/register',{'email':email,'password':password,'display_name':prefix,'invite_code':c.cli('invite')['invite_code']})[0]==200
        return email,client.call('/api/auth/session')[1]['id']
    email,admin_id=signup(admin,'admin');user_email,user_id=signup(user,'sensor')
    c.check('anonymous admin rejected',anon.call('/api/admin/users')[0]==401)
    c.check('ordinary user admin rejected',user.call('/api/admin/users')[0]==403)
    c.cli('grant-admin',email)
    c.check('CLI promotion revokes old session',admin.call('/api/auth/session')[0]==401)
    assert admin.call('/api/auth/login',{'email':email,'password':password})[0]==200
    c.check('same login exposes administrator role',admin.call('/api/auth/session')[1]['role']=='admin')
    c.check('self demotion refused',admin.call(f'/api/admin/users/{admin_id}',{'display_name':'admin','role':'user','disabled':False})[0]==400)
    post={'content':{'id':'ops-'+suffix,'title':'관리자 편집 검증','description':'<img src=x onerror=alert(1)>','category':'센서','level':'응용','minutes':10,'variant':'sensor','steps':['센서를 연결합니다.','값을 확인합니다.'],'code':'Serial.println("example");'},'published':False,'revision':0}
    path='/api/admin/posts/'+post['content']['id']
    c.check('non-admin cannot edit posts',user.call(path,post)[0]==403)
    c.check('admin draft saved',admin.call(path,post)[0]==200)
    c.check('draft hidden from public',not any(p['id']==post['content']['id'] for p in anon.call('/api/posts')[1]))
    c.check('stale edit rejected',admin.call(path,post)[0]==409)
    post.update(revision=1,published=True);assert admin.call(path,post)[0]==200
    c.check('published edit visible',any(p['id']==post['content']['id'] and p['revision']==2 for p in anon.call('/api/posts')[1]))
    device=c.cli('provision','센서 교체 검증');id=user.call('/api/devices/claim',{'claim_code':device['claim_code'],'display_name':'다목적 센서 쉴드'})[1]['id']
    sim='89882806660'+str(user_id).zfill(8)
    assert len(sim)==19
    c.check('admin SIM attachment',admin.call(f'/api/admin/devices/{id}',{'display_name':'다목적 센서 쉴드','sim_iccid':sim})[0]==200)
    assert user.call(f'/api/devices/{id}/usim/refresh',{})[0]==200
    for _ in range(100):
        siminfo=user.call(f'/api/devices/{id}/usim')[1]
        if siminfo['sim']['usage']:break
        time.sleep(.1)
    c.check('real adapter reads fake-provider quota',siminfo['sim']['usage']['remaining_mb']==321.25)
    c.check('non-owner SIM blocked',anon.call(f'/api/devices/{id}/usim')[0]==401)
    req={'device_id':id,'cost_credits':100,'idempotency_key':str(uuid.uuid4())}
    c.check('insufficient balance rolls request back',user.call('/api/sim-requests',req)[0]==400 and c.sql(f'SELECT count(*) FROM sim_requests WHERE user_id={user_id}')=='0')
    adjust={'amount':1000,'note':'preview-only mock funding','idempotency_key':str(uuid.uuid4())}
    assert admin.call(f'/api/admin/users/{user_id}/credits',adjust)[0]==200
    assert admin.call(f'/api/admin/users/{user_id}/credits',adjust)[0]==200
    c.check('credit adjustment idempotency',user.call('/api/auth/session')[1]['credit_balance']==1000)
    with concurrent.futures.ThreadPoolExecutor(2) as pool:out=list(pool.map(lambda _:user.call('/api/sim-requests',req),range(2)))
    rid=out[0][1]['id'];c.check('concurrent request is charged once',all(r[0]==200 and r[1]['id']==rid for r in out) and user.call('/api/auth/session')[1]['credit_balance']==900)
    c.check('SIM replacement blocked by pending request',admin.call(f'/api/admin/devices/{id}',{'display_name':'다목적 센서 쉴드','sim_iccid':'8988280666000000000'})[0]==400)
    c.check('owner cannot approve',user.call(f'/api/sim-requests/{rid}/action',{'action':'approve'})[0]==403)
    assert user.call(f'/api/sim-requests/{rid}/action',{'action':'cancel'})[0]==200
    c.check('cancellation refunds exactly once',user.call(f'/api/sim-requests/{rid}/action',{'action':'cancel'})[0]==400 and user.call('/api/auth/session')[1]['credit_balance']==1000)
    for provider_mode,target in [('success','submitted'),('reject','failed'),('unknown','unknown')]:
        mode(provider_mode)
        rid=user.call('/api/sim-requests',{'device_id':id,'cost_credits':100,'idempotency_key':str(uuid.uuid4())})[1]['id']
        assert admin.call(f'/api/sim-requests/{rid}/action',{'action':'approve','note':'mock only'})[0]==200
        row=wait_status(admin,rid,'approved');before=count()
        c.check('wrong execution reference blocked '+provider_mode,admin.call(f'/api/sim-requests/{rid}/action',{'action':'execute','confirm_reference':'wrong'})[0]==400)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            attempts=list(pool.map(lambda _:admin.call(f'/api/sim-requests/{rid}/action',{'action':'execute','confirm_reference':row['reference']}),range(2)))
        c.check('concurrent execution sends once '+provider_mode,sorted(r[0] for r in attempts)==[200,400])
        row=wait_status(admin,rid,target)
        c.check('provider POST sent once '+provider_mode,count()==before+1 and admin.call(f'/api/sim-requests/{rid}/action',{'action':'execute','confirm_reference':row['reference']})[0]==400)
        if target=='failed':c.check('definite rejection refunded',c.sql(f"SELECT count(*) FROM credit_entries WHERE request_id={rid} AND kind='refund'")=='1')
        else:
            if row['provider_order_id']:
                c.check('wrong order link refused',admin.call(f'/api/sim-requests/{rid}/action',{'action':'reconcile','order_id':'wrong-order','note':'mock test'})[0]==400)
            if target=='unknown':c.check('unknown outcome not refunded',admin.call(f'/api/sim-requests/{rid}/action',{'action':'reject'})[0]==400 and c.sql(f"SELECT count(*) FROM credit_entries WHERE request_id={rid} AND kind='refund'")=='0')
            c.check('order reconciliation reads provider',admin.call(f'/api/sim-requests/{rid}/action',{'action':'reconcile','order_id':row['provider_order_id'] or 'confirmed-mock-order-'+suffix,'note':'Checked fake provider order'})[0]==200)
    c.check('append-only audit rejects update',subprocess.run(['docker','exec','shield-preview-db','psql','-U','shield_test','-d','shield_test','-c','UPDATE audit_log SET action=action'],capture_output=True).returncode!=0)
    now=int(time.time());key={'X-Device-Key':device['device_key']}
    payload={'shield_v':3,'device_uid':device['device_uid'],'build_tag':'shield-dynamic-test','ts':10,'csq':20,'reg':5,'diag':{'pv_mv':4100},'points':[], 'sensor_set':'soil-v1','channels':[{'key':'moisture','label':'토양 수분','unit':'%'},{'key':'light','label':'조도','unit':'lx'}], 'sensors':[{'at':now-10,'values':{'moisture':43.5,'light':720}}]}
    c.check('dynamic soil/light ingest',anon.call('/ingest/shield',payload,key)[0]==200)
    invalid=copy.deepcopy(payload);invalid['channels'][0]['unit']='kPa'
    c.check('in-place unit change refused',anon.call('/ingest/shield',invalid,key)[0]==400)
    invalid=copy.deepcopy(payload);invalid['sensors'][0]['values']['undeclared']=123
    c.check('undeclared sensor value refused',anon.call('/ingest/shield',invalid,key)[0]==400)
    nextp=copy.deepcopy(payload);nextp.update(sensor_set='pressure-v2',channels=[{'key':'pressure','label':'압력','unit':'kPa'}],sensors=[{'at':now-5,'values':{'pressure':102.7}}])
    c.check('sensor replacement preserves device and SIM',anon.call('/ingest/shield',nextp,key)[0]==200)
    anon.call('/ingest/shield',payload,key)
    period=c.urllib.parse.urlencode({'since':c.iso(now-3600),'until':c.iso(now+1)})
    summary=user.call(f'/api/devices/{id}/summary?{period}')[1]
    channels=summary['channels']
    c.check('late old sensor cannot become active',len(channels)==3 and [x['key'] for x in channels if x['active']]==['pressure'])
    c.check('historical channel values retained',{x['key']:x['latest']['value'] for x in channels}=={'moisture':43.5,'light':720.0,'pressure':102.7})
    c.check('history carries channel map',len(user.call(f'/api/devices/{id}/readings?{period}')[1]['items'])==2)
    edit={'display_name':'sensor','role':'user','disabled':True}
    assert admin.call(f'/api/admin/users/{user_id}',edit)[0]==200
    c.check('disabled account session immediately rejected',user.call('/api/auth/session')[0]==401)
    c.check('disabled account login rejected',user.call('/api/auth/login',{'email':user_email,'password':password})[0]==401)
    edit['disabled']=False;assert admin.call(f'/api/admin/users/{user_id}',edit)[0]==200
    assert user.call('/api/auth/login',{'email':user_email,'password':password})[0]==200
    fixture={'admin_email':email,'user_email':user_email,'password':password,'device_id':id,'device':device}
    path=ROOT/'operations-ui-fixture.json';path.write_text(json.dumps(fixture));path.chmod(0o600)
    print(json.dumps({'passed':len(c.checks),'provider':'loopback fake only','fixture':'saved privately'}))
if __name__=='__main__':main()
