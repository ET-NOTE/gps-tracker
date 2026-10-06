#!/usr/bin/env python3
"""Wallet/FAQ verification against shield_test and a loopback-only fake Toss API."""
import concurrent.futures, copy, http.server, importlib.util, json, pathlib, secrets, threading, uuid
spec=importlib.util.spec_from_file_location('base',pathlib.Path(__file__).with_name('test-integration.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
records={};calls=[];mode='done'
class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def send(self,value,status=200):
        body=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
    def do_POST(self):
        assert self.path=='/v1/payments/confirm'
        v=json.loads(self.rfile.read(int(self.headers['Content-Length'])));calls.append(v)
        value={'paymentKey':v['paymentKey'],'orderId':v['orderId'],'totalAmount':v['amount'],'balanceAmount':v['amount'],'currency':'KRW','status':'DONE'}
        records[v['paymentKey']]=value
        if mode=='unknown':self.send({},503)
        elif mode=='mismatch':self.send({**value,'totalAmount':1})
        elif mode=='waiting':self.send({**value,'status':'WAITING_FOR_DEPOSIT'})
        else:self.send(value)
    def do_GET(self):
        self.send(records.get(self.path.rsplit('/',1)[-1],{}))

def main():
    global mode
    assert c.sql('SELECT current_database()')=='shield_test'
    env=dict(x.split('=',1) for x in (c.ROOT/'preview.env').read_text().splitlines() if '=' in x)
    assert env['SHIELD_TOSS_BASE_URL']=='http://127.0.0.1:9053' and env['SHIELD_TOSS_SECRET_KEY']=='test_sk_mock_only'
    server=http.server.ThreadingHTTPServer(('127.0.0.1',9053),Mock);threading.Thread(target=server.serve_forever,daemon=True).start()
    f=json.loads((c.ROOT/'operations-ui-fixture.json').read_text());admin,user,anon=c.Client(),c.Client(),c.Client()
    for client,k in [(admin,'admin_email'),(user,'user_email')]:assert client.call('/api/auth/login',{'email':f[k],'password':f['password']})[0]==200
    who=user.call('/api/auth/session')[1];balance=who['credit_balance'];uid=who['id'];suffix=secrets.token_hex(4)
    def init(amount=10000,key=None,client=user):return client.call('/api/payments',{'amount':amount,'idempotency_key':key or str(uuid.uuid4())})
    c.check('anonymous payment denied',init(client=anon)[0]==401)
    c.check('unlisted payment amount rejected',init(1)[0]==400)
    key=str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor(2) as pool:out=list(pool.map(lambda _:init(key=key),range(2)))
    c.check('concurrent checkout idempotency',all(r[0]==200 for r in out) and out[0][1]['order_id']==out[1][1]['order_id'])
    c.check('checkout key cannot change price',init(30000,key)[0]==400)
    order=out[0][1]['order_id'];body={'order_id':order,'amount':10000,'payment_key':'mock_'+suffix}
    c.check('other owner cannot confirm',admin.call('/api/payments/confirm',body)[0]==404)
    c.check('amount tampering rejected before provider call',user.call('/api/payments/confirm',{**body,'amount':1})[0]==400 and len(calls)==0)
    c.check('foreign origin confirm denied',user.call('/api/payments/confirm',body,{'Origin':'https://gps.serial.kr'})[0]==403)
    with concurrent.futures.ThreadPoolExecutor(2) as pool:out=list(pool.map(lambda _:user.call('/api/payments/confirm',body),range(2)))
    c.check('approval posted once despite concurrent confirmation',len(calls)==1)
    c.check('wallet credited once',user.call('/api/auth/session')[1]['credit_balance']==balance+10000 and c.sql(f"SELECT count(*) FROM credit_entries WHERE reference='payment:{order}'")=='1')
    c.check('repeat confirmation succeeds without crediting again',user.call('/api/payments/confirm',body)[1]['status']=='paid' and len(calls)==1)
    c.check('payment key cannot change on replay',user.call('/api/payments/confirm',{**body,'payment_key':'different'})[0]==400)
    for state in ['unknown','mismatch','waiting']:
        mode=state;order=init()[1]['order_id'];body={'order_id':order,'amount':10000,'payment_key':'mock_'+state+'_'+suffix};before=user.call('/api/auth/session')[1]['credit_balance']
        result=user.call('/api/payments/confirm',body)
        c.check(state+' never credits unverified payment',result[1]['status']=='unknown' and user.call('/api/auth/session')[1]['credit_balance']==before)
        posted=len(calls)
        c.check('non-owner cannot reconcile '+state,admin.call('/api/payments/'+order+'/reconcile',{})[0]==404)
        result=user.call('/api/payments/'+order+'/reconcile',{})
        c.check(state+' recovered by query without second approval',result[1]['status']=='paid' and len(calls)==posted and user.call('/api/auth/session')[1]['credit_balance']==before+10000)
    c.check('no secret payment key in order history',all('payment_key' not in r for r in user.call('/api/payments')[1]))
    summary=admin.call('/api/admin/user-summary')[1]
    c.check('payment total excludes arbitrary credit adjustments',summary['total']==int(c.sql("SELECT coalesce(sum(amount),0) FROM point_orders WHERE status='paid'")))
    c.check('user summaries restricted to admin',user.call('/api/admin/user-summary')[0]==403 and anon.call('/api/admin/users/'+str(uid)+'/detail')[0]==401)
    row=next(r for r in admin.call('/api/admin/users')[1] if r['id']==uid)
    c.check('admin user has measured aggregates',row['paid_total']>=40000 and row['device_count']>=1 and row['remaining_mb'] is not None)
    c.check('user details mask subscriber identifier',all('sim_iccid' not in d for d in admin.call(f'/api/admin/users/{uid}/detail')[1]['devices']))
    c.check('server-side user state filter',all(u['role']=='admin' for u in admin.call('/api/admin/users?status=admin')[1]))
    faq={'category':'테스트','question':'합성 FAQ '+suffix,'answer':'<img src=x onerror=alert(1)>\n일반 텍스트 답변','published':False,'archived':False,'position':100,'revision':0}
    c.check('ordinary user FAQ mutation denied',user.call('/api/admin/faqs/0',faq)[0]==403)
    c.check('empty FAQ rejected',admin.call('/api/admin/faqs/0',{**faq,'answer':' '})[0]==400)
    result=admin.call('/api/admin/faqs/0',faq);assert result[0]==200,result
    id=result[1]['id'];path='/api/admin/faqs/'+str(id);faq['revision']=1
    c.check('draft FAQ hidden',not any(r['id']==id for r in anon.call('/api/faqs')[1]))
    c.check('revision protects concurrent editors',admin.call(path,{**faq,'revision':0})[0]==409)
    faq['published']=True;assert admin.call(path,faq)[0]==200;faq['revision']=2
    c.check('public FAQ updated',any(r['id']==id and r['answer']==faq['answer'] for r in anon.call('/api/faqs')[1]))
    with concurrent.futures.ThreadPoolExecutor(2) as pool:out=list(pool.map(lambda _:admin.call(path,faq),range(2)))
    c.check('concurrent FAQ save has one winner',sorted(r[0] for r in out)==[200,409]);faq['revision']=3
    faq['archived']=True;assert admin.call(path,faq)[0]==200;faq['revision']=4
    c.check('archive revokes public FAQ',not any(r['id']==id for r in anon.call('/api/faqs')[1]))
    faq.update(archived=False,published=False);assert admin.call(path,faq)[0]==200
    c.check('FAQ retained and can be restored',any(r['id']==id and not r['archived'] for r in admin.call('/api/admin/faqs')[1]))
    c.check('FAQ audit trail retained',int(c.sql(f"SELECT count(*) FROM audit_log WHERE action='faq.save' AND target_id='{id}'"))==5)
    c.check('stale SIM quote rejected',user.call('/api/sim-requests',{'device_id':f['device_id'],'cost_credits':1,'idempotency_key':str(uuid.uuid4())})[0]==400)
    server.shutdown();print(json.dumps({'passed':len(c.checks),'financial_provider':'loopback mock only'}))
if __name__=='__main__':main()
