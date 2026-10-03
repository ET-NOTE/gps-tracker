#!/usr/bin/env python3
"""Apply the reviewed guide/tutorial revision plan to Shield only; no billing or device writes."""
import argparse,copy,hashlib,importlib.util,json,os,time,urllib.parse,urllib.request,urllib.error
from pathlib import Path
ROOT=Path('/home/mmm/shield-deploy')
spec=importlib.util.spec_from_file_location('checks',ROOT/'verify-production.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
ALLOWED={'start','shield-uno-connect','shield-uno-dht11','shield-uno-gnss','shield-uno-upload','shield-uno-firebase','shield-uno-first-upload'}
def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def raw(client,path,data=None,mime='application/octet-stream'):
    req=urllib.request.Request(c.BASE+path,data=data,headers={'Origin':c.BASE,'Content-Type':mime})
    try:r=client.opener.open(req,timeout=30)
    except urllib.error.HTTPError as e:r=e
    return r.status,r.read()
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--directory',type=Path,required=True);p.add_argument('--apply',action='store_true');a=p.parse_args()
    assert c.BASE=='https://shield.serial.kr' and os.geteuid()==0
    os.umask(0o077);directory=a.directory.resolve();plan=json.loads((directory/'review-plan.json').read_text())
    assert {x['content']['id'] for x in plan['posts']}==ALLOWED and len(plan['posts'])==7
    for asset in plan['assets']:
        file=(directory/asset['path']).resolve();assert file.is_relative_to(directory)
        assert hashlib.sha256(file.read_bytes()).hexdigest()==asset['sha256']
    admin,anon=c.Client(),c.Client();credentials=json.loads((ROOT/'admin-enrollment.json').read_text())
    assert admin.call('/api/auth/login',{'email':credentials['email'],'password':credentials['password']})[0]==200
    financial="SELECT json_build_object('orders',(SELECT count(*) FROM point_orders),'requests',(SELECT count(*) FROM sim_requests),'ledger',(SELECT count(*) FROM sim_ledger),'credits',(SELECT count(*) FROM credit_entries));"
    before=c.pg(financial)
    try:
        rows=admin.call('/api/admin/posts')[1];existing={r['content']['id']:r for r in rows}
        # Validate the whole reviewed set BEFORE uploading or changing any content.
        for item in plan['posts']:
            old=existing.get(item['content']['id'])
            assert (old and old['published'] and old['revision']==item['revision'] and digest(old['content'])==item['before_sha256']) if item['revision'] else old is None, 'Administrator edits changed: re-review, never overwrite'
        print(json.dumps({'reviewed_posts':sorted(ALLOWED),'action':'apply' if a.apply else 'dry run'}))
        if not a.apply:return
        (directory/f'posts-before-{int(time.time())}.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
        for asset in plan['assets']:
            file=directory/asset['path']
            status,response=raw(admin,'/api/admin/post-files?'+urllib.parse.urlencode({'name':file.name}),file.read_bytes())
            assert status==200 and json.loads(response)['id']==asset['sha256'],('attachment',status)
        status,response=raw(admin,'/api/admin/post-images',(directory/'devices-demo.png').read_bytes(),'image/png')
        assert status==200,('image',status,response)
        demo=json.loads(response)['id'];report=[]
        for item in plan['posts']:
            content=copy.deepcopy(item['content']);slug=content['id']
            for photo in content['images']:
                if photo['id']=='@devices-demo':photo['id']=demo
            status,response,_=admin.call('/api/admin/posts/'+slug,{'content':content,'published':True,'revision':item['revision']})
            assert status==200,(slug,status,response)
            public=next(x for x in anon.call('/api/posts')[1] if x['id']==slug)
            assert {k:v for k,v in public.items() if k not in ('revision','updated_at')}==content
            report.append({'slug':slug,'revision':public['revision'],'images':len(content['images']),'attachments':len(content['attachments'])})
        for asset in plan['assets']:
            status,body=raw(anon,'/api/post-files/'+asset['sha256'])
            assert status==200 and hashlib.sha256(body).hexdigest()==asset['sha256']
        assert raw(anon,'/api/post-images/'+demo)[0]==200
        after={r['content']['id']:r for r in admin.call('/api/admin/posts')[1]}
        assert all(after[slug]==old for slug,old in existing.items() if slug not in ALLOWED)
        assert before==c.pg(financial),'Unexpected financial record change'
        result={'posts':report,'demo_image':demo,'other_posts':'unchanged','financial_records':'unchanged'}
        (directory/'publication-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
        print(json.dumps(result,ensure_ascii=False))
    finally:assert admin.call('/api/auth/logout',{})[0]==200
if __name__=='__main__':main()
