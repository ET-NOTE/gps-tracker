#!/usr/bin/env python3
"""Thumbnail ownership/publication/conflict regression in shield_test only."""
import copy, importlib.util, json, pathlib, secrets
spec=importlib.util.spec_from_file_location('images',pathlib.Path(__file__).with_name('test-post-images.py'))
i=importlib.util.module_from_spec(spec);spec.loader.exec_module(i)
c=i.c
def main():
    assert c.sql('SELECT current_database()')=='shield_test'
    fixture=json.loads((c.ROOT/'operations-ui-fixture.json').read_text())
    admin,user,anon=c.Client(),c.Client(),c.Client()
    for client,key in [(admin,'admin_email'),(user,'user_email')]:
        assert client.call('/api/auth/login',{'email':fixture[key],'password':fixture['password']})[0]==200
    def upload():
        status,body,_=i.raw(admin,'/api/admin/post-images',i.png(320,180,True));assert status==200
        return json.loads(body)['id']
    a,b=upload(),upload();url=lambda id:'/api/post-images/'+id
    suffix=secrets.token_hex(4);category='thumbnail-'+suffix
    config={'category':category,'thumbnail':{'id':b,'alt':'카테고리 시험'},'revision':0};route='/api/admin/category-thumbnails'
    c.check('admin category list protected',anon.call(route)[0]==401 and user.call(route)[0]==403)
    c.check('category save admin only',anon.call(route,config)[0]==401 and user.call(route,config)[0]==403)
    c.check('category foreign origin denied',admin.call(route,config,{'Origin':'https://gps.serial.kr'})[0]==403)
    for patch in [{'category':' '},{'category':'a'*41},{'thumbnail':{'id':'0'*64,'alt':'missing'}},{'thumbnail':{'id':b,'alt':' '}},{'revision':-1}]:
        c.check('invalid category thumbnail rejected',admin.call(route,{**config,**patch})[0]==400)
    post={'content':{'id':'thumbnail-check-'+suffix,'title':'썸네일 검증','description':'격리 환경 전용','category':category,'level':'입문','minutes':5,'variant':'board','steps':['첫 순서\n! 안내 문장\n다음 순서'],'thumbnail':{'id':a,'alt':'강의 시험'}},'published':False,'revision':0}
    path='/api/admin/posts/'+post['content']['id']
    invalid=copy.deepcopy(post);invalid['content']['thumbnail']['id']='0'*64
    c.check('missing lesson thumbnail rejected',admin.call(path,invalid)[0]==400)
    invalid=copy.deepcopy(post);invalid['content']['thumbnail']['alt']=' '
    c.check('empty lesson thumbnail alt rejected',admin.call(path,invalid)[0]==400)
    assert admin.call(path,post)[0]==200;post['revision']+=1
    c.check('draft thumbnail remains private',i.raw(anon,url(a))[0]==404 and i.raw(admin,url(a))[0]==200)
    status,saved,_=admin.call(route,config);assert status==200;config['revision']=saved['revision']
    c.check('draft-only category remains private',i.raw(anon,url(b))[0]==404 and not any(x['category']==category for x in anon.call('/api/category-thumbnails')[1]))
    post['published']=True;assert admin.call(path,post)[0]==200;post['revision']+=1
    c.check('published lesson and category photos public',i.raw(anon,url(a))[0]==200 and i.raw(anon,url(b))[0]==200)
    published=next(x for x in anon.call('/api/posts')[1] if x['id']==post['content']['id'])
    c.check('thumbnail and notice text preserved',published['thumbnail']==post['content']['thumbnail'] and published['steps']==post['content']['steps'])
    c.check('public category list excludes admin metadata',next(x for x in anon.call('/api/category-thumbnails')[1] if x['category']==category)=={'category':category,'thumbnail':config['thumbnail']})
    post['published']=False;assert admin.call(path,post)[0]==200;post['revision']+=1
    c.check('unpublish revokes both photos',i.raw(anon,url(a))[0]==404 and i.raw(anon,url(b))[0]==404)
    post['published']=True;post['content']['thumbnail']=None
    assert admin.call(path,post)[0]==200;post['revision']+=1
    c.check('removing post thumbnail only revokes its photo',i.raw(anon,url(a))[0]==404 and i.raw(anon,url(b))[0]==200)
    config['thumbnail']=None;status,saved,_=admin.call(route,config);assert status==200
    c.check('removing category revokes photo but retains admin access',i.raw(anon,url(b))[0]==404 and i.raw(admin,url(b))[0]==200)
    c.check('stale category revision cannot resurrect image',admin.call(route,{**config,'thumbnail':{'id':b,'alt':'stale'}})[0]==409)
    config.update(thumbnail={'id':a,'alt':'공유 사진'},revision=saved['revision']);status,saved,_=admin.call(route,config);assert status==200
    post['content']['thumbnail']={'id':a,'alt':'강의 시험'};post['content']['images']=[{'id':a,'alt':'본문 시험','after_step':1,'caption':''}]
    assert admin.call(path,post)[0]==200;post['revision']+=1
    c.check('same thumbnail and body photo has one link',c.sql(f"SELECT count(*) FROM post_image_links WHERE post_slug='{post['content']['id']}' AND image_id='{a}'")=='1')
    assert admin.call(route,{**config,'thumbnail':None,'revision':saved['revision']})[0]==200
    c.check('shared body reference keeps photo public',i.raw(anon,url(a))[0]==200)
    post['published']=False;assert admin.call(path,post)[0]==200;post['revision']+=1
    c.check('removed photos retained for history',c.sql(f"SELECT count(*) FROM post_images WHERE id IN ('{a}','{b}') AND attached_at IS NOT NULL")=='2')
    c.check('category mutation audited',int(c.sql(f"SELECT count(*) FROM audit_log WHERE action='category.thumbnail' AND target_id='{category}'"))==4)
    (c.ROOT/'thumbnail-ui-fixture.json').write_text(json.dumps({'post_id':post['content']['id'],'category':category}))
    print(json.dumps({'passed':len(c.checks),'database':'shield_test'}))
if __name__=='__main__':main()
