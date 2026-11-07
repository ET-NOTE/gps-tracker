"""No production mode: real API/DB workflow in an internal Docker network only.

Round 17: the account package can carry the recorded facts of collection, use and provision of
location information for a period. This suite seeds synthetic records around those facts and
checks, through the public endpoints, that the file states exactly what was recorded, attributes
it to the account that received it, leaves out company-bound devices, and never contains a
coordinate, a link token or another person's data.
"""
import hashlib,os,pathlib,threading
helpers=(pathlib.Path(__file__).parent/'test_privacy_packages.py').read_text()
exec(compile(helpers.split('owner,other,admin=')[0],__file__,'exec'))
owner,other,admin,bulk=[account(n) for n in [71,72,73,74]]
uid,oid,bid=owner['user_id'],other['user_id'],bulk['user_id'];token=owner['access_token'];at=admin['access_token']
sql("UPDATE users SET role='admin' WHERE id=%s",(admin['user_id'],))
KST=timezone(timedelta(hours=9))
day=lambda n:(datetime.now(KST)-timedelta(days=n)).replace(hour=0,minute=0,second=0,microsecond=0)   # start of the Korean day n days ago
iso=lambda t:t.astimezone(timezone.utc).isoformat()
A,B=day(20),day(19)                       # two consecutive Korean days inside the period
FROM,UNTIL=day(25),day(15)                # the period: ten Korean days
LAT,LNG,FIXLAT,RAW,TOKEN='37.123456','127.654321','35.987654','private-raw-payload','tok-secret-'+tag
def device(n,user):return sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name) VALUES(%s,%s,'fixture','private-device-name') RETURNING id",(f'{tag}-facts-{n}',user))
def record(did,user,at,source='l80',fix=True,fixes=None):
 sql("INSERT INTO location_records(device_id,recorded_at,source,fix,lat,lng,raw,user_id,fixes_jsonb) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
     (did,at,source,fix,LAT if fix else None,LNG if fix else None,json.dumps({'secret':RAW,'lat':LAT}),user,json.dumps(fixes) if fixes is not None else None))
def event(did,user,kind,at,notified=None):
 return sql("INSERT INTO events(device_id,user_id,occurred_at,kind,data,notified_at) VALUES(%s,%s,%s,%s,%s,%s) RETURNING id",(did,user,at,kind,json.dumps({'lat':LAT,'lng':LNG,'secret':RAW}),notified))
d1,d2,dc,dm=device(1,uid),device(2,oid),device(3,uid),device(4,uid)
vehicle=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'company fixture') RETURNING id",(uid,))
sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,started_at) VALUES(%s,%s,%s,'company',now())",(vehicle,uid,dc))

# ---- collection -------------------------------------------------------------------------------------------
for minute in (1,2,3):record(d1,uid,A+timedelta(hours=9,minutes=minute))                        # three single fixes
record(d1,uid,A+timedelta(hours=9,minutes=4),fix=False)                                         # a report without a position
record(d1,uid,A+timedelta(hours=9,minutes=10),fixes=[{'lat':float(FIXLAT),'lng':129.345678,'sat':7,'at_ms':-n*1000} for n in range(4)])   # one batch of four
for minute in (20,21):record(d1,uid,A+timedelta(hours=10,minutes=minute),source='lte_gnss')
record(d1,uid,B+timedelta(minutes=30),source='phone')                                           # 00:30 Korean time: the next Korean day, the previous UTC day
record(d1,uid,FROM-timedelta(minutes=1));record(d1,uid,UNTIL+timedelta(minutes=1))              # just outside the period
record(d2,oid,A+timedelta(hours=9));record(dc,uid,A+timedelta(hours=9))                         # another account; a company-bound device
for minute in (1,2):record(dm,uid,A+timedelta(hours=12,minutes=minute))                         # received while the subject owned the SIM
sql("UPDATE devices SET owner_id=%s WHERE id=%s",(oid,dm))                                      # the SIM moves to another account
for minute in (1,2,3):record(dm,oid,B+timedelta(hours=12,minutes=minute))
sql("INSERT INTO collection_control_events(device_id,actor_id,paused,epoch,created_at) VALUES(%s,%s,true,%s,%s),(%s,%s,false,%s,%s),(%s,%s,true,%s,%s)",
    (d1,uid,str(uuid.uuid4()),A+timedelta(hours=13),d1,uid,str(uuid.uuid4()),A+timedelta(hours=14),dm,oid,str(uuid.uuid4()),B+timedelta(hours=13)))
