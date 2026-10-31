"""Clone-only query equivalence against migration 64; all fixtures roll back."""
import datetime as dt,json,pathlib,re,sys,tarfile,urllib.parse,uuid
import psycopg2
from psycopg2.extras import execute_values
c={k:v.strip().strip('"').strip("'") for k,v in (s.split('=',1) for s in pathlib.Path(sys.argv[1]).read_text().splitlines() if '=' in s and not s.startswith('#'))}
assert urllib.parse.urlsplit(c['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
stage=pathlib.Path(__file__).parent
with tarfile.open(stage/'source-final.tar.gz') as t:
 old=t.extractfile('gps-tracker-api/migrations/0064_server_coordinate_speed.sql').read().decode()
 migration=t.extractfile('gps-tracker-api/migrations/0080_location_query_payloads.sql').read().decode()
 api_source=t.extractfile('gps-tracker-api/src/routes/devices.rs').read().decode()
aggregate=re.search(r'"(WITH speed AS MATERIALIZED \(.*?ORDER BY time_bucket\(\$4::text::interval,recorded_at\))",',api_source,re.S).group(1)
old_aggregate='SELECT jsonb_build_object'+aggregate.split('SELECT jsonb_build_object',1)[1]
old_aggregate=old_aggregate.replace('FROM speed','FROM location_speed_points_between($1,$5,$2,$3)')
points='CREATE OR REPLACE FUNCTION location_points_between'+old.split('CREATE OR REPLACE FUNCTION location_points_between')[1].split('$$;')[0]+'$$;'
speed='CREATE FUNCTION location_speed_points_between'+old.split('CREATE FUNCTION location_speed_points_between')[1].split('$$;')[0]+'$$;'
points=points.replace('FUNCTION location_points_between','FUNCTION pg_temp.before_points')
speed=speed.replace('FUNCTION location_speed_points_between','FUNCTION pg_temp.before_speeds').replace('FROM location_points_between(', 'FROM pg_temp.before_points(')
checks=0
with psycopg2.connect(c['DATABASE_URL']) as db:
 try:
  q=db.cursor();q.execute("SET LOCAL jit=off; SET LOCAL statement_timeout='30s'")
  q.execute(points);q.execute(speed);q.execute(migration)
  tag=uuid.uuid4().hex
  q.execute("INSERT INTO users(email,password_hash,phone) VALUES(%s,'','01000000000'),(%s,'','01000000000') RETURNING id",(tag+'@query.invalid',tag+'b@query.invalid'));a,b=[v[0] for v in q.fetchall()]
  q.execute("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",('query-'+tag,a));did=q.fetchone()[0]
  start=dt.datetime(2026,10,19,15,tzinfo=dt.timezone.utc)
  rows=[]
  for i in range(80):
   anchor=start+dt.timedelta(seconds=60*i)
   fixes=[{'at_ms':-60000+k*5000,'up_ms':i*60000+k*5000,'lat':35+i*.0001+k*.00001,'lng':127,'sat':12,'speed_kmh':120} for k in range(12)]
   raw=json.dumps({'boot_id':'boot-'+str(i//40),'cbc_mv':4132,'payload':'x'*5000,'fixes':fixes})
   rows.append((did,a,anchor,'l80',True,35,127,12,raw,json.dumps(fixes)))
  # A duplicate standalone point loses to a later batch carrying the same sample.
  rows.append((did,a,start-dt.timedelta(seconds=5),'l80',True,31,120,2,'{}',None))
  rows.append((did,a,start,'phone',True,35,127,12,'{"boot":"phone"}',None))
  rows.append((did,a,start+dt.timedelta(seconds=5),'phone',False,None,None,None,'{}',None))
  rows.append((did,b,start+dt.timedelta(seconds=7),'l80',True,10,11,12,'{"private":true}',None))
  # Anchors on either side of the requested day must not hide in-range points.
  rows.append((did,a,start-dt.timedelta(days=40),'lte_gnss',False,None,None,None,'{}',json.dumps([{'at_ms':40*86400000+15000,'lat':36,'lng':128}])))
  rows.append((did,a,start+dt.timedelta(days=40),'lte_gnss',False,None,None,None,'{}',json.dumps([{'at_ms':-40*86400000+20000,'lat':36,'lng':128}])))
  for i,v in enumerate(('[]','{}','null')):rows.append((did,a,start+dt.timedelta(seconds=30+i),'empty',False,None,None,None,'{}',v))
  execute_values(q,'INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat,raw,fixes_jsonb) VALUES %s',rows)
  windows=[(None,None),(start,start),(start,start+dt.timedelta(hours=1)),(None,start),(start,None),(start-dt.timedelta(seconds=12),start+dt.timedelta(seconds=17)),(start+dt.timedelta(days=2),start+dt.timedelta(days=3)),(start+dt.timedelta(seconds=20),start+dt.timedelta(seconds=15))]
  for owner in (a,b):
   for lo,hi in windows:
    for before,after in [('pg_temp.before_points','location_points_between'),('pg_temp.before_speeds','location_speed_points_between')]:
     def values(fn):
      q.execute('SELECT to_jsonb(p) FROM '+fn+'(%s,%s,%s,%s) p ORDER BY recorded_at,source',(did,owner,lo,hi));return [x[0] for x in q.fetchall()]
     assert values(before)==values(after),(owner==a,str(lo),str(hi),after)
     checks+=1
  # Late insertion and deletion must affect subsequent speeds immediately.
  q.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat,raw) VALUES(%s,%s,%s,'l80',true,35.0001,127,12,'{}')",(did,a,start+dt.timedelta(seconds=22)))
  q.execute("DELETE FROM location_records WHERE device_id=%s AND source='l80' AND recorded_at=%s",(did,start+dt.timedelta(seconds=60)))
  for before,after in [('pg_temp.before_points','location_points_between'),('pg_temp.before_speeds','location_speed_points_between')]:
   owner=a;lo=start;hi=start+dt.timedelta(hours=1)
   assert values(before)==values(after);checks+=1
  aggregate_checks=0
  def aggregated(query,owner,interval,lo,hi,exclusive):
   args=[did,lo,hi,interval,owner,exclusive]
   query=re.sub(r'\$(\d+)',lambda m:q.mogrify('%s',(args[int(m[1])-1],)).decode(),query)
   q.execute(query);return [r[0] for r in q.fetchall()]
  for owner in (a,b):
   for interval in ('1 minute','5 minutes','1 hour'):
    for exclusive in (False,True):
     args=(owner,interval,start,start+dt.timedelta(minutes=1),exclusive)
     assert aggregated(old_aggregate,*args)==aggregated(aggregate,*args),(owner,interval,exclusive)
     aggregate_checks+=1
  for minutes,interval in ((1,'1 minute'),(5,'5 minutes'),(60,'1 hour')):
   middle=start+dt.timedelta(minutes=minutes);end=middle+dt.timedelta(minutes=minutes)
   whole=aggregated(aggregate,a,interval,start,end,True)
   parts=aggregated(aggregate,a,interval,start,middle,True)+aggregated(aggregate,a,interval,middle,end,True)
   assert whole==parts,interval
   aggregate_checks+=1
  print(json.dumps({'query_equivalence_checks':checks,'aggregate_equivalence_checks':aggregate_checks,'raw_payloads_and_metadata':True,'owner_and_source_isolation':True,'far_anchor_batches':True,'empty_invalid_batches':True,'null_inclusive_and_reverse_windows':True,'late_insert_delete':True}))
 finally:db.rollback()
