"""300-second restored monthly TLS load, with measured bounded temp usage."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
import subprocess
import threading
import time
import psycopg
import verify_runtime126 as v

ctx=json.loads(v.CONTEXT.read_text());dsn=ctx['dsn']
phase=os.environ.get('PERF127_PHASE','compressed')
assert phase in ('compressed','uncompressed','baseline-compressed')
expected=json.loads((v.ROOT/'out/prototype127.json').read_text())['expected']
v.stop_api()
subprocess.run(['systemctl','restart','gps121-db'],check=True)
v.boot_settled(dict(RUNTIME_DSN=ctx['runtime'],STORAGE='pilot'))
subprocess.run(['systemctl','stop','gps122-proxy'],check=False,capture_output=True);v.load.tls()
for _ in range(50):
    try:
        if v.load.Client().get('/gps-tracker/health')[0]==200:break
    except OSError:pass
    time.sleep(.1)
else:raise AssertionError('TLS proxy not ready')


def database():
    with psycopg.connect(dsn,autocommit=True) as db:
        return dict(schema=db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0],
            compressed_chunks=db.execute("SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='location_records' AND is_compressed").fetchone()[0],
            temp=dict(zip(('files','bytes'),db.execute('SELECT temp_files,temp_bytes FROM pg_stat_database WHERE datname=current_database()').fetchone())),
            active=db.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND (state='idle in transaction' OR application_name LIKE 'gps-read-%')").fetchone()[0])


db_before=database()
assert db_before['compressed_chunks']==(0 if phase=='uncompressed' else 3),db_before
assert db_before['schema']==(113 if phase=='baseline-compressed' else 114)
paths=v.load.b.routes(ctx['did'])[:3];reboot=[]
for name,path in paths:
    status,body,_,seconds=v.load.Client().get(path,ctx['uid'])
    if status==200:assert hashlib.sha256(body).hexdigest()==expected[name]
    reboot.append(dict(route=name,status=status,seconds=seconds,sha256=hashlib.sha256(body).hexdigest()))
v.load.save('restarted127-'+phase,dict(queries=reboot,database=db_before,
    cache='PostgreSQL restarted; host OS cache retained',tls='verified synthetic localhost TLS1.2'))
rows=[];samples=[];peaks=[];lock=threading.Lock();ended=threading.Event()
duration=60 if phase=='baseline-compressed' else 300
before=v.load.cgroups();began=time.monotonic();deadline=began+duration


def monitor():
    next_group=0
    while not ended.wait(.02):
        t=time.monotonic()-began;s=os.statvfs('/run/gps121/sort')
        used=(s.f_blocks-s.f_bfree)*s.f_frsize
        if not peaks or used>peaks[-1]['bytes']:peaks.append(dict(seconds=t,bytes=used))
        if t>=next_group:
            samples.append(dict(seconds=t,sort_bytes=used,cgroups=v.load.cgroups()));next_group=t+2


def worker(index):
    client=v.load.Client();sequence=0
    while time.monotonic()<deadline:
        name,path=paths[(sequence+index)%len(paths)];sequence+=1
        start=time.monotonic();attempts=[];retry_wait=0
        for attempt in range(3):
            status,body,headers,seconds=client.get(path,ctx['uid']);attempts.append(dict(status=status,seconds=seconds))
            if status==200:
                assert hashlib.sha256(body).hexdigest()==expected[name],name
                break
            if status!=429:break
            assert headers.get('retry-after')=='2'
            if attempt<2 and time.monotonic()<deadline:time.sleep(2);retry_wait+=2
            else:break
        with lock:rows.append(dict(worker=index,route=name,status=status,seconds=time.monotonic()-start,
            retry_wait_seconds=retry_wait,attempts=attempts))
        time.sleep(.05)


thread=threading.Thread(target=monitor);thread.start()
try:
    with ThreadPoolExecutor(max_workers=3) as pool:list(pool.map(worker,range(3)))
finally:ended.set();thread.join()
after=v.load.cgroups();db_after=database()
assert db_after['active']==0
for name in ('container','gps','db','api'):
    def events(group):return dict(line.split() for line in group['memory.events'].splitlines())
    assert events(after[name])['oom_kill']==events(before[name])['oom_kill']
    assert int(after[name]['memory.swap.current'])==0


def p95(values):return sorted(values)[math.ceil(.95*len(values))-1] if values else None


summary={}
for name,_ in paths:
    part=[r for r in rows if r['route']==name]
    summary[name]=dict(status=dict(Counter(r['status'] for r in part)),
        success_p95_seconds=p95([r['seconds'] for r in part if r['status']==200]),
        attempt_p95_seconds=p95([a['seconds'] for r in part for a in r['attempts'] if a['status']==200]))
accepted=all(r['status'] in (200,429) for r in rows) and all(r['status']==200 for r in reboot)
v.load.save('sustained127-'+phase,dict(api_sha256=v.load.b.SHA,phase=phase,seconds=time.monotonic()-began,
    target_seconds=duration,workers=3,api_budget_seconds=20,period=v.load.b.MONTH,summary=summary,requests=rows,
    cgroups_before=before,cgroups_after=after,resource_samples=samples,temp_high_water_samples=peaks,
    temp_cap_bytes=256*1024**2,temp_peak_bytes=max((p['bytes'] for p in peaks),default=0),
    database_before=db_before,database_after=db_after,response_hashes_equal=True,remaining_reads=0,
    transport='TLS1.2 synthetic localhost CA verified',queries_accepted=accepted,
    production_capacity_accepted=False,fixture='130000 rows;623000 raw points;283001 deduplicated;one SIM'))
v.stop_api()
print('MEASURED127',phase,summary,'peak',peaks[-1] if peaks else None,flush=True)
if phase!='baseline-compressed':assert accepted,summary
