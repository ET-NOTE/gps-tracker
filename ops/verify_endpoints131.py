"""Compare real old/new endpoint SQL on encrypted data under the runtime role."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import uuid
import load_runtime131 as l


def endpoint_sql(path):
    source=path.read_text()
    part=source[source.index('async fn collect_trip_endpoints('):]
    return re.search(r'r#"(.*?)"#',part,re.S)[1]


def verify():
    old=l.ROOT/'corporate-baseline131.rs';new=l.ROOT/'corporate-candidate131.rs'
    db=l.connect();db.autocommit=False;checks=[];plans={}
    try:
        q=db.cursor();tag='endpoint131-'+uuid.uuid4().hex
        owner,foreign=l.b.fixture()['users']
        q.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id",(owner,tag))
        did=q.fetchone()[0];start=dt.datetime(2026,10,3,9,tzinfo=dt.timezone.utc)
        records=[(-1,'l80',True,30.,120.,owner),(0,'l80',True,31.,121.,owner),
            (1,'l80',False,None,None,owner),(2,'l80',True,None,None,owner),
            (3,'l80',True,32.,122.,owner),(3,'phone',True,33.,123.,owner),
            (4,'l80',True,95.,125.,owner),(5,'l80',True,34.,None,owner),
            (6,'l80',True,35.,126.,foreign),(7,'l80',True,36.,127.,owner)]
        for seconds,source,fix,lat,lng,uid in records:
            q.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,raw) VALUES(%s,%s,%s,%s,%s,%s,%s,'{}')",
                (did,uid,start+dt.timedelta(seconds=seconds),source,fix,lat,lng))
        # A batch contains points on both sides of its anchor. Keep sealing and
        # bound triggers enabled; the production function decides visibility.
        q.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,raw,fixes_jsonb) VALUES(%s,%s,%s,'lte_gnss',true,37,128,'{}',%s)",
            (did,owner,start+dt.timedelta(seconds=20),json.dumps([dict(at_ms=-10000,lat=37,lng=128),dict(at_ms=10000,lat=38,lng=129)])))
        q.execute('SET LOCAL ROLE gps_runtime')
        q.execute("SET LOCAL statement_timeout='20s'")
        for name,path in [('before',old),('after',new)]:
            q.execute('PREPARE endpoints_'+name+'(bigint,timestamptz[],timestamptz[],bigint) AS '+endpoint_sql(path))
        intervals=[(-2,0),(0,0),(1,2),(2,5),(3,3),(4,4),(5,5),(6,6),(7,7),(8,31),(31,33),(5,4)]
        for uid in (owner,foreign):
            for group in [intervals,intervals[:1],intervals[2:5],list(reversed(intervals))]:
                begins=[start+dt.timedelta(seconds=a) for a,b in group]
                ends=[start+dt.timedelta(seconds=b) for a,b in group]
                values=[]
                for label in ('before','after'):
                    q.execute('EXECUTE endpoints_'+label+'(%s,%s,%s,%s)',(did,begins,ends,uid));values.append(q.fetchall())
                assert values[0]==values[1],('endpoint semantics',uid==owner,group,values)
                checks.append(dict(owner_matches=uid==owner,intervals=len(group),equal=True,
                    digest=hashlib.sha256(json.dumps(values[0],default=str).encode()).hexdigest()))
        d=l.b.fixture()['devices'][4]
        q.execute("SELECT occurred_at,kind FROM gps_read_events WHERE device_id=%s AND user_id=%s AND kind IN ('wake','sleep_enter') ORDER BY occurred_at",(d['device_id'],d['user_id']))
        events=q.fetchall();begins=[at for at,kind in events if kind=='wake'];ends=[at for at,kind in events if kind=='sleep_enter']
        assert len(begins)==len(ends)==31
        month=[]
        for label in ('before','after'):
            q.execute('EXECUTE endpoints_'+label+'(%s,%s,%s,%s)',(d['device_id'],begins,ends,d['user_id']));month.append(q.fetchall())
            q.execute('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE endpoints_'+label+'(%s,%s,%s,%s)',(d['device_id'],begins,ends,d['user_id']))
            plans[label]=q.fetchone()[0]
        assert month[0]==month[1] and len(month[0])==31
        q.execute('RESET ROLE')
        q.execute('SELECT count(*) FROM location_records WHERE device_id=%s AND (lat IS NOT NULL OR lng IS NOT NULL OR raw IS NOT NULL OR fixes_jsonb IS NOT NULL)',(did,))
        assert q.fetchone()==(0,)
        l.save('endpoints131',dict(checks=checks,monthly_rows=31,monthly_equal=True,plans=plans,
            sources={name:hashlib.sha256(p.read_bytes()).hexdigest() for name,p in [('baseline',old),('candidate',new)]},
            plaintext_stored=0,transaction_rolled_back=True,production_modified=False))
        print('PASS131 endpoint SQL: encrypted edge intervals, ownership, monthly31rows and actual plans',flush=True)
    finally:db.rollback();db.close()


if __name__=='__main__':verify()
