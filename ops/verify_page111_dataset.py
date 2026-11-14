"""Walk a complete dense month through111 pages and compare all logical columns."""
import datetime as dt
import hashlib
import json
import time
from benchmark_location111 import OUT, connect, save


def main():
    fixture=json.loads((OUT/'fixture.json').read_text())
    did,uid=fixture['device_id'],fixture['user_id']
    lo=dt.datetime(2026,10,1,tzinfo=dt.timezone.utc)
    hi=dt.datetime(2026,11,1,tzinfo=dt.timezone.utc)
    expected,actual=hashlib.sha256(),hashlib.sha256()
    counts=[0,0];pages=0;before=None;source=None
    began=time.monotonic()
    with connect() as db,db.transaction(force_rollback=True):
        with db.cursor(name='unchanged110_full_history') as cur:
            cur.execute('SELECT to_jsonb(p)::text FROM location_history_points_between(%s,%s,%s,%s) p WHERE recorded_at<%s ORDER BY recorded_at DESC,source DESC',(did,uid,lo,hi,hi))
            for (value,) in cur:
                expected.update(value.encode()+b'\n');counts[0]+=1
        while True:
            rows=db.execute('''WITH selected AS MATERIALIZED (
             SELECT * FROM location_page_sample_keys(%s,%s,%s,%s,NULL,NULL,%s,%s,5000)
            ), bounds AS (SELECT min(recorded_at) first,max(recorded_at) last FROM selected)
            SELECT p.recorded_at,p.source,to_jsonb(p)::text FROM bounds b CROSS JOIN LATERAL
             location_history_points_between(%s,%s,b.first,b.last) p
            JOIN selected s USING(recorded_at,source) WHERE b.first IS NOT NULL
            ORDER BY p.recorded_at DESC,p.source DESC''',(did,uid,lo,hi,before,source,did,uid)).fetchall()
            if not rows:break
            pages+=1
            for at,src,value in rows:
                actual.update(value.encode()+b'\n');counts[1]+=1
            before,source=rows[-1][:2]
        assert counts==[283001,283001] and actual.digest()==expected.digest(),(counts,expected.hexdigest(),actual.hexdigest())
    save('page-dataset111.json',{'passed':True,'rows':counts[0],'pages':pages,'page_size':5000,
        'sha256_all_return_columns':actual.hexdigest(),'seconds':time.monotonic()-began,
        'oracle':'unchanged110 full history; all111 pages descending with identical speed/context fields'})
    print('FULL PAGED DATASET PASS',counts[0],pages,actual.hexdigest(),flush=True)


if __name__=='__main__':main()
