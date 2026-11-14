"""Fixed build-host native runtime integration. Never targets production."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

JOB=Path('/home/etcom-hub/build/gps-runtime121-20261113')
HOST='gps-runtime121-host'
NET='gps-runtime121-private'
OUT=JOB/'out'


def call(*args,check=True,timeout=120):
    p=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    if check and p.returncode:
        raise RuntimeError(repr(args[:4])+'\n'+p.stdout[-2500:]+p.stderr[-2500:])
    return p


def inside(*args,**kw):
    return call('docker','exec',HOST,*args,**kw)


def write(path,text,mode='0644'):
    p=JOB/'generated'/path.lstrip('/');p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
    inside('mkdir','-p',str(Path(path).parent))
    call('docker','cp',str(p),HOST+':'+path)
    inside('chown','root:root',path);inside('chmod',mode,path)


def guard():
    assert call('hostname').stdout.strip()=='etcom-hub'
    assert Path.cwd()==JOB


def setup():
    guard()
    assert call('docker','inspect',HOST,check=False).returncode
    assert __import__('shutil').disk_usage(JOB).free > 4*1024**3
    call('docker','build','-f','src/ops/runtime121.Dockerfile','-t','gps-runtime121:20261113',str(JOB),timeout=300)
    call('docker','network','create','--internal','--label','gps.runtime121=synthetic',NET)
    call('docker','run','-d','--name',HOST,'--label','gps.runtime121=synthetic','--network',NET,
         '--cgroupns=private','--cap-add','SYS_ADMIN','--security-opt','seccomp=unconfined',
         '--security-opt','apparmor=unconfined','--tmpfs','/run','--tmpfs','/run/lock','--tmpfs','/tmp',
         '--memory=4096m','--memory-swap=4096m','--ulimit=core=0','-e','container=docker',
         '--entrypoint','/bin/sh','gps-runtime121:20261113','-c','mount -o remount,rw /sys/fs/cgroup; exec /sbin/init')
    for _ in range(80):
        if inside('systemctl','is-system-running',check=False).stdout.strip() in ('running','degraded'):break
        time.sleep(.3)
    for uid,user in [(1000,'gps-api'),(2101,'gps-pdf')]:
        inside('useradd','--uid',str(uid),'--user-group','--no-create-home','--shell','/usr/sbin/nologin',user)
    inside('mkdir','-p','/opt/gps121/src/gps-tracker-api','/opt/gps121/out','/opt/gps121/test-storage','/opt/gps121/job-results','/opt/gps121/recovery')
    inside('chmod','1777','/opt/gps121/job-results')
    inside('chown','postgres:postgres','/opt/gps121/recovery');inside('chmod','0700','/opt/gps121/recovery')
    for name in ('gps-tracker-api','gps-pdf-render','gps-tracker-api.baseline99'):
        call('docker','cp',str(OUT/name),HOST+':/opt/gps121/out/'+name)
        inside('chmod','0755','/opt/gps121/out/'+name)
    for name in ('gps-tracker-api','gps-pdf-render'):
        inside('ln','-s','/opt/gps121/out/'+name,'/opt/'+name)
    call('docker','cp',str(JOB/'src/ops')+'/.',HOST+':/opt/gps121/')
    call('docker','cp',str(JOB/'canonical/gps-tracker-api/migrations'),HOST+':/opt/gps121/src/gps-tracker-api/')
    write('/etc/runtime121-test-only','synthetic')
    inside('install','-d','-o','root','-g','root','-m','0555','/run/gps121','/run/gps121/tmp','/run/gps121/sort','/run/gps121/fallback')
    inside('ln','-s','/run/gps121/fallback/pgsql_tmp','/var/lib/postgresql/14/main/base/pgsql_tmp')
    inside('mkdir','-p','/etc/gps121');inside('ln','-s','/tmp','/etc/gps121/tmp')
    sys.path.insert(0,str(JOB/'src/ops'))
    import runtime121_units
    sha=inside('sha256sum','/usr/local/lib/gps-nodump.so').stdout.split()[0]
    for path,value in runtime121_units.files(sha).items():write(path,value)
    inside('systemctl','daemon-reload');inside('systemctl','enable','gps121-db')
    inside('systemctl','start','gps121-db')
    for _ in range(50):
        if inside('sudo','-u','postgres','pg_isready',check=False).returncode==0:break
        time.sleep(.2)
    inside('sudo','-u','postgres','psql','-X','-v','ON_ERROR_STOP=1','-c',"ALTER ROLE postgres PASSWORD 'closure-test-only'")
    inside('sudo','-u','postgres','createdb','gps_closure_test')
    inside('rmdir','/run/gps121/sort/work/PG_14_202107181')
    inside('sudo','-u','postgres','psql','-X','-v','ON_ERROR_STOP=1','-c',"CREATE TABLESPACE gps121_sort LOCATION '/run/gps121/sort/work'")
    inside('systemctl','start','gps-pdf-render.socket')
    print('PASS native protected PostgreSQL14, Timescale2.19.3 and PDF service started',flush=True)


def run():
    guard()
    p=inside('python3','/opt/gps121/runtime121_cumulative.py',check=False,timeout=1800)
    (OUT/'cumulative.log').write_text(p.stdout+p.stderr)
    call('docker','cp',HOST+':/opt/gps121/out/.',str(OUT))
    print(p.stdout[-6000:]+p.stderr[-3000:],flush=True)
    assert p.returncode==0,'cumulative failed; see isolated log'


def cleanup():
    guard()
    if call('docker','inspect',HOST,check=False).returncode==0:
        info=json.loads(call('docker','inspect',HOST).stdout)[0]
        assert info['Config']['Labels']['gps.runtime121']=='synthetic'
        call('docker','rm','-f',HOST)
    if call('docker','network','inspect',NET,check=False).returncode==0:
        info=json.loads(call('docker','network','inspect',NET).stdout)[0]
        assert info['Labels']['gps.runtime121']=='synthetic'
        call('docker','network','rm',NET)
    print('PASS labelled121 container and internal network removed',flush=True)


if __name__=='__main__':
    {'setup':setup,'run':run,'cleanup':cleanup}[sys.argv[1]]()