# ---- use --------------------------------------------------------------------------------------------------
event(d1,uid,'geofence_in',A+timedelta(hours=9,minutes=5));event(d1,uid,'geofence_out',A+timedelta(hours=9,minutes=30),notified=A+timedelta(hours=9,minutes=31))
event(d1,uid,'cycle_first_fix',B+timedelta(hours=1));event(d1,uid,'wake',A+timedelta(hours=9));event(d1,uid,'geofence_in',UNTIL+timedelta(hours=1))
event(d2,oid,'geofence_in',A+timedelta(hours=9));event(dc,uid,'geofence_in',A+timedelta(hours=9));event(dm,oid,'geofence_in',B+timedelta(hours=12))
kept=sql("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis,model,created_at) VALUES(%s,%s,%s,'private-body','private-model',%s) RETURNING id",(uid,d1,A.date(),A+timedelta(hours=15)))
sql("INSERT INTO ai_analysis_requests(user_id,request_id,device_id,target_date,analysis_id,created_at) VALUES(%s,%s,%s,%s,%s,%s),(%s,%s,%s,%s,NULL,%s)",
    (uid,'kept-'+tag,d1,A.date(),kept,A+timedelta(hours=15),uid,'deleted-'+tag,d1,B.date(),B+timedelta(hours=15)))
sql("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis,created_at) VALUES(%s,%s,%s,'private-body',%s),(%s,%s,%s,'private-body',%s)",
    (uid,d1,(A-timedelta(days=1)).date(),A+timedelta(hours=16),oid,d2,A.date(),A+timedelta(hours=15)))   # one from before request receipts existed; one of another account
# ---- provision --------------------------------------------------------------------------------------------
def link(did,user,created,expires,revoked=None,note=None,views=0,last=None,suffix=''):
 return sql("INSERT INTO share_tokens(token,device_id,created_by,created_at,expires_at,revoked_at,note,view_count,last_viewed_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",(TOKEN+suffix,did,user,created,expires,revoked,note,views,last))
inside=link(d1,uid,A+timedelta(hours=8),A+timedelta(days=2),note='택배 기사님께',views=3,last=A+timedelta(hours=11),suffix='a')
spanning=link(d1,uid,FROM-timedelta(days=3),FROM+timedelta(days=1),revoked=FROM+timedelta(hours=2),suffix='b')     # made earlier, still open when the period begins
link(d1,uid,FROM-timedelta(days=9),FROM-timedelta(days=1),suffix='c');link(d2,oid,A,A+timedelta(days=2),note='other-private-note',suffix='d');link(dc,uid,A,A+timedelta(days=2),suffix='e')
sql("INSERT INTO credit_log(user_id,delta,balance,reason,ref_id,note,created_at) VALUES(%s,-5,95,'share_create',%s,'private-note',%s),(%s,-3,92,'share_extend',%s,'private-note',%s),(%s,10,102,'admin_grant',1,'private-note',%s),(%s,-5,95,'share_create',1,'private-note',%s)",
    (uid,d1,A+timedelta(hours=8),uid,inside,A+timedelta(hours=18),uid,A+timedelta(hours=19),oid,A+timedelta(hours=8)))
sql("INSERT INTO privacy_company_link_history(subject_id,company_owner_id,staff_id,action,effective_at) VALUES(%s,%s,901,'linked',%s),(%s,%s,901,'unlinked',%s),(%s,%s,902,'linked',%s),(%s,%s,903,'linked',%s)",
    (uid,oid,FROM-timedelta(days=30),uid,oid,A+timedelta(hours=20),uid,oid,UNTIL+timedelta(days=1),oid,uid,A))

def flow(session,scope):
 """An access request of that account, taken into review by the administrator."""
 s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':scope,'password':password},session['access_token']);assert s==202,(s,r)
 s,r,_=call('PATCH',f"/admin/privacy/requests/{r['id']}",{'revision':r['revision'],'status':'in_review','message':'Review fixture','evidence_reference':'fixture','due_at':(datetime.now(timezone.utc)+timedelta(days=2)).isoformat()},at);assert s==200,(s,r)
 return r['id']
def grant(rid,sections=None,period=None,who=at):
 rev=call('GET',f'/admin/privacy/requests/{rid}',token=at)[1]['request']['revision']
 body={'revision':rev,'confirmed':True,'documents':[]}
 if sections is not None:body['sections']=sections
 if period:body.update(facts_from=iso(period[0]),facts_until=iso(period[1]))
 return call('POST',f'/admin/privacy/requests/{rid}/account-packages',body,who)
