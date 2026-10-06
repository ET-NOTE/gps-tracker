#!/usr/bin/env python3
"""Library ordering authorization, conflicts and publication in shield_test only."""
import concurrent.futures, copy, importlib.util, json, pathlib, secrets
spec=importlib.util.spec_from_file_location('base',pathlib.Path(__file__).with_name('test-integration.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def main():
    assert c.sql('SELECT current_database()')=='shield_test'
    fixture=json.loads((c.ROOT/'operations-ui-fixture.json').read_text())
    admin,other,user,anon=[c.Client() for _ in range(4)]
    for client,key in [(admin,'admin_email'),(other,'admin_email'),(user,'user_email')]:
        assert client.call('/api/auth/login',{'email':fixture[key],'password':fixture['password']})[0]==200
    route='/api/admin/library-order'; public='/api/library-order'
    before=admin.call(route)[1]; suffix=secrets.token_hex(4)
    category_a='order-a-'+suffix;category_b='order-b-'+suffix
    def create(letter,category,published=True):
        post={'content':{'id':'order-'+suffix+'-'+letter,'title':'순서 검증 '+letter,'description':'격리 환경 전용','category':category,'level':'입문','minutes':5,'variant':'board','steps':['순서를 확인합니다.']},'published':published,'revision':0}
        assert admin.call('/api/admin/posts/'+post['content']['id'],post)[0]==200
        post['revision']=1;return post
    a,b,draft=create('a',category_a),create('b',category_a),create('draft',category_a,False)
    d=create('c',category_b); aid,bid,did=[p['content']['id'] for p in [a,b,d]]
    order={'categories':[category_b,category_a],'lessons':{category_a:[bid,aid],category_b:[did]},'revision':before['revision']}
    c.check('admin order read protected',anon.call(route)[0]==401 and user.call(route)[0]==403)
    c.check('admin order write protected',anon.call(route,order)[0]==401 and user.call(route,order)[0]==403)
    c.check('foreign origin cannot reorder',admin.call(route,order,{'Origin':'https://gps.serial.kr'})[0]==403)
    patches=[{'categories':[category_a,category_a]}, {'categories':[' ']}, {'categories':['x'*41]}, {'categories':[category_a+' ']},
             {'revision':-1}, {'lessons':{category_a:[aid,aid]}}, {'lessons':{category_a:[aid],category_b:[aid]}}, {'lessons':{'missing-category':[aid]}}, {'lessons':{category_a:['../evil']}}]
    for patch in patches:c.check('invalid order rejected',admin.call(route,{**order,**patch})[0]==400)
    for patch in [{'categories':['missing-category'],'lessons':{}}, {'lessons':{category_b:[aid]}}, {'lessons':{category_a:[draft['content']['id']]}}, {'lessons':{category_a:['missing-lesson']}}]:
        c.check('stale or unpublished membership rejected',admin.call(route,{**order,**patch})[0]==409)
    original_posts=c.sql("SELECT jsonb_agg(to_jsonb(p) ORDER BY slug) FROM content_posts p")
    audit_before=int(c.sql("SELECT count(*) FROM audit_log WHERE action='library.order'"))
    status,saved,_=admin.call(route,order);assert status==200;order['revision']=saved['revision']
    c.check('both category and lesson positions persisted',saved==order and admin.call(route)[1]==order)
    c.check('public order omits revision and admin data',anon.call(public)[1]=={k:v for k,v in order.items() if k!='revision'})
    c.check('reorder leaves authored posts and revisions untouched',original_posts==c.sql("SELECT jsonb_agg(to_jsonb(p) ORDER BY slug) FROM content_posts p"))
    c.check('stale revision cannot overwrite ordering',admin.call(route,{**order,'revision':before['revision']})[0]==409)
    changes=[{**order,'categories':[category_a,category_b]}, {**order,'lessons':{category_a:[aid,bid],category_b:[did]}}]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda pair:pair[0].call(route,pair[1]),zip([admin,other],changes)))
    c.check('concurrent writes commit exactly one revision',sorted(r[0] for r in results)==[200,409])
    current=admin.call(route)[1]
    b['published']=False;assert admin.call('/api/admin/posts/'+bid,b)[0]==200;b['revision']+=1
    c.check('unpublished lesson removed from public ordering',bid not in anon.call(public)[1]['lessons'][category_a])
    d['content']['category']='renamed-'+suffix;assert admin.call('/api/admin/posts/'+did,d)[0]==200;d['revision']+=1
    visible=anon.call(public)[1]
    c.check('renamed category and former membership not exposed',category_b not in visible['categories'] and category_b not in visible['lessons'])
    c.check('membership changed since load requires refresh',admin.call(route,current)[0]==409)
    c.check('successful reorder audited only once per commit',int(c.sql("SELECT count(*) FROM audit_log WHERE action='library.order'"))-audit_before==2)
    # Restore the earlier preview settings; no production connection or content.
    status,restored,_=admin.call(route,{**before,'revision':current['revision']});assert status==200
    for post in [a,b,d,draft]:
        post['published']=False;assert admin.call('/api/admin/posts/'+post['content']['id'],post)[0]==200
    c.check('restore clears synthetic order and preserves current revision',admin.call(route)[1]==restored)
    print(json.dumps({'passed':len(c.checks),'database':'shield_test','payments':'none'}))
if __name__=='__main__':main()
