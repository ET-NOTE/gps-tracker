"""Continue the isolated native fixture and preserve evidence before teardown.

Run on the fixed build host after rehearse_runtime121.py run. No deployment.
"""
import json
from pathlib import Path
import sys
import time
from rehearse_runtime121 import JOB, HOST, OUT, guard, call, inside


def suite(name, timeout=900):
    p=inside('python3','/opt/gps121/'+name,check=False,timeout=timeout)
    (OUT/name.replace('.py','.log')).write_text(p.stdout+p.stderr)
    call('docker','cp',HOST+':/opt/gps121/out/.',str(OUT))
    print(p.stdout[-2500:]+p.stderr[-2500:],flush=True)
    assert p.returncode==0,name


def reboot():
    # Docker restart discards /run tmpfs, while synthetic PGDATA remains.
    inside('touch','/run/gps121/tmp/reboot-proof')
    call('docker','restart',HOST,timeout=90)
    for _ in range(150):
        if inside('pg_isready',check=False).returncode==0:break
        time.sleep(.2)
    else:raise AssertionError('native DB failed to boot with empty /run')
    assert inside('test','-e','/run/gps121/tmp/reboot-proof',check=False).returncode!=0
    p=inside('python3','-c',"""
import json,subprocess,sys
sys.path.insert(0,'/opt/gps121')
from runtime121_control import ROOT,DSN,boot_new,job
import psycopg
c=json.loads((ROOT/'test-runtime.json').read_text())
runtime=DSN.replace('postgres:closure-test-only',c['user']+':'+c['password'])
boot_new(dict(STORAGE='pilot',RUNTIME_DSN=runtime))
with psycopg.connect(DSN,autocommit=True) as db:
 assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()==(112,)
 db.execute("SET temp_tablespaces='gps121_sort'; SET work_mem='64kB'")
 plan=db.execute('EXPLAIN (ANALYZE,FORMAT JSON) SELECT i FROM generate_series(1,100000) i ORDER BY md5(i::text)').fetchone()[0]
 assert plan[0]['Plan']['Sort Space Type']=='Disk'
 assert db.execute("SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL").fetchone()==(0,)
subprocess.run(['systemctl','start','gps-pdf-render.socket'],check=True)
import test_runtime120_service as pdf
assert pdf.page()[0]>0
(ROOT/'out/reboot121.json').write_text(json.dumps(dict(empty_run_boot=True,schema=112,api_ready=True,protected_disk_sort=True,plaintext_columns=0,pdf_exact_pixels=True),indent=2))
print('PASS empty-/run reboot restores protected native DB, encrypted API, sort and PDF')
""",timeout=90)
    print(p.stdout,flush=True)
    call('docker','cp',HOST+':/opt/gps121/out/reboot121.json',str(OUT/'reboot121.json'))


def pdf():
    inside('sh','-c',"printf synthetic > /etc/runtime120-test-only")
    suite('test_runtime120_service.py',180)
    (OUT/'pdf-lifetime121.json').write_text(inside('cat','/tmp/runtime120-service-results.json').stdout)


if __name__=='__main__':
    guard()
    action=sys.argv[1]
    if action=='regressions':suite('verify_runtime121.py')
    elif action=='restore':suite('restore_runtime121.py')
    elif action=='faults':suite('test_runtime121.py')
    elif action=='pdf':pdf()
    elif action=='reboot':reboot()
    else:raise ValueError(action)
