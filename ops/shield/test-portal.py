#!/usr/bin/env python3
"""Portal authorization, guide and attachment checks in shield_test only."""
import concurrent.futures, copy, hashlib, importlib.util, json, pathlib, secrets, urllib.parse
spec=importlib.util.spec_from_file_location('images',pathlib.Path(__file__).with_name('test-post-images.py'))
i=importlib.util.module_from_spec(spec);spec.loader.exec_module(i)
c=i.c

def main():
    assert c.sql('SELECT current_database()')=='shield_test'
    fixture=json.loads((c.ROOT/'operations-ui-fixture.json').read_text())
    admin,user,anon=c.Client(),c.Client(),c.Client()
    for client,key in [(admin,'admin_email'),(user,'user_email')]:
        assert client.call('/api/auth/login',{'email':fixture[key],'password':fixture['password']})[0]==200
    def upload(name,data,client=admin):
        return i.raw(client,'/api/admin/post-files?name='+urllib.parse.quote(name),data)
    body=b'// Synthetic example\nvoid setup() {}\nvoid loop() {}\n'
    c.check('anonymous attachment upload denied',upload('test.ino',body,anon)[0]==401)
    c.check('ordinary user attachment upload denied',upload('test.ino',body,user)[0]==403)
    for name,data in [('test.html',body),('../test.txt',body),('test.pdf',body),('test.zip',body),('test.txt',b'\xff'),('test.txt',b'')]:
        c.check('invalid attachment rejected: '+name+str(len(data)),upload(name,data)[0]==400)
    c.check('foreign origin attachment upload denied',i.raw(admin,'/api/admin/post-files?name=test.txt',body,'https://gps.serial.kr')[0]==403)
    c.check('exactly 5 MiB attachment accepted',upload('max-size.txt',b'x'*(5*1024*1024))[0]==200)
    c.check('attachment body limit enforced',upload('test.txt',b'x'*(5*1024*1024+1))[0]==413)
    status,result,_=upload('예제 코드.ino',body);assert status==200,(status,result)
    file=json.loads(result);url='/api/post-files/'+file['id']
    c.check('attachment deduplicated by content',file['id']==hashlib.sha256(body).hexdigest() and json.loads(upload('another.ino',body)[1])['id']==file['id'])
    c.check('unattached file private',i.raw(anon,url)[0]==404 and i.raw(user,url)[0]==404)
    status,data,h=i.raw(admin,url)
    c.check('admin download preserves exact bytes and safe headers',status==200 and data==body and h['content-type']=='application/octet-stream' and h['content-disposition'].startswith('attachment;') and 'filename*=UTF-8' in h['content-disposition'] and h['cache-control']=='no-store' and h['x-content-type-options']=='nosniff' and 'sandbox' in h['content-security-policy'])
    status,result,_=upload('second.txt',b'Second synthetic attachment\n');assert status==200
    second=json.loads(result)
    post={'content':{'id':'portal-check-'+secrets.token_hex(4),'title':'포털 검증 예제','description':'미리보기 전용','category':'기타','level':'입문','minutes':5,'variant':'board','steps':['첫 번째\n연결 확인','두 번째'], 'step_titles':['연결','확인'],'kind':'example','attachments':[{'id':file['id'],'title':'예제 코드','after_step':1},{'id':second['id'],'title':'안내 파일','after_step':0}]},'published':False,'revision':0}
    path='/api/admin/posts/'+post['content']['id']
    for field,value in [('step_titles',['불일치']),('kind','unknown'),('attachments',[{'id':'0'*64,'title':'없음','after_step':0}]),('attachments',[{'id':file['id'],'title':'범위','after_step':3}]),('attachments',post['content']['attachments']*6)]:
        invalid=copy.deepcopy(post);invalid['content'][field]=value
        c.check('invalid post field rejected: '+field+str(len(value)),admin.call(path,invalid)[0]==400)
    assert admin.call(path,post)[0]==200;post['revision']=1
    c.check('saved draft file remains private',i.raw(anon,url)[0]==404)
    c.check('non-admin cannot choose guide',user.call('/api/admin/site-settings',{'guide_slug':post['content']['id']})[0]==403)
    c.check('draft cannot become guide',admin.call('/api/admin/site-settings',{'guide_slug':post['content']['id']})[0]==400)
    post['published']=True;assert admin.call(path,post)[0]==200;post['revision']=2
    c.check('published attachments visible without login',i.raw(anon,url)[0]==200 and i.raw(anon,'/api/post-files/'+second['id'])[0]==200)
    public=next(p for p in anon.call('/api/posts')[1] if p['id']==post['content']['id'])
    c.check('public post retains titles and multiple file positions',public['step_titles']==post['content']['step_titles'] and public['attachments']==post['content']['attachments'])
    c.check('stale revision cannot revoke downloads',admin.call(path,{**post,'revision':1,'published':False})[0]==409 and i.raw(anon,url)[0]==200)
    old=anon.call('/api/site-settings')[1]
    try:
        assert admin.call('/api/admin/site-settings',{'guide_slug':post['content']['id']})[0]==200
        c.check('guide reads chosen library post',anon.call('/api/site-settings')[1]['guide_slug']==post['content']['id'])
        c.check('current guide cannot be unpublished',admin.call(path,{**post,'published':False})[0]==400)
        project=copy.deepcopy(post);project['content'].update(kind='project',attachments=[],code='')
        c.check('current guide cannot become paid introduction',admin.call(path,project)[0]==400)
        assert admin.call('/api/admin/site-settings',old)[0]==200
        # Concurrent guide selection and unpublication must not leave a hidden guide.
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            a=pool.submit(admin.call,'/api/admin/site-settings',{'guide_slug':post['content']['id']})
            b=pool.submit(admin.call,path,{**post,'published':False})
            states=[a.result()[0],b.result()[0]]
        c.check('guide/publication race maintains invariant',sorted(states)==[200,400])
    finally:
        assert admin.call('/api/admin/site-settings',old)[0]==200
    current=next(p for p in admin.call('/api/admin/posts')[1] if p['content']['id']==post['content']['id'])
    post['revision']=current['revision'];post['published']=False
    assert admin.call(path,post)[0]==200;post['revision']+=1
    c.check('unpublish revokes public attachments',i.raw(anon,url)[0]==404)
    post['content']['kind']='project'
    c.check('paid introduction cannot expose deployment files',admin.call(path,post)[0]==400)
    post['content']['attachments']=[];post['content']['code']='secret code'
    c.check('paid introduction cannot expose inline code',admin.call(path,post)[0]==400)
    post['content']['code']='';post['published']=True
    assert admin.call(path,post)[0]==200;post['revision']+=1
    c.check('project cannot become guide',admin.call('/api/admin/site-settings',{'guide_slug':post['content']['id']})[0]==400)
    c.check('removed attachments retained privately for audit',i.raw(anon,url)[0]==404 and i.raw(admin,url)[0]==200)
    post['published']=False;assert admin.call(path,post)[0]==200
    id=fixture['device_id'];old_name=next(d for d in user.call('/api/devices')[1] if d['id']==id)['display_name']
    rename=f'/api/devices/{id}'
    c.check('anonymous rename denied',anon.call(rename,{'display_name':'invalid'})[0]==401)
    c.check('other owner rename denied',admin.call(rename,{'display_name':'invalid'})[0]==404)
    c.check('empty rename denied',user.call(rename,{'display_name':' '})[0]==400)
    assert user.call(rename,{'display_name':'이름 변경 검증'})[0]==200
    c.check('owner rename reflected in inventory',next(d for d in user.call('/api/devices')[1] if d['id']==id)['display_name']=='이름 변경 검증')
    assert user.call(rename,{'display_name':old_name})[0]==200
    c.check('rename produces audit record',int(c.sql("SELECT count(*) FROM audit_log WHERE action='device.rename'"))>=2)
    print(json.dumps({'passed':len(c.checks),'database':'shield_test','payments':'none'}))

if __name__=='__main__':main()
