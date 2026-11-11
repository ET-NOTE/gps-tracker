"""Fixed isolated full-month SQL measurements, including buffers/temp IO."""
import hashlib
import json
import time
from benchmark_location112 import OUT, connect, save


def main(label):
    fixture=json.loads((OUT/'fixture.json').read_text())
    args=(fixture['device_id'],fixture['user_id'])
    report={'label':label,'production_modified':False,'queries':{}}
    with connect() as db:
        db.execute("SET statement_timeout='600s'")
        for name in ('location_history_points_between','location_speed_metrics_between'):
            query='SELECT * FROM '+name+"(%s,%s,'2026-10-01','2026-11-01') ORDER BY recorded_at,source"
            values=[]
            for i in range(3):
                start=time.monotonic()
                # A server-side aggregate would allow projection pruning; fetch
                # every public field, as the real history/metrics consumers do.
                rows=db.execute(query,args).fetchall()
                digest=hashlib.sha256(json.dumps(rows,default=str,separators=(',',':')).encode()).hexdigest()
                values.append({'seconds':time.monotonic()-start,'rows':len(rows),'sha256':digest})
                print(label,name,i,values[-1],flush=True)
            plan=db.execute('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query,args).fetchone()[0]
            save(label+'-'+name+'-plan.json',plan)
            report['queries'][name]=values
            save(label+'-full-month.json',report)
        report['settings']=dict(db.execute("SELECT name,setting FROM pg_settings WHERE name IN ('max_connections','shared_buffers','work_mem','effective_cache_size','jit','max_parallel_workers_per_gather')").fetchall())
    save(label+'-full-month.json',report)

if __name__=='__main__':
    import sys
    main(sys.argv[1])
