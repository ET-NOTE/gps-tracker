#!/usr/bin/env python3
"""Image security/persistence checks against the disposable Shield preview only."""
import copy, hashlib, importlib.util, json, pathlib, secrets, struct, urllib.error, urllib.request, zlib
spec=importlib.util.spec_from_file_location('base',pathlib.Path(__file__).with_name('test-integration.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def png(width=400,height=240,noisy=False):
    def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data))
    rows=[]
    for y in range(height):
        row=bytes(v%16 for v in secrets.token_bytes(width)) if noisy else bytes((x//20+y//20)%2*140+50 for x in range(width))
        rows.append(b'\0'+row)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',width,height,8,0,0,0,0))+chunk(b'tEXt',b'private\0EXIF-TEST-PRIVATE')+chunk(b'IDAT',zlib.compress(b''.join(rows)))+chunk(b'IEND',b'')

def raw(client,path,data=None,origin=c.ORIGIN):
    req=urllib.request.Request(c.BASE+path,data=data,headers={'Origin':origin,'Content-Type':'image/png'})
    try:r=client.opener.open(req,timeout=25)
    except urllib.error.HTTPError as e:r=e
    return r.status,r.read(),dict(r.headers)

def main():
    assert c.sql('SELECT current_database()')=='shield_test'
    fixture=json.loads((c.ROOT/'operations-ui-fixture.json').read_text())
    admin,user,anon=c.Client(),c.Client(),c.Client()
    for client,key in [(admin,'admin_email'),(user,'user_email')]:
        assert client.call('/api/auth/login',{'email':fixture[key],'password':fixture['password']})[0]==200
    body=png();upload='/api/admin/post-images'
    c.check('anonymous upload denied',raw(anon,upload,body)[0]==401)
    c.check('ordinary user upload denied',raw(user,upload,body)[0]==403)
    c.check('cross-origin upload denied',raw(admin,upload,body,'https://evil.example')[0]==403)
    c.check('SVG masquerading as PNG rejected',raw(admin,upload,b'<svg onload="alert(1)"/>')[0]==400)
    c.check('corrupt image rejected',raw(admin,upload,body[:40])[0]==400)
    c.check('large dimensions rejected before decoding',raw(admin,upload,png(1601,1))[0]==400)
    c.check('request larger than 2 MiB rejected',raw(admin,upload,b'0'*(2*1024*1024+1))[0]==413)
    status,result,_=raw(admin,upload,body);assert status==200,(status,result)
    image=json.loads(result);url='/api/post-images/'+image['id']
    c.check('upload response contains bounded metadata',image['width']==400 and image['height']==240 and image['bytes']<=1572864)
    c.check('duplicate upload reuses stored asset',json.loads(raw(admin,upload,body)[1])['id']==image['id'])
    c.check('unattached image private',raw(anon,url)[0]==404 and raw(user,url)[0]==404)
    status,webp,headers=raw(admin,url)
    c.check('admin preview uses canonical WebP without metadata',status==200 and headers['content-type']=='image/webp' and b'EXIF-TEST-PRIVATE' not in webp and hashlib.sha256(webp).hexdigest()==image['id'])
    c.check('image response is non-cacheable and nosniff',headers['cache-control']=='no-store' and headers['x-content-type-options']=='nosniff')
    c.check('canonical WebP input supported',raw(admin,upload,webp)[0]==200)
    post={'content':{'id':'image-check-'+secrets.token_hex(4),'title':'사진 보안 검증','description':'미리보기 전용','category':'센서','level':'입문','minutes':5,'variant':'sensor','steps':['연결을 확인합니다.','수신을 확인합니다.'],'images':[{'id':image['id'],'after_step':1,'alt':'검증용 격자무늬','caption':'합성 테스트 이미지'}]},'published':False,'revision':0}
    path='/api/admin/posts/'+post['content']['id']
    invalid=copy.deepcopy(post);invalid['content']['images'][0]['id']='0'*64
    c.check('missing image reference rejects save',admin.call(path,invalid)[0]==400)
    invalid=copy.deepcopy(post);invalid['content']['images'][0]['after_step']=3
    c.check('out-of-range insertion rejected',admin.call(path,invalid)[0]==400)
    invalid=copy.deepcopy(post);invalid['content']['images']*=21
    c.check('more than 20 images rejected',admin.call(path,invalid)[0]==400)
    assert admin.call(path,post)[0]==200
    c.check('saved draft photo still private',raw(anon,url)[0]==404)
    post.update(revision=1,published=True);assert admin.call(path,post)[0]==200
    public=next(p for p in anon.call('/api/posts')[1] if p['id']==post['content']['id'])
    c.check('public post preserves image placement and caption',public['images']==post['content']['images'])
    c.check('published photo visible without login',raw(anon,url)[0]==200)
    c.check('stale revision cannot unpublish',admin.call(path,{**post,'published':False})[0]==409 and raw(anon,url)[0]==200)
    post.update(revision=2,published=False);assert admin.call(path,post)[0]==200
    c.check('unpublish revokes anonymous photo access',raw(anon,url)[0]==404)
    post.update(revision=3,published=True);post['content']['images']=[];assert admin.call(path,post)[0]==200
    c.check('removing last reference revokes public access but retains history',raw(anon,url)[0]==404 and raw(admin,url)[0]==200)
    post.update(revision=4,published=False);assert admin.call(path,post)[0]==200
    c.check('full-size noisy input fits service memory limit',raw(admin,upload,png(1600,1600,True))[0]==200)
    c.check('service still healthy after image processing',anon.call('/health')[0]==200)
    (c.ROOT/'image-ui-fixture.png').write_bytes(body)
    print(json.dumps({'passed':len(c.checks),'database':'shield_test','photo_fixture':'synthetic only'}))

if __name__=='__main__':main()