def dl(p,who=token,pw=password):
 sql('DELETE FROM privacy_result_limits')   # this suite downloads more often than one person may in fifteen minutes
 return call('POST',f"/privacy/account-packages/{p['id']}/account",{'password':pw},who)
prepared=lambda rid:sql("SELECT count(*) FROM privacy_account_package_events WHERE request_id=%s AND action='account_prepared'",(rid,))
rid=flow(owner,'Collection, use and provision facts fixture')
sql("INSERT INTO privacy_deliveries(request_id,created_by,device_ids,from_at,until_at,created_at,expires_at) VALUES(%s,%s,%s,%s,%s,%s,%s)",(rid,admin['user_id'],[d1],A,B,A+timedelta(hours=21),A+timedelta(hours=40)))
delivery=sql('SELECT max(id) FROM privacy_deliveries WHERE request_id=%s',(rid,))
sql("INSERT INTO privacy_delivery_events(delivery_id,actor_id,action,record_count,sha256,created_at) VALUES(%s,%s,'issued',NULL,NULL,%s),(%s,%s,'download_prepared',12,%s,%s)",(delivery,admin['user_id'],A+timedelta(hours=21),delivery,uid,'a'*64,A+timedelta(hours=22)))

# ---- 1. the period belongs to the section -------------------------------------------------------------------
s,basic,_=grant(rid);assert s==200 and basic['sections']==[] and basic['facts_from'] is None and basic['facts_until'] is None,(s,basic)
s,data,_=dl(basic);assert s==200 and data['additional']=={} and len(data['unselected_sections'])==4 and 'location_facts' in data['unselected_sections']
for sections,period in [(['location_facts'],None),(['transactions'],(FROM,UNTIL)),(None,(FROM,UNTIL)),(['location_facts'],(UNTIL,FROM)),(['location_facts'],(FROM,FROM)),
                        (['location_facts'],(day(400),day(33))),(['location_facts'],(day(-1),day(-3))),(['location_facts','location_facts'],(FROM,UNTIL))]:
 s,r,_=grant(rid,sections,period);assert s==400,(sections,period,s,r)
assert grant(rid,['location_facts'],(FROM,UNTIL),token)[0]==403
before=datetime.now(timezone.utc)
s,open_end,_=grant(rid,['location_facts'],(day(3),day(-2)));assert s==200,(s,open_end)                     # an end in the future is cut at the moment of issue
ended=datetime.fromisoformat(open_end['facts_until'].replace('Z','+00:00'));assert before-timedelta(seconds=5)<=ended<=datetime.now(timezone.utc)+timedelta(seconds=5),open_end
for values in [("ARRAY['location_facts']",'NULL','NULL'),("ARRAY['transactions']","now()-interval '2 days'","now()-interval '1 day'"),("ARRAY['location_facts']","now()-interval '400 days'","now()-interval '1 day'"),
               ("ARRAY['location_facts']","now()-interval '1 day'","now()+interval '1 day'"),("ARRAY['location_facts','raw']","now()-interval '2 days'","now()-interval '1 day'")]:
 try:sql(f"INSERT INTO privacy_account_packages(request_id,created_by,documents,sections,facts_from,facts_until) VALUES(%s,%s,'[]',{values[0]},{values[1]},{values[2]})",(rid,admin['user_id']));raise SystemExit(f'the database accepted {values}')
 except psycopg2.errors.CheckViolation:pass
check('a grant without the section has no period and stays basic; the section needs a past period of at most 366 days, an end in the future is cut at the moment of issue; the database enforces the same; non-admin refused')

