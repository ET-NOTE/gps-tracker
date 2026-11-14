import os,pathlib,signal,time
from benchmark_location112 import JOB,OUT,connect,save
from run_sustain112 import switch
for p in pathlib.Path('/proc').iterdir():
    if not p.name.isdecimal():continue
    try:
        args=(p/'cmdline').read_bytes().split(b'\0')
        if b'run_sustain112.py' in args and (p/'cwd').resolve()==JOB:
            os.kill(int(p.name),signal.SIGTERM)
    except (FileNotFoundError,PermissionError,ProcessLookupError):pass
time.sleep(1)
if not (OUT/'attempt-baseline-catchup.log').exists():
    (OUT/'attempt-baseline-catchup.log').write_bytes((OUT/'baseline111-sustain.log').read_bytes())
with connect() as db:
    # An interrupted legacy catchup already wrote a few days. The supported
    # durable rebuild queue resumes every fixture day, rather than inserting
    # artificial zero aggregates to make the load benchmark start.
    db.execute("INSERT INTO stats_rebuild_queue(device_id,date) SELECT 1,d::date FROM generate_series('2026-10-01'::date,'2026-10-16'::date,'1 day') d ON CONFLICT(device_id,date) DO UPDATE SET next_attempt_at=now(),generation=stats_rebuild_queue.generation+1")
started=time.monotonic()
switch(112)
for i in range(120):
    with connect() as db:
        count=db.execute('SELECT count(*) FROM daily_stats WHERE device_id=1').fetchone()[0]
    if count>=16:break
    time.sleep(1)
save('catchup112.json',{'days':count,'seconds':time.monotonic()-started,'production_modified':False})
assert count>=16,count
print('Final112 real worker catchup completed',count,'days',flush=True)
