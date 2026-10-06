#!/usr/bin/env python3
"""Create reviewed tutorial posts + attachments through Shield admin APIs. No firmware flash, app deploy or billing."""
import argparse,hashlib,importlib.util,json,os,time,urllib.parse,urllib.request,urllib.error
from pathlib import Path
ROOT=Path('/home/mmm/shield-deploy')
spec=importlib.util.spec_from_file_location('checks',ROOT/'verify-production.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def raw(client,path,data=None):
    req=urllib.request.Request(c.BASE+path,data=data,headers={'Origin':c.BASE,'Content-Type':'application/octet-stream'})
    try:r=client.opener.open(req,timeout=30)
    except urllib.error.HTTPError as e:r=e
    return r.status,r.read()

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--directory',type=Path,required=True)
    p.add_argument('--publish',action='store_true');a=p.parse_args()
    assert c.BASE=='https://shield.serial.kr' and os.geteuid()==0
    os.umask(0o077);directory=a.directory.resolve()
    items=json.loads((directory/'publication.json').read_text())
    expected={'shield-uno-connect','shield-uno-dht11','shield-uno-gnss','shield-uno-upload','shield-uno-firebase','shield-uno-first-upload'}
    assert {x['content']['id'] for x in items}==expected and len(items)==6
    for item in items:
        for asset in item['assets']:
            file=(directory/asset['path']).resolve();assert file.is_relative_to(directory)
            assert hashlib.sha256(file.read_bytes()).hexdigest()==asset['sha256']
    admin,anon=c.Client(),c.Client();credentials=json.loads((ROOT/'admin-enrollment.json').read_text())
    assert admin.call('/api/auth/login',{'email':credentials['email'],'password':credentials['password']})[0]==200
    financial="SELECT json_build_object('orders',(SELECT count(*) FROM point_orders),'requests',(SELECT count(*) FROM sim_requests),'ledger',(SELECT count(*) FROM sim_ledger),'credits',(SELECT count(*) FROM credit_entries));"
    before=c.pg(financial)
    try:
        rows=admin.call('/api/admin/posts')[1];existing={r['content']['id']:r for r in rows}
        if not a.publish:
            print(json.dumps({'action':'create only','new':[x for x in sorted(expected) if x not in existing],'existing':[x for x in sorted(expected) if x in existing]},ensure_ascii=False));return
        (directory/f'posts-before-{int(time.time())}.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
        report=[]
        for item in items:
            content=item['content'];slug=content['id'];assets=[]
            for asset in item['assets']:
                file=directory/asset['path']
                # Content-addressed assets avoid duplicate files on interrupted/repeated runs.
                status,response=raw(admin,'/api/admin/post-files?'+urllib.parse.urlencode({'name':file.name}),file.read_bytes())
                assert status==200,(slug,'upload',status)
                uploaded=json.loads(response);assert uploaded['id']==asset['sha256']
                assets.append({'id':uploaded['id'],'title':asset['title'],'after_step':0})
            content={**content,'attachments':assets}
            if slug in existing:
                assert existing[slug]['content']==content and existing[slug]['published'],'Existing tutorial differs: will not overwrite administrator edits'
            else:
                status,response,_=admin.call('/api/admin/posts/'+slug,{'content':content,'published':True,'revision':0})
                assert status==200,(slug,'save',status,response)
            public=next(x for x in anon.call('/api/posts')[1] if x['id']==slug)
            assert public['title']==content['title'] and public['attachments']==assets
            for asset in item['assets']:
                status,body=raw(anon,'/api/post-files/'+asset['sha256'])
                assert status==200 and hashlib.sha256(body).hexdigest()==asset['sha256']
            report.append({'slug':slug,'url':c.BASE+'/examples/'+slug,'attachments':len(assets)})
        assert before==c.pg(financial),'Unexpected financial record change'
        # Other posts and the configured start guide are untouched by this publisher.
        after={r['content']['id']:r for r in admin.call('/api/admin/posts')[1]}
        assert all(after[slug]==post for slug,post in existing.items() if slug not in expected)
        (directory/'publication-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps({'published':report,'other_posts':'unchanged','financial_records':'unchanged'},ensure_ascii=False))
    finally:assert admin.call('/api/auth/logout',{})[0]==200

if __name__=='__main__':main()