# ---- 2. collection ------------------------------------------------------------------------------------------
s,p,_=grant(rid,['location_facts'],(FROM,UNTIL));assert s==200 and p['sections']==['location_facts'],(s,p)
assert dl(basic)[0]==410 and dl(p,other['access_token'])[0]==404 and dl(p,pw='wrong')[0]==401
count=prepared(rid);s,data,h=dl(p);body=last_body;assert s==200,(s,data)
assert h['Cache-Control']=='no-store, private' and data['format']=='gps-personal-account-v2' and data['coverage'][-1]=='location_facts' and sorted(data['unselected_sections'])==['activity_metadata','contact_settings','transactions']
assert prepared(rid)==count+1 and sql("SELECT sha256 FROM privacy_account_package_events WHERE request_id=%s AND action='account_prepared' ORDER BY id DESC LIMIT 1",(rid,))==hashlib.sha256(body).hexdigest()
facts=data['additional']['location_facts']
# Optional: keep the real response for the screen review harness and the round document (synthetic records only).
if os.environ.get('GPS_UI_FIXTURES'):pathlib.Path(os.environ['GPS_UI_FIXTURES'],'location-facts-download.json').write_bytes(body)
same=lambda a,b:datetime.fromisoformat(a.replace('Z','+00:00'))==b
assert same(facts['period']['from'],FROM) and same(facts['period']['until'],UNTIL) and facts['period']['date_timezone']=='Asia/Seoul'
daily={(r['device_id'],r['date'],r['method']):(r['reports'],r['points'],r['status_only_reports']) for r in facts['collection']['daily']}
assert daily=={(d1,str(A.date()),'device_gnss'):(4,7,1),(d1,str(A.date()),'modem_gnss'):(2,2,0),(d1,str(B.date()),'phone'):(1,1,0),(dm,str(A.date()),'device_gnss'):(2,2,0)},daily
row=next(r for r in facts['collection']['daily'] if (r['device_id'],r['method'])==(d1,'device_gnss'))
assert same(row['first_at'],A+timedelta(hours=9,minutes=1)) and same(row['last_at'],A+timedelta(hours=9,minutes=10))
assert [(c['device_id'],c['action']) for c in facts['collection']['collection_changes']]==[(d1,'paused'),(d1,'resumed')] and same(facts['collection']['collection_changes'][0]['at'],A+timedelta(hours=13))
assert facts['separate_review']=={'devices_with_company_vehicle_history_or_erased':1}
for secret in [LAT,LNG,FIXLAT,'129.345678',RAW,TOKEN,'private-body','private-model','private-device-name','private-note','other-private-note',other['email']]:assert secret.encode() not in body,secret
assert not any(key in body for key in [b'"lat"',b'"lng"',b'"raw"',b'"token"',b'"data"',b'fixes_jsonb'])
check('collection: reports and points per Korean day, device and method with the first and last time; a report without a position is counted apart; the account at receipt decides, so a SIM that moved keeps the earlier days only; a company-bound device is left out and counted; no coordinate, payload, token or name appears in the file')

# ---- 3. use -------------------------------------------------------------------------------------------------
events=[(e['device_id'],e['kind']) for e in facts['use']['location_events']]
assert events==[(d1,'geofence_in'),(d1,'geofence_out'),(d1,'cycle_first_fix')],events
assert facts['use']['location_events'][0]['notification_processed_at'] is None and same(facts['use']['location_events'][1]['notification_processed_at'],A+timedelta(hours=9,minutes=31))
assert set(facts['use']['location_events'][0])=={'device_id','kind','at','notification_processed_at'}
analyses=[(a['device_id'],a['target_date']) for a in facts['use']['ai_analyses']]
assert analyses==[(d1,str(A.date())),(d1,str((A-timedelta(days=1)).date())),(d1,str(B.date()))] and set(facts['use']['ai_analyses'][0])=={'device_id','target_date','requested_at'},analyses
check('use: zone entries and exits and the first position of a cycle with the time the notification was processed, nothing of other kinds, other accounts or company-bound devices; AI analyses once each, including one whose report was deleted and one from before receipts were kept')

# ---- 4. provision -------------------------------------------------------------------------------------------
links={l['id']:l for l in facts['provision']['share_links']}
assert set(links)=={inside,spanning} and links[inside]['note']=='택배 기사님께' and links[inside]['view_count']==3 and same(links[inside]['last_viewed_at'],A+timedelta(hours=11)) and same(links[spanning]['revoked_at'],FROM+timedelta(hours=2))
assert set(links[inside])=={'id','device_id','created_at','expires_at','revoked_at','view_count','last_viewed_at','note'}
assert [c['action'] for c in facts['provision']['share_link_charges']]==['created','extended']
[given]=facts['provision']['location_file_deliveries']
assert given['delivery_id']==delivery and given['device_ids']==[d1] and [(d['record_count']) for d in given['downloads']]==[12] and same(given['records_from'],A)
assert [(c['company_link'],c['action']) for c in facts['provision']['company_links']]==[(1,'linked'),(1,'unlinked')] and set(facts['provision']['company_links'][0])=={'company_link','action','effective_at'}
assert len(facts['not_recorded'])==8 and all(isinstance(n,str) and len(n)>20 for n in facts['not_recorded']) and '좌표' in facts['notice'] and '제공 완료를 뜻하지 않습니다' in facts['notice']
assert '조회 기간은 원본 위치정보의 보관 기간을 뜻하지 않습니다' in facts['not_recorded'][7]
assert '1년' not in facts['not_recorded'][7]
check('provision: the subject\'s own share links that were open in the period with view count and last view but no token, the charges that outlive deleted links, location files given to the subject with their downloads, and company link changes without naming the company; what the system does not record is listed')

