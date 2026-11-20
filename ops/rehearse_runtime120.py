"""Isolated120: real systemd API/PDF, protected Timescale, one aggregate cgroup.

Only fixed labelled build-host containers and a transient gps120.slice are
created. No production configuration, traffic, credentials or network access.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

JOB=Path('/home/etcom-hub/build/gps-runtime120-20261113')
HOST='gps-runtime120-host'; DB='gps-runtime120-db'; NET='gps-runtime120-private'
PARENT='gps120.slice'
OUT=JOB/'out'


def call(*args,check=True,timeout=120):
    p=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    if check and p.returncode: raise RuntimeError(repr(args[:5])+'\n'+p.stdout[-2500:]+p.stderr[-2500:])
    return p


def inside(*args,**kw): return call('docker','exec',HOST,*args,**kw)


def write(path,content,mode='0644'):
    local=JOB/'generated'/path.lstrip('/');local.parent.mkdir(parents=True,exist_ok=True);local.write_text(content)
    inside('mkdir','-p',str(Path(path).parent));call('docker','cp',str(local),HOST+':'+path)
    inside('chown','root:root',path);inside('chmod',mode,path)


def inspect(kind,name): return json.loads(call('docker',kind,'inspect',name).stdout)[0]


def setup():
    assert call('hostname').stdout.strip()=='etcom-hub'
    for name in (HOST,DB): assert call('docker','inspect',name,check=False).returncode
    # A dedicated temporary host-level parent bounds both containers, including
    # their shared pages. Never put another project's process in this slice.
    assert call('systemctl','is-active',PARENT,check=False).stdout.strip()!='active'
    for prop in ('FragmentPath','DropInPaths'):
        assert not call('systemctl','show',PARENT,'-p',prop,'--value').stdout.strip()
    call('sudo','systemctl','set-property','--runtime',PARENT,'MemoryMax=4096M','MemorySwapMax=0','TasksMax=512')
    call('docker','network','create','--internal','--label','gps.runtime120=synthetic',NET)
    call('docker','run','-d','--name',DB,'--label','gps.runtime120=synthetic','--network',NET,'--network-alias','closure-db',
         '--cgroup-parent='+PARENT,'--memory=1500m','--memory-swap=1500m','--ulimit=core=0',
         '--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=1600m','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m',
         '-e','POSTGRES_PASSWORD=closure-test-only','-e','POSTGRES_DB=gps_closure_test','gps-runtime119-db:20261112',
         'postgres','-c','shared_buffers=128MB','-c','max_connections=50','-c','work_mem=2532kB')
    call('docker','run','-d','--name',HOST,'--label','gps.runtime120=synthetic','--network',NET,
         '--cgroup-parent='+PARENT,'--cgroupns=private','--cap-add','SYS_ADMIN','--cap-add','NET_ADMIN',
         '--security-opt','seccomp=unconfined','--security-opt','apparmor=unconfined',
         '--tmpfs','/run','--tmpfs','/run/lock','--tmpfs','/tmp','--memory=2400m','--memory-swap=2400m',
         '--ulimit=core=0','-e','container=docker','--entrypoint','/bin/sh',
         'gps-runtime119:20261112','-c','mount -o remount,rw /sys/fs/cgroup; exec /sbin/init')


def configure():
    for _ in range(80):
        if inside('systemctl','is-system-running',check=False).stdout.strip() in ('running','degraded'):break
        time.sleep(.3)
    inside('useradd','--system','--uid','2101','--user-group','--no-create-home','--shell','/usr/sbin/nologin','gps-pdf')
    inside('useradd','--uid','1000','--user-group','--no-create-home','--shell','/usr/sbin/nologin','gps-api')
    for name in ('gps-pdf-render','gps-tracker-api'):
        call('docker','cp',str(OUT/name),HOST+':/opt/'+name);inside('chmod','0755','/opt/'+name)
    sys.path.insert(0,str(JOB/'src/ops'))
    import pdf_runtime120 as units
    class Site:
        units=Path('/etc/systemd/system');renderer=Path('/opt/gps-pdf-render')
    for path,content in units.files(Site()).items():
        if '.service.d/' not in str(path):write(str(path),content)
    write('/usr/local/lib/pdf_budget120.py',units.budget_script())
    inside('install','-d','-o','gps-api','-g','gps-api','-m','0700','/var/lib/gps120','/var/lib/gps120/uploads','/var/lib/gps120/private')
    library=inside('sha256sum','/usr/local/lib/gps-nodump.so').stdout.split()[0]
    # Private tmp mount shared by two API units, with root-owned underlay.
    write('/etc/systemd/system/run-gps120tmp.mount','''[Mount]
What=tmpfs
Where=/run/gps120tmp
Type=tmpfs
Options=size=64M,mode=1777,noexec,nosuid,nodev
''')
    inside('install','-d','-o','root','-g','root','-m','0555','/run/gps120tmp')
    inside('mkdir','-p','/etc/gps120');inside('ln','-s','/tmp','/etc/gps120/tmp')
    plan=dict(library='/usr/local/lib/gps-nodump.so',library_sha256=library,
              mounts=[dict(path='/tmp',max_bytes=64*1024**2)],fallback_link='/etc/gps120/tmp',
              fallback_target='/tmp',memory_max_bytes=550*1024**2)
    write('/etc/gps120/api.json',json.dumps(plan))
    common='''[Unit]
BindsTo=run-gps120tmp.mount
After=run-gps120tmp.mount
Wants=gps-pdf-render.socket
[Service]
User=gps-api
Group=gps-api
EnvironmentFile=/etc/gps120/api-%i.env
Environment=LD_PRELOAD=/usr/local/lib/gps-nodump.so
Environment=GPS_PDF_SOCKET=/run/gps-pdf-render/render.sock
Environment=GPS_PDF_RENDERER=/opt/gps-pdf-render
ExecStartPre=/usr/bin/python3 /usr/local/lib/runtime118_guard.py /etc/gps120/api.json
ExecStart=/opt/gps-tracker-api
MemoryMax=550M
MemorySwapMax=0
LimitCORE=0
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
BindPaths=/run/gps120tmp:/tmp
ReadWritePaths=/var/lib/gps120
Slice=gps-workload.slice
KillMode=control-group
TimeoutStopSec=2
'''
    write('/etc/systemd/system/gps120-api@.service',common)
    for instance,port in [('one',3043),('two',3044)]:
        env='\n'.join(['APP_ENV=test',f'BIND_ADDR=0.0.0.0:{port}',
            'DATABASE_URL=postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test',
            'JWT_SECRET=closure-test-only-jwt-key-32-characters','SMS_DEV_MODE=1',
            'UPLOAD_DIR=/var/lib/gps120/uploads','PRIVATE_UPLOAD_DIR=/var/lib/gps120/private'])+'\n'
        write('/etc/gps120/api-'+instance+'.env',env,'0600')
    inside('systemctl','daemon-reload')
    inside('systemctl','start','gps-pdf-render.socket')
    for _ in range(80):
        if call('docker','exec',DB,'pg_isready','-U','postgres',check=False).returncode==0:break
        time.sleep(.3)
    inside('systemctl','start','gps120-api@one.service')
    ip=inspect('container',HOST)['NetworkSettings']['Networks'][NET]['IPAddress']
    for port in (3043,3044):
        if port==3044:inside('systemctl','start','gps120-api@two.service')
        for _ in range(120):
            try:
                with urllib.request.urlopen(f'http://{ip}:{port}/gps-tracker/health',timeout=2) as r:
                    if json.load(r)['db']:break
            except Exception:pass
            time.sleep(.5)
        else:raise RuntimeError('API not healthy '+str(port)+'\n'+inside('journalctl','-u','gps120-api@one','--no-pager','-n','30').stdout)
    (OUT/'setup.json').write_text(json.dumps(dict(production_changed=False,host_ip=ip,
        parent_budget_mib=4096,api_unit_budget_mib=550,db_budget_mib=1500,pdf_aggregate_mib=896,
        pdf_selftest=inside('journalctl','-u','gps-pdf-render-selftest.service','-o','cat','--no-pager').stdout),indent=2))
    print('PASS real protected API units and global PDF service',flush=True)


def cleanup():
    for name in (HOST,DB):
        if call('docker','inspect',name,check=False).returncode==0:
            assert inspect('container',name)['Config']['Labels']['gps.runtime120']=='synthetic'
            call('docker','rm','-f',name)
    if call('docker','network','inspect',NET,check=False).returncode==0:
        assert inspect('network',NET)['Labels']['gps.runtime120']=='synthetic'
        call('docker','network','rm',NET)
    call('sudo','systemctl','stop',PARENT)
    # Remove ONLY the runtime drop-ins this round created, not persistent units.
    assert not call('systemctl','show',PARENT,'-p','FragmentPath','--value').stdout.strip()
    dropins=call('systemctl','show',PARENT,'-p','DropInPaths','--value').stdout.split()
    assert all(p.startswith('/run/systemd/system.control/'+PARENT+'.d/') for p in dropins),dropins
    call('sudo','systemctl','revert',PARENT)
    print('PASS isolated containers, network, runtime slice cleaned',flush=True)


if __name__=='__main__':
    {'setup':setup,'configure':configure,'cleanup':cleanup}[sys.argv[1]]()
