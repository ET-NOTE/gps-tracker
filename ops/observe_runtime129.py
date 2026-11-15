"""Thirty read-only wait/IO samples during shared load; no request payloads."""
import time
from pathlib import Path
import load_runtime129 as l

rows=[]
for _ in range(30):
    progress=l.ROOT/'out/shared-129-progress.json'
    import json
    value=json.loads(progress.read_text())
    assert value['seconds']<295,'Run only while the shared measurement is active'
    rows.append(dict(utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
        last_progress_seconds=value['seconds'],
        waits=l.sql("SELECT backend_type,usename,state,wait_event_type,wait_event,count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() GROUP BY 1,2,3,4,5"),
        bgwriter=l.sql('SELECT checkpoints_timed,checkpoints_req,checkpoint_write_time,checkpoint_sync_time,buffers_checkpoint,buffers_clean,buffers_backend,buffers_backend_fsync FROM pg_stat_bgwriter'),
        io_pressure=Path('/sys/fs/cgroup/io.pressure').read_text(),
        io_stats=Path('/sys/fs/cgroup/io.stat').read_text(),
        cpu_stats=Path('/sys/fs/cgroup/cpu.stat').read_text()))
    time.sleep(1)
l.save('wait-observation129-shared',dict(samples=rows,interval_seconds=1,
    scope='Thirty point samples during shared load; observational, not a causal isolation experiment',production_modified=False))
print('PASS129 recorded30 read-only wait/IO samples',flush=True)
