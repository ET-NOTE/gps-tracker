#!/usr/bin/env python3
"""Shield HTTPS portal smoke check; private synthetic upload, no billing calls.

Optionally replace the untouched default guide with the reviewed seed pair.
Never overwrites a guide edited by an administrator. Credentials stay on VPS.
"""
import argparse, hashlib, importlib.util, json, os, pathlib, urllib.error, urllib.request

ROOT=pathlib.Path('/home/mmm/shield-deploy')
spec=importlib.util.spec_from_file_location('checks',ROOT/'verify-production.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def raw(client,path,data=None):
    req=urllib.request.Request(c.BASE+path,data=data,headers={'Origin':c.BASE,'Content-Type':'application/octet-stream'})
    try:r=client.opener.open(req,timeout=25)
    except urllib.error.HTTPError as e:r=e
    return r.status,r.read(),{k.lower():v for k,v in r.headers.items()}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--update-default-guide',action='store_true')
    args=parser.parse_args();assert os.geteuid()==0;os.umask(0o077)
    admin,anon,owner=c.Client(),c.Client(),c.Client()
    credentials=json.loads((ROOT/'admin-enrollment.json').read_text())
    assert admin.call('/api/auth/login',{'email':credentials['email'],'password':credentials['password']})[0]==200
    count_sql="SELECT json_build_object('requests',(SELECT count(*) FROM sim_requests),'ledger',(SELECT count(*) FROM sim_ledger),'credits',(SELECT count(*) FROM credit_entries));"
    before_financial=json.loads(c.pg(count_sql))
    result={}
    try:
        rows=admin.call('/api/admin/posts')[1]
        current=next(p for p in rows if p['content']['id']=='start')
        if args.update_default_guide:
            pair=json.loads((ROOT/'portal-guide-update.json').read_text())
            if current['content']==pair['before']:
                (ROOT/'portal-guide.before.json').write_text(json.dumps(current,ensure_ascii=False,indent=2))
                status,_,_=admin.call('/api/admin/posts/start',{'content':pair['after'],'published':current['published'],'revision':current['revision']})
                assert status==200
                result['guide']='untouched seed upgraded to 3 steps'
            elif all(current['content'].get(k)==v for k,v in pair['after'].items()):
                result['guide']='reviewed 3-step seed already present'
            else:
                result['guide']='existing administrator content preserved'
        settings=anon.call('/api/site-settings')[1]
        public=anon.call('/api/posts')[1]
        assert any(p['id']==settings['guide_slug'] and p.get('kind','example')=='example' for p in public)
        result['guide_slug']=settings['guide_slug']
        data=(b'Synthetic Shield attachment transport check; not customer content.\n'*2600)
        assert len(data)>131072
        status,response,_=raw(admin,'/api/admin/post-files?name=portal-transport-check.txt',data)
        assert status==200,(status,response[:200])
        file=json.loads(response);path='/api/post-files/'+file['id']
        assert file['id']==hashlib.sha256(data).hexdigest()
        status,downloaded,headers=raw(admin,path)
        assert status==200 and downloaded==data
        assert headers['content-type']=='application/octet-stream'
        assert headers['content-disposition'].startswith('attachment;')
        assert headers['cache-control']=='no-store' and headers['x-content-type-options']=='nosniff'
        assert raw(anon,path)[0]==404
        assert raw(anon,'/api/admin/post-files?name=denied.txt',data)[0]==401
        result['private_upload_bytes_verified']=len(data)
        result['private_upload_public_access']=False
        bench=json.loads((ROOT/'bench-enrollment.json').read_text())
        assert owner.call('/api/auth/login',{'email':bench['email'],'password':bench['password']})[0]==200
        try:
            assert raw(owner,path)[0]==404
            devices=owner.call('/api/devices')[1]
            assert any(d['id']==bench['device_id'] for d in devices)
            result['device_last_seen']=next(d['last_seen_at'] for d in devices if d['id']==bench['device_id'])
            assert owner.call(f"/api/devices/{bench['device_id']}/usim")[0]==200
        finally:assert owner.call('/api/auth/logout',{})[0]==200
        result['financial_counts']=json.loads(c.pg(count_sql))
        assert result['financial_counts']==before_financial
        result['result']='passed'
        (ROOT/'portal-verification.json').write_text(json.dumps(result,indent=2))
        print(json.dumps(result))
    finally:assert admin.call('/api/auth/logout',{})[0]==200

if __name__=='__main__':main()