# ---- 5. the other account, and stability ---------------------------------------------------------------------
orid=flow(other,'Other account fixture')
s,op,_=grant(orid,['location_facts'],(FROM,UNTIL));assert s==200
s,odata,_=dl(op,other['access_token']);assert s==200,(s,odata)
ofacts=odata['additional']['location_facts']
assert {(r['device_id'],r['date'],r['method']):(r['reports'],r['points']) for r in ofacts['collection']['daily']}=={(d2,str(A.date()),'device_gnss'):(1,1),(dm,str(B.date()),'device_gnss'):(3,3)}
assert [(c['device_id'],c['action']) for c in ofacts['collection']['collection_changes']]==[(dm,'paused')] and [(e['device_id'],e['kind']) for e in ofacts['use']['location_events']]==[(d2,'geofence_in'),(dm,'geofence_in')]
assert [l['note'] for l in ofacts['provision']['share_links']]==['other-private-note'] and ofacts['provision']['company_links']==[{'company_link':1,'action':'linked','effective_at':ofacts['provision']['company_links'][0]['effective_at']}]
assert ofacts['separate_review']=={'devices_with_company_vehicle_history_or_erased':0} and '택배'.encode() not in last_body
sql("UPDATE devices SET owner_id=%s WHERE id=%s",(oid,d1))                                                 # the subject's own device changes hands afterwards
s,again,_=dl(p);assert s==200 and again['additional']['location_facts']['collection']==facts['collection'] and again['additional']['location_facts']['use']==facts['use']
sql("UPDATE devices SET owner_id=%s WHERE id=%s",(uid,d1))
assert call('POST',f"/admin/privacy/account-packages/{p['id']}/revoke",{},at)[0]==200 and dl(p)[0]==410
check('the other account sees its own facts only, including the later days of the SIM that moved; a later change of ownership does not change what the earlier account receives; a revoked grant answers 410')

# ---- 6. limits ---------------------------------------------------------------------------------------------
many=[device(10+n,bid) for n in range(4)]
sql("INSERT INTO location_records(device_id,recorded_at,source,fix,lat,lng,user_id) SELECT d,now()-g*interval '1 day'+interval '1 hour',s,true,1,1,%s FROM generate_series(1,360) g,unnest(%s::bigint[]) d,unnest(ARRAY['l80','lte_gnss','phone']) s",(bid,many))
brid=flow(bulk,'Limits fixture')
s,wide,_=grant(brid,['location_facts'],(day(362),day(0)));assert s==200
count=prepared(brid);s,r,_=dl(wide,bulk['access_token']);assert s==409 and '기간' in r['error'] and prepared(brid)==count,(s,r)
s,narrow,_=grant(brid,['location_facts'],(day(31),day(1)));assert s==200
s,r,_=dl(narrow,bulk['access_token']);assert s==200 and 300<len(r['additional']['location_facts']['collection']['daily'])<=372,(s,len(r['additional']['location_facts']['collection']['daily']))
sql("INSERT INTO events(device_id,user_id,occurred_at,kind) SELECT %s,%s,now()-interval '2 days'-g*interval '1 second','geofence_in' FROM generate_series(1,2001) g",(many[0],bid))
count=prepared(brid);s,r,_=dl(narrow,bulk['access_token']);assert s==409 and prepared(brid)==count,(s,r)
sql("DELETE FROM events WHERE user_id=%s",(bid,))
# The statement time limit of the download: a table that cannot be read in time is too much for one file, not a server error.
def hold():
 with psycopg2.connect(f"postgres://postgres:closure-test-only@{di['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_closure_test") as blocker,blocker.cursor() as c:
  c.execute('LOCK TABLE location_records IN ACCESS EXCLUSIVE MODE');started.set();time.sleep(13)
started=threading.Event();holder=threading.Thread(target=hold);holder.start();started.wait(10)
try:count=prepared(brid);s,r,_=call('POST',f"/privacy/account-packages/{narrow['id']}/account",{'password':password},bulk['access_token']);assert s==409 and '기간' in r['error'] and prepared(brid)==count,(s,r)
finally:holder.join()
s,r,_=dl(narrow,bulk['access_token']);assert s==200
check('more than 4,000 daily rows or 2,000 events stop the download with 409 and no prepared-file record, and a narrower period works; reaching the statement time limit also answers 409, and the next download works')

report={'integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations')}
assert report['schema']>=99,report['schema']
(pathlib.Path(__file__).parent/'location-facts-validation.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
