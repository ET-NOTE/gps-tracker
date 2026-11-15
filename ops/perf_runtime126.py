"""Restored DB restart and bounded TLS1.2 monthly concurrency, synthetic only."""
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import subprocess
import threading
import time
import os
import psycopg
import verify_runtime126 as v

ctx=json.loads(v.CONTEXT.read_text());dsn=ctx['dsn']
env=dict(RUNTIME_DSN=ctx['runtime'],STORAGE='pilot')
phase=os.environ.get('PERF126_PHASE','compressed')
assert phase in ('compressed','uncompressed')
expected={r['route']:r['sha256'] for r in json.loads((v.ROOT/'out/statistics-guards126.json').read_text())['queries']}
v.stop_api()
subprocess.run(['systemctl','restart','gps121-db'],check=True)
v.boot_settled(env)
subprocess.run(['systemctl','stop','gps122-proxy'],check=False,capture_output=True)
v.load.tls()
for _ in range(50):
    try:
        if v.load.Client().get('/gps-tracker/health')[0]==200:break
    except OSError:pass
    time.sleep(.1)
else:raise AssertionError('TLS proxy not ready')
paths=v.load.b.routes(ctx['did'])[:3]
reboot=[]
for name,path in paths:
    status,body,_,seconds=v.load.Client().get(path,ctx['uid'])
    observed=dict(route=name,status=status,bytes=len(body),seconds=seconds,
        sha256=hashlib.sha256(body).hexdigest(),expected_sha256=expected[name])
    v.load.save('restarted-probe126',observed)
    if status==200:assert observed['sha256']==expected[name],observed
    reboot.append(dict(route=name,status=status,seconds=seconds,sha256=hashlib.sha256(body).hexdigest()))
v.load.save('restarted-db126-'+phase,dict(queries=reboot,statistics_persisted=True,autovacuum='on',
    cache='PostgreSQL restarted; host OS cache not flushed',tls='verified synthetic localhost TLS1.2'))
rows=[];samples=[];lock=threading.Lock();ended=threading.Event()
before=v.load.cgroups();began=time.monotonic();deadline=began+300


def monitor():
    while not ended.wait(2):
        samples.append(dict(seconds=time.monotonic()-began,cgroups=v.load.cgroups()))


def worker(index):
    client=v.load.Client();sequence=0
    while time.monotonic()<deadline:
        name,path=paths[(sequence+index)%len(paths)];sequence+=1
        start=time.monotonic();attempts=[];retry_wait=0
        for attempt in range(3):
            status,body,headers,seconds=client.get(path,ctx['uid'])
            attempts.append(dict(status=status,seconds=seconds))
            if status==200:
                assert hashlib.sha256(body).hexdigest()==expected[name],name
                break
            if status!=429:break
            assert headers.get('retry-after')=='2',headers.get('retry-after')
            if attempt<2 and time.monotonic()<deadline:
                time.sleep(2);retry_wait+=2
            else:break
        with lock:
            rows.append(dict(worker=index,route=name,status=status,seconds=time.monotonic()-start,
                retry_wait_seconds=retry_wait,attempts=attempts))
        time.sleep(.05)


thread=threading.Thread(target=monitor);thread.start()
try:
    with ThreadPoolExecutor(max_workers=3) as pool:list(pool.map(worker,range(3)))
finally:ended.set();thread.join()
after=v.load.cgroups()
def p95(values):return sorted(values)[math.ceil(.95*len(values))-1] if values else None
summary={}
for name,_ in paths:
    part=[r for r in rows if r['route']==name]
    summary[name]=dict(status=dict(Counter(r['status'] for r in part)),
        success_p95_seconds=p95([r['seconds'] for r in part if r['status']==200]),
        retry_wait_p95_seconds=p95([r['retry_wait_seconds'] for r in part]))
def events(group):return dict(line.split() for line in group['memory.events'].splitlines())
for name in ('container','gps','db','api'):
    assert int(events(after[name])['oom_kill'])==int(events(before[name])['oom_kill'])
    assert int(after[name]['memory.swap.current'])==0
with psycopg.connect(dsn,autocommit=True) as db:
    active=db.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND (state='idle in transaction' OR application_name LIKE 'gps-read-%')").fetchone()[0]
    assert active==0
v.load.save('sustained126-'+phase,dict(seconds=time.monotonic()-began,target_seconds=300,workers=3,
    api_budget_seconds=20,period=v.load.b.MONTH,summary=summary,requests=rows,cgroups_before=before,
    cgroups_after=after,resource_samples=samples,response_hashes_equal=True,remaining_reads=active,
    fixture='restored130000 rows/623000 raw points/283001 deduplicated; one SIM',
    transport='TLS1.2 synthetic localhost CA verified',production_capacity_accepted=False,
    queries_accepted=all(r['status'] in (200,429) for r in rows),phase=phase))
v.stop_api()
print('MEASURED126 300s3-worker restored monthly TLS; noOOM/swap;429 preserved:',phase,summary,flush=True)
