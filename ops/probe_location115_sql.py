"""Compare exact trip fixes on the fixed synthetic query115 database."""
import hashlib
import json
import time
import benchmark_location115 as b

OLD = '''SELECT DISTINCT ON(recorded_at) recorded_at,lat,lng
 FROM location_points_between(%s,%s,%s,%s)
 WHERE device_id=%s AND user_id=%s AND fix=TRUE
 AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180
 AND recorded_at>=%s AND recorded_at<=%s
 ORDER BY recorded_at ASC,CASE source WHEN 'phone' THEN 0 WHEN 'l80' THEN 1 ELSE 2 END'''
NEW = '''WITH points AS MATERIALIZED (
 SELECT device_id,user_id,recorded_at,lat,lng,fix,source
 FROM location_points_between(%s,%s,%s,%s))
 SELECT DISTINCT ON(recorded_at) recorded_at,lat,lng FROM points
 WHERE device_id=%s AND user_id=%s AND fix=TRUE
 AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180
 AND recorded_at>=%s AND recorded_at<=%s
 ORDER BY recorded_at ASC,CASE source WHEN 'phone' THEN 0 WHEN 'l80' THEN 1 ELSE 2 END'''
result=[]
for end,label in [('2026-10-02T00:00:00+09:00','one_day'),('2026-11-01T00:00:00+09:00','full_month')]:
    device=b.fixture()['devices'][0];did,uid=device['device_id'],device['user_id']
    args=(did,uid,'2026-10-01T00:00:00+09:00',end,did,uid,'2026-10-01T00:00:00+09:00',end)
    for name,query in [('old',OLD),('materialized',NEW)]:
        started=time.monotonic()
        try:
            rows=b.sql(query,args)
            item={'range':label,'query':name,'seconds':time.monotonic()-started,'points':len(rows),'sha256':hashlib.sha256(json.dumps(rows,default=str,separators=(',',':')).encode()).hexdigest()}
        except Exception as error:
            item={'range':label,'query':name,'seconds':time.monotonic()-started,'error':type(error).__name__,'detail':str(error)[:250]}
        result.append(item);b.save('sql-comparison',result);print(item,flush=True)
