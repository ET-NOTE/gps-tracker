"""Loaded after the 22B isolated fixture setup, before it creates mappings."""
root=f'/corporate/vehicles/{v}/trips'
period=urlencode({'from':start.isoformat(),'to':end.isoformat()})
for minute in [1,4,8]:sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',%s,37.12,127.12,true)",(did,u,start+timedelta(minutes=minute)))
for kind,minute in [('wake',1),('sleep_enter',8)]:sql('INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,%s,%s)',(did,u,kind,start+timedelta(minutes=minute)))

def proposal(staff=sid,parent=None,kind=None):
 b={'request_key':str(uuid.uuid4()),'staff_id':staff,'binding_id':bind,'starts_at':start.isoformat(),'ends_at':a_end.isoformat()}
 if parent is not None:b.update(replaces_id=parent,replaces_revision=sql('SELECT revision FROM location_subject_mappings WHERE id=%s',(parent,)),change_kind=kind)
 return b
def create(b,code=200,who=token):
 status,r=request('POST','/corporate/subject-mappings',b,who);assert status==code,(status,r);return r.get('id')
def decide(mid,action='confirmed',who=dtoken,code=200,revision=None):
 rev=sql('SELECT revision FROM location_subject_mappings WHERE id=%s',(mid,)) if revision is None else revision
 status,r=request('POST',f'/privacy/subject-mappings/{mid}/decision',{'action':action,'revision':rev,'consent_version':'fleet-subject-v1'},who);assert status==code,(status,r)
def effective(mid):return sql('SELECT EXISTS(SELECT 1 FROM location_subject_effective WHERE id=%s)',(mid,))
def trips():
 status,r=request('GET',root+'?'+period,token=token);assert status==200,(status,r);return r

a=create(proposal());assert not trips();decide(a);assert effective(a) and len(trips())==1
subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=dict(os.environ,LEDGER='off',SUBJECTS='off'),check=True)
assert request('GET',f'/devices/{did}/locations/latest',token=token)[0]==423
subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=dict(os.environ,LEDGER='on',SUBJECTS='on'),check=True)
status,data=request('GET',f'/corporate/subject-mappings/{a}/locations',token=token);assert status==200 and len(data['items'])==3
before=sql('SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM location_provision_notices n WHERE owner_id=%s',(u,))
b=proposal(sid2,a,'correction');second=create(b)
assert create(b)==second
assert not effective(a) and not effective(second) and not trips()
assert request('GET',f'/corporate/subject-mappings/{a}/locations',token=token)[0]==404
create(dict(b,request_key=str(uuid.uuid4())),409);create(dict(b,staff_id=sid),409)
decide(second,who=dtoken,code=404);decide(second,who=d2token,revision=8,code=409)
decide(second,who=d2token);assert effective(second) and len(trips())==1
assert sql('SELECT count(*) FROM location_provision_notices WHERE owner_id=%s AND subject_id=%s',(u,s2))==1
assert sql('SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM location_provision_notices n WHERE owner_id=%s AND subject_id=%s',(u,s))==before
ok('correction suspends old reads, preserves notices and requires fresh exact-subject consent; duplicate/stale/cross-subject requests denied')

decide(second,'revoked',d2token);assert not effective(second) and not trips()
plain=create(proposal(sid2));decide(plain,who=d2token,code=409)
assert sql('SELECT status FROM location_subject_mappings WHERE id=%s',(plain,))=='pending'
create(proposal(sid2,second,'correction'),409);create(proposal(sid,second,'reconsent'),400)
third=create(proposal(sid2,second,'reconsent'));assert not effective(third)
decide(third,who=d2token);assert effective(third) and len(trips())==1
assert request('GET',f'/corporate/subject-mappings/{third}/locations',token=token)[0]==200
fourth=create(proposal(sid2,third,'correction'));decide(fourth,who=d2token);assert effective(fourth)
fifth=create(proposal(sid,fourth,'correction'));decide(fifth,code=409);assert not trips()
sixth=create(proposal(sid2,fifth,'correction'));decide(sixth,who=d2token);assert effective(sixth)
ok('reconsent restores only withdrawn subject and interval; new roots or other subjects cannot bypass withdrawal across multiple revisions')

