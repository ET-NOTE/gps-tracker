#!/usr/bin/env python3
"""Drive attachment permissions and migration, isolated preview only; no Google calls."""
import copy, hashlib, importlib.util, json, pathlib, secrets, urllib.request
spec=importlib.util.spec_from_file_location('images',pathlib.Path(__file__).with_name('test-post-images.py'))
i=importlib.util.module_from_spec(spec);spec.loader.exec_module(i)
c=i.c

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def main():
    assert c.sql('SELECT current_database()')=='shield_test'
    fixture=json.loads((c.ROOT/'operations-ui-fixture.json').read_text())
    admin,user,anon=c.Client(),c.Client(),c.Client()
    for client in (admin,user,anon):
        client.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(client.cookies),NoRedirect())
    for client,key in [(admin,'admin_email'),(user,'user_email')]:
        assert client.call('/api/auth/login',{'email':fixture[key],'password':fixture['password']})[0]==200
    suffix=secrets.token_hex(8)
    canonical='https://drive.google.com/file/d/DriveFixture'+suffix+'/view'
    payload={'url':canonical+'?usp=sharing','filename':'예제 코드.ino'}
    route='/api/admin/post-files/drive'
    c.check('anonymous Drive registration denied',anon.call(route,payload)[0]==401)
    c.check('ordinary user Drive registration denied',user.call(route,payload)[0]==403)
    c.check('foreign origin denied',admin.call(route,payload,{'Origin':'https://gps.serial.kr'})[0]==403)
    for url in ['https://evil.example/file/d/DriveFixture/view','http://drive.google.com/file/d/DriveFixture/view','https://drive.google.com/drive/folders/DriveFixture','https://drive.google.com/open?id=DriveFixture&id=OtherFixture']:
        c.check('unsafe or ambiguous URL rejected',admin.call(route,{**payload,'url':url})[0]==400)
    c.check('unsafe filename rejected',admin.call(route,{**payload,'filename':'../test.html'})[0]==400)
    status,file,_=admin.call(route,payload);assert status==200,(status,file)
    id=file['id'];url='/api/post-files/'+id
    c.check('canonical metadata stored without bytes',file['drive_url']==canonical and c.sql(f"SELECT data IS NULL AND drive_url='{canonical}' FROM post_files WHERE id='{id}'")=='t')
    c.check('same Drive file deduplicated',admin.call(route,{**payload,'url':canonical})[1]['id']==id)
    c.check('unattached link hidden',anon.call(url)[0]==404 and user.call(url)[0]==404)
    status,body,h=admin.call(url);h={k.lower():v for k,v in h.items()}
    c.check('admin receives redirect without proxying',status==307 and body=='' and h['location']==canonical and h['cache-control']=='no-store')
    post={'content':{'id':'drive-check-'+suffix,'title':'Drive 검증','description':'미리보기 전용','category':'기타','level':'입문','minutes':5,'variant':'board','steps':['연결 확인'],'kind':'example','attachments':[{'id':id,'title':'예제 코드','after_step':1}]},'published':False,'revision':0}
    path='/api/admin/posts/'+post['content']['id']
    assert admin.call(path,post)[0]==200;post['revision']+=1
    c.check('draft destination hidden',anon.call(url)[0]==404)
    post['published']=True;assert admin.call(path,post)[0]==200;post['revision']+=1
    status,body,h=anon.call(url);h={k.lower():v for k,v in h.items()}
    c.check('published anonymous redirect has no file body',status==307 and body=='' and h['location']==canonical and h['cache-control']=='no-store' and h['x-content-type-options']=='nosniff')
    post['published']=False;assert admin.call(path,post)[0]==200;post['revision']+=1
    c.check('unpublish hides platform link',anon.call(url)[0]==404)
    paid=copy.deepcopy(post);paid['content']['kind']='project'
    c.check('paid project cannot expose Drive files',admin.call(path,paid)[0]==400)
    original=('// migration fixture '+suffix+'\n').encode()
    status,raw,_=i.raw(admin,'/api/admin/post-files?name=migrate.ino',original);assert status==200
    legacy=json.loads(raw)['id'];legacy_url='/api/post-files/'+legacy
    c.check('unmigrated private bytes backward compatible',i.raw(admin,legacy_url)[1]==original)
    post['content']['attachments']=[{'id':legacy,'title':'원본','after_step':0}];post['published']=True
    assert admin.call(path,post)[0]==200;post['revision']+=1
    before=next(p for p in admin.call('/api/admin/posts')[1] if p['content']['id']==post['content']['id'])
    migration={**payload,'existing_id':legacy}
    c.check('existing ID remapped',admin.call(route,migration)[1]['id']==legacy)
    after=next(p for p in admin.call('/api/admin/posts')[1] if p['content']['id']==post['content']['id'])
    c.check('mapping preserves post revision content and bytes',before==after and c.sql(f"SELECT encode(sha256(data),'hex') FROM post_files WHERE id='{legacy}'")==hashlib.sha256(original).hexdigest())
    c.check('old public URL redirects',anon.call(legacy_url)[0]==307)
    c.check('repeat migration idempotent',admin.call(route,migration)[0]==200)
    c.check('cannot silently replace destination',admin.call(route,{**migration,'url':canonical.replace(suffix,'anotherfile123')})[0]==409)
    c.check('nonexistent migration rejected',admin.call(route,{**migration,'existing_id':'f'*64})[0]==404)
    post['published']=False;assert admin.call(path,post)[0]==200
    c.check('migration audited',int(c.sql(f"SELECT count(*) FROM audit_log WHERE action='post.file.drive' AND target_id='{legacy}'"))==1)
    print(json.dumps({'passed':len(c.checks),'database':'shield_test','external_requests':0}))

if __name__=='__main__':main()
