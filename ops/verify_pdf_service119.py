"""119 isolated real systemd PDF service, shared Unix socket, no production apply."""
import json
from pathlib import Path
import subprocess
import sys
import time

KIT=Path('/home/etcom-hub/build/gps-runtime119-20261112')
JOB=KIT.parent/'gps-provision22-20261112cumulative119'
HOST='gps-runtime119-pdf-host'
VOLUME='gps-runtime119-pdf-socket'
assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub'


def call(*args,check=True):
    return subprocess.run(args,capture_output=True,text=True,check=check)


def inside(*args,check=True): return call('docker','exec',HOST,*args,check=check)


def save(value): (KIT/'out/pdf-service119.json').write_text(json.dumps(value,indent=2))


def setup():
    old=call('docker','inspect',HOST,check=False)
    if old.returncode==0:
        assert json.loads(old.stdout)[0]['Config']['Labels']['gps.runtime119']=='synthetic'
        (KIT/'out/pdf-initial-setup.log').write_text(inside('journalctl','-u','gps-pdf-render-selftest.service','-u','gps-pdf-render.socket','-o','cat','--no-pager').stdout)
        call('docker','rm','-f',HOST)
    call('docker','volume','create','--label','gps.runtime119=synthetic','--driver','local',
         '--opt','type=tmpfs','--opt','device=tmpfs','--opt','o=rw,noexec,nosuid,nodev,size=1m',VOLUME)
    call('docker','run','-d','--name',HOST,'--label','gps.runtime119=synthetic','--network','none',
         '--cgroupns=private','--cap-add','SYS_ADMIN','--cap-add','NET_ADMIN','--security-opt','seccomp=unconfined',
         '--security-opt','apparmor=unconfined','--tmpfs','/run','--tmpfs','/run/lock','--tmpfs','/tmp',
         '--memory=1100m','--memory-swap=1100m','--ulimit=core=0','-v',VOLUME+':/run/gps-pdf-render',
         '-e','container=docker','gps-runtime118:20261112','sh','-c',
         'mount -o remount,rw /sys/fs/cgroup; exec /sbin/init')
    for _ in range(60):
        if inside('systemctl','is-system-running',check=False).stdout.strip() in ('running','degraded'): break
        time.sleep(.3)
    inside('useradd','--system','--uid','2101','--user-group','--no-create-home','--shell','/usr/sbin/nologin','gps-pdf')
    inside('groupadd','--gid','1000','gps-api')
    call('docker','cp',str(KIT/'out/gps-pdf-render'),HOST+':/opt/gps-pdf-render')
    inside('chmod','755','/opt/gps-pdf-render')
    sys.path.insert(0,str(KIT/'src/ops'))
    import pdf_service as service
    class Site:
        units=Path('/etc/systemd/system')
        renderer=Path('/opt/gps-pdf-render')
    generated=KIT/'pdf-units'; generated.mkdir(exist_ok=True)
    for path,code in service.files(Site()).items():
        if '.service.d/' in str(path): continue  # API runs in the other guarded container.
        local=generated/path.name; local.write_text(code)
        call('docker','cp',str(local),HOST+':'+str(path))
    inside('systemctl','daemon-reload')
    inside('systemctl','start','gps-pdf-render.socket')
    report={'production_modified':False,'kind':'isolated real systemd service',
      'selftest':inside('journalctl','-u','gps-pdf-render-selftest.service','-o','cat','--no-pager').stdout,
      'socket':inside('systemctl','is-active','gps-pdf-render.socket').stdout.strip()}
    assert '"sandbox_holds":true' in report['selftest'] and '"enable_dumping":{"blocked":true' in report['selftest']
    assert report['socket']=='active'
    save(report)
    # Only the fixed test helper accepts the test socket; no operational unit is edited.
    dev=JOB/'dev22.sh'
    code=dev.read_text().replace('  extra=()','  extra=()\n  extra+=(-e GPS_PDF_SOCKET=/run/gps-pdf-render/render.sock -v gps-runtime119-pdf-socket:/run/gps-pdf-render)')
    dev.write_text(code)
    print('PASS separate protected PDF service selftest and real socket',flush=True)


def check():
    report=json.loads((KIT/'out/pdf-service119.json').read_text())
    total=int(inside('systemctl','show','gps-pdf-render.socket','-p','NAccepted','--value').stdout.strip())
    assert total>0, 'API has not used separate service'
    report['accepted_api_requests']=total
    props=inside('systemctl','show','gps-pdf-render@capacity.service','-p','MemoryMax','-p','MemorySwapMax','-p','User').stdout
    limits=dict(line.split('=',1) for line in props.splitlines())
    assert limits == {'MemoryMax':str(832*1024**2),'MemorySwapMax':'0','User':'gps-pdf'}
    report['service_limits']=props
    # Proof failure must remove the socket; restart must rerun the real renderer.
    inside('systemctl','stop','gps-pdf-render-selftest.service')
    assert inside('systemctl','is-active','gps-pdf-render.socket',check=False).stdout.strip()=='inactive'
    inside('mkdir','-p','/etc/systemd/system/gps-pdf-render-selftest.service.d')
    inside('sh','-c',"printf '[Service]\\nExecStart=\\nExecStart=/bin/false\\n' > /etc/systemd/system/gps-pdf-render-selftest.service.d/failure.conf")
    inside('systemctl','daemon-reload')
    result=inside('systemctl','start','gps-pdf-render.socket',check=False)
    assert result.returncode!=0
    assert inside('systemctl','is-active','gps-pdf-render.socket',check=False).stdout.strip()!='active'
    inside('rm','/etc/systemd/system/gps-pdf-render-selftest.service.d/failure.conf')
    inside('systemctl','daemon-reload'); inside('systemctl','reset-failed')
    inside('systemctl','start','gps-pdf-render.socket')
    assert inside('systemctl','is-active','gps-pdf-render.socket').stdout.strip()=='active'
    report['proof_failure_blocks_socket']=True; report['service_recovery']=True
    report['passed']=True; save(report); print('PASS real API socket use, proof failure, recovery',flush=True)


if __name__=='__main__': {'setup':setup,'check':check}[sys.argv[1]]()
