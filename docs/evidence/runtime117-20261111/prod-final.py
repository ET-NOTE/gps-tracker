import json,subprocess
from datetime import datetime,timezone

def run(*a): return subprocess.check_output(a,text=True,timeout=20).strip()
def sql(s): return run('sudo','-n','-u','postgres','psql','-X','-d','gps_tracker','-At','-v','ON_ERROR_STOP=1','-c',s)
r={'checked_utc':datetime.now(timezone.utc).isoformat(),'read_only':True,'cpus':run('nproc'),'health':json.loads(run('curl','-fsS','--max-time','10','https://gps.serial.kr/health')),'schema':sql('SELECT max(version) FROM _sqlx_migrations WHERE success'),'connection_counts_including_observer':sql("SELECT count(*),count(*) FILTER(WHERE datname=current_database()),count(*) FILTER(WHERE datname IS DISTINCT FROM current_database()) FROM pg_stat_activity WHERE backend_type='client backend'"),'units':{}}
for u in ['gps-tracker-api','postgresql@14-main']:
 r['units'][u]=run('systemctl','show',u,'-p','ActiveState','-p','NRestarts','-p','ExecMainStartTimestamp','-p','MemoryCurrent','-p','MemoryMax','-p','MemorySwapMax','-p','LimitCORE')
r['core_pattern']=run('cat','/proc/sys/kernel/core_pattern')
r['disk']=run('df','-B1','/')
print(json.dumps(r,indent=2))
