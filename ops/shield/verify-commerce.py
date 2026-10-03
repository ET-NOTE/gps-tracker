#!/usr/bin/env python3
"""Read-only Shield production commerce checks, except sign-in/out. No billing POSTs."""
import importlib.util,json,os,pathlib,secrets,subprocess,urllib.request
ROOT=pathlib.Path('/home/mmm/shield-deploy')
spec=importlib.util.spec_from_file_location('checks',ROOT/'verify-production.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def main():
    assert os.geteuid()==0;os.umask(0o077)
    query="SELECT json_build_object('orders',(SELECT count(*) FROM point_orders),'requests',(SELECT count(*) FROM sim_requests),'sim_ledger',(SELECT count(*) FROM sim_ledger),'credits',(SELECT count(*) FROM credit_entries),'balance',(SELECT coalesce(sum(credit_balance),0) FROM users));"
    before=c.pg(query);anon=c.Client();config=anon.call('/api/commerce')[1]
    c.check('unconfigured payments closed',config['enabled'] is False and 'client_key' not in config)
    c.check('unconfirmed USIM catalog not offered',not config['sim_sales_enabled'] and config['sim_plans']==[])
    c.check('point amounts match reviewed modal',config['amounts']==[10000,30000,50000,100000])
    public=anon.call('/api/faqs')[1]
    c.check('public FAQ available',len(public)>=9 and all('revision' not in r for r in public))
    c.check('admin users private',anon.call('/api/admin/user-summary')[0]==401)
    for path in ['/pricing','/faq','/points','/devices']:
        status,html,_=anon.call(path);c.check('route '+path,status==200 and 'root' in html)
    marker='shield_log_probe_'+secrets.token_hex(8)
    status,html,headers=anon.call('/points/success?paymentKey='+marker+'&orderId=synthetic&amount=0')
    c.check('callback shell available',status==200 and 'root' in html)
    log=pathlib.Path('/var/log/nginx/shield.access.log').read_text()
    c.check('callback query absent from access log',marker not in log)
    csp=next(v for k,v in headers.items() if k.lower()=='content-security-policy')
    c.check('Toss SDK permitted without broad script access',"script-src 'self' https://js.tosspayments.com;" in csp and "script-src *" not in csp)
    for file,admin in [('admin-enrollment.json',True),('bench-enrollment.json',False)]:
        f=json.loads((ROOT/file).read_text());client=c.Client()
        assert client.call('/api/auth/login',{'email':f['email'],'password':f['password']})[0]==200
        try:
            who=client.call('/api/auth/session')[1]
            c.check('wallet history private and readable '+str(admin),client.call('/api/payments')[0]==200 and client.call('/api/credits')[0]==200)
            if admin:
                c.check('payment statistics available',client.call('/api/admin/user-summary')[0]==200)
                rows=client.call('/api/admin/users')[1]
                c.check('user aggregates available',all('paid_total' in r and 'online_count' in r for r in rows))
                c.check('FAQ editor revision data available',all('revision' in r for r in client.call('/api/admin/faqs')[1]))
            else:
                c.check('regular user cannot list admin FAQ',client.call('/api/admin/faqs')[0]==403)
                devices=client.call('/api/devices')[1];c.check('physical device ownership retained',any(d['id']==f['device_id'] for d in devices))
                sim=client.call(f"/api/devices/{f['device_id']}/usim")[1]
                c.check('SIM quota retained while sales are closed',sim['sim']['linked'] and not sim['sales_enabled'])
        finally:assert client.call('/api/auth/logout',{})[0]==200
    c.check('no financial records changed',before==c.pg(query))
    c.isolation()
    result={'passed':len(c.checks),'financial_counts':json.loads(before),'release':pathlib.Path('/srv/shield/current/release.txt').read_text().strip(),'financial_calls':'none'}
    (ROOT/'commerce-verification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
if __name__=='__main__':main()