assert request('DELETE',f'/corporate/staff/{sid2}/account',token=token)[0]==200
assert not effective(sixth) and not trips()
assert request('GET',f'/corporate/subject-mappings/{sixth}/locations',token=token)[0]==404
q=request('GET','/corporate/subject-mappings',token=token)[1]
assert next(x for x in q['items'] if x['id']==sixth)['effective'] is False
sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(u,sid2,s2))
assert not effective(sixth)
seventh=create(proposal(sid2,sixth,'correction'));decide(seventh,who=d2token);assert effective(seventh)
sixth=seventh
ok('unlinked staff is excluded from both readers and reported ineffective')

lease=psycopg.connect(dsn);lease.execute('SELECT pg_advisory_xact_lock_shared(210571031)')
create(proposal(sid2,sixth,'correction'),409);assert effective(sixth)
lease.rollback();lease.close()
create(proposal(sid2,sixth,'correction'),404,other['access_token'])
bad=proposal();bad['change_kind']='correction';create(bad,400)
try:sql('UPDATE location_subject_mappings SET subject_id=%s WHERE id=%s',(s,sixth))
except psycopg.errors.CheckViolation:pass
else:raise AssertionError('identity mutated')
ok('read/correction fence, tenant checks, shape validation and immutable DB identity prevent silent rewrites')

share='synthetic-'+tag
sql("INSERT INTO share_tokens(token,device_id,created_by,expires_at) VALUES(%s,%s,%s,now()+interval '1 day')",(share,did,u))
status,result=request('GET',f'/share/{share}/locations');assert status in (403,423,503),(status,result)
emptydid=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id",(u,'unmapped-'+tag))
v2=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'Unmapped fixture') RETURNING id",(u,))
sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at,is_primary) VALUES(%s,%s,%s,'unmapped',%s,true)",(u,v2,emptydid,start))
share2=share+'-empty';sql("INSERT INTO share_tokens(token,device_id,created_by,expires_at) VALUES(%s,%s,%s,now()+interval '1 day')",(share2,emptydid,u))
status,result=request('GET',f'/share/{share2}/locations');assert status in (403,423,503),(status,result)
assert request('POST',f'/devices/{emptydid}/shares',{'ttl_hours':1},token)[0]==409
share_id=sql('SELECT id FROM share_tokens WHERE token=%s',(share2,))
assert request('POST',f'/shares/{share_id}/extend',{'extra_hours':1},token)[0]==409
assert sql("SELECT count(*) FROM credit_log WHERE user_id=%s AND reason IN ('share_create','share_extend')",(u,))==0
ok('public sharing cannot reuse company consent or exploit an unmapped company SIM; create and extend denied before charging')

from privacy_subject_checkpoint import snapshot,replay
parent_before=sql('SELECT replaces_id FROM location_subject_mappings WHERE id=%s',(sixth,))
with db.cursor() as c:cp=snapshot(c)
decide(sixth,'revoked',d2token)
with db.transaction():
 with db.cursor() as c:replay(c,cp)
assert not effective(sixth) and sql('SELECT status FROM location_subject_mappings WHERE id=%s',(sixth,))=='revoked'
assert sql('SELECT replaces_id FROM location_subject_mappings WHERE id=%s',(sixth,))==parent_before
assert not sql('SELECT enabled OR push_enabled FROM location_subject_policy')
# Pre-108 snapshots have no lineage fields on original declarations.
import copy
old_shape=copy.deepcopy(cp)
for row in old_shape['location_subject_mappings']:
 if row.get('replaces_id') is None:
  for key in ('replaces_id','replaces_revision','change_kind'):row.pop(key,None)
with db.transaction():
 with db.cursor() as c:replay(c,old_shape)
assert not effective(sixth)
conflict=copy.deepcopy(cp)
next(row for row in conflict['location_subject_mappings'] if row['id']==sixth)['replaces_revision']+=1
try:
 with db.transaction():
  with db.cursor() as c:replay(c,conflict)
except ValueError:pass
else:raise AssertionError('changed lineage accepted by checkpoint')
assert sql('SELECT status FROM location_subject_mappings WHERE id=%s',(sixth,))=='revoked'
ok('stale or pre-108 checkpoint cannot restore revoked consent; conflicting lineage rejected atomically; replay disables delivery')
result={'suite':'22D correction and reconsent','passed':passed,'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'api_sha256':digest,'encrypted':os.environ.get('STORAGE')=='pilot','fixture':{'owner':u,'device':did},'production_modified':False,'external_messages':0}
(HERE/('out/round22d-encrypted.json' if result['encrypted'] else 'out/round22d-integration.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({'passed':len(passed),'schema':result['schema']}))
