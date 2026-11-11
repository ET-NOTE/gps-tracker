"""117: single-API diagnostics and bounded tmpfs/no-swap rehearsal, synthetic only.

Uses the reviewed 115 workload without duplicating its endpoint/client logic.
No production URL or DSN is accepted. All mutation targets have fixed names.
"""
import argparse
import importlib.util
import hashlib
import json
import re
from pathlib import Path
import subprocess
import time

JOB = Path('/home/etcom-hub/build/gps-provision22-20261111runtime117')


def workload():
    source = (JOB/'src/ops/benchmark_location115.py').read_text()
    source = source.replace('query115', 'runtime117')
    source = source.replace("'fc8f97815eb02fc0ee9ca92e1788444f30398532bb670b6ed8d2178cb9565429'",
                            repr(hashlib.sha256((JOB/'out/gps-tracker-api').read_bytes()).hexdigest()))
    source = source.replace("'--memory=550m', '--pids-limit=128'", "'--memory=550m', '--memory-swap=550m', '--ulimit=core=0', '--pids-limit=128'")
    source = source.replace("'--memory=1500m', '--pids-limit=256'", "'--memory=1500m', '--memory-swap=1500m', '--ulimit=core=0', '--pids-limit=256'")
    if (JOB/'protected.enabled').exists():
        source = source.replace("'-e', 'GPS_LOCATION_ACCESS_LOG=on',", "'-e', 'GPS_LOCATION_TEMP_TABLESPACE=gps_runtime117_temp', '-e', 'GPS_LOCATION_ACCESS_LOG=on',")
    path = JOB/'benchmark_runtime117.py'; path.write_text(source)
    spec = importlib.util.spec_from_file_location('benchmark_runtime117', path)
    b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
    assert b.JOB == JOB and b.NET == 'gps-runtime117-test'
    return b


def recreate(b, *, limited, protected):
    b.ip(b.API); b.ip(b.DB)
    assert b.info('volume', b.VOL)['Labels']['gps.runtime117'] == 'synthetic'
    db = b.info('container', b.DB)
    assert [m['Name'] for m in db['Mounts'] if m['Type']=='volume'] == [b.VOL]
    (b.OUT/('pre-recreate-'+str(time.time_ns())+'-api.log')).write_bytes(subprocess.check_output(['docker','logs',b.API],stderr=subprocess.STDOUT))
    b.run('docker','rm','-f',b.API,stdout=subprocess.DEVNULL)
    b.run('docker','stop','-t','30',b.DB,stdout=subprocess.DEVNULL)
    b.run('docker','rm',b.DB,stdout=subprocess.DEVNULL)
    extra = []
    if limited:
        for flag, value in [('read-bps','8mb'),('write-bps','8mb'),('read-iops','200'),('write-iops','200')]:
            extra += ['--device-'+flag, '/dev/nvme0n1:'+value]
    # Dedicated bounded mount. It is not protected by tmpfs alone: the DB
    # cgroup has swap.max=0 too, verified below, as does the API.
    if protected:
        # PostgreSQL may fall back even when the tablespace OID/permission is
        # valid, e.g. its physical directory disappears. Protect that path too.
        extra += ['--tmpfs','/gps-temp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
                  '--tmpfs','/var/lib/postgresql/data/base/pgsql_tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777']
    b.run('docker','run','-d','--name',b.DB,'--network',b.NET,'--network-alias','runtime117-db',
          '--cpus=2','--memory=1500m','--memory-swap=1500m','--ulimit=core=0','--pids-limit=256',
          *extra, '-v', b.VOL+':/var/lib/postgresql/data',
          '-e','POSTGRES_PASSWORD=runtime117-test-only','-e','POSTGRES_DB=gps_runtime117_test',
          db['Config']['Image'],*[x.replace('shared_buffers=742MB','shared_buffers=949678kB') for x in db['Config']['Cmd']],stdout=subprocess.DEVNULL)
    for _ in range(60):
        try:
            if b.sql('SELECT 1') == [(1,)]: break
        except Exception: pass
        time.sleep(1)
    else: raise AssertionError('DB readiness')
    if protected:
        b.run('docker','exec',b.DB,'sh','-c','mkdir /gps-temp/work && chown postgres:postgres /gps-temp/work && chmod 700 /gps-temp/work && chown postgres:postgres /var/lib/postgresql/data/base/pgsql_tmp && chmod 700 /var/lib/postgresql/data/base/pgsql_tmp')
        # The tablespace metadata persists when this disposable DB is restarted.
        if b.sql("SELECT 1 FROM pg_tablespace WHERE spcname='gps_runtime117_temp'"):
            b.sql('DROP TABLESPACE gps_runtime117_temp')
        b.sql("CREATE TABLESPACE gps_runtime117_temp LOCATION '/gps-temp/work'")
        b.sql('GRANT CREATE ON TABLESPACE gps_runtime117_temp TO gps_runtime')
        b.sql("ALTER ROLE gps_runtime IN DATABASE gps_runtime117_test SET temp_tablespaces='gps_runtime117_temp'")
        b.sql("ALTER ROLE gps_runtime IN DATABASE gps_runtime117_test SET temp_file_limit='128MB'")
    if protected:
        (JOB/'protected.enabled').touch()
        b = workload()
    b.start()
    b.run('docker','restart',b.PROXY,stdout=subprocess.DEVNULL)
    config = {'limited':limited,'protected':protected,'containers':{}}
    for name in [b.DB,b.API]:
        cg = subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/memory.swap.max'],text=True).strip()
        assert cg == '0', (name,cg)
        config['containers'][name] = {'swap_max':cg, 'swap_current':subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/memory.swap.current'],text=True).strip(),
                                     'core_limit':b.info('container',name)['HostConfig']['Ulimits']}
    config['io_max'] = subprocess.check_output(['docker','exec',b.DB,'cat','/sys/fs/cgroup/io.max'],text=True)
    config['mounts'] = subprocess.check_output(['docker','exec',b.DB,'cat','/proc/mounts'],text=True)
    b.save('configuration-protected' if protected else 'configuration-disk',config)


def capture(b, name):
    raw = subprocess.check_output(['docker','logs',b.API],stderr=subprocess.STDOUT)
    # Keep diagnostic lines only, never request bodies or coordinates.
    lines = [x for x in raw.decode().splitlines() if 'access ledger timing' in x]
    (b.OUT/(name+'-timing.log')).write_text(re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(lines))+'\n')


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['setup','baseline','limited','protected','protected-final','cleanup','probe'])
    a=p.parse_args(); b=workload()
    if a.action=='setup': b.setup(); b.repair()
    elif a.action=='baseline': b.load('baseline',180,8); capture(b,'baseline')
    elif a.action=='limited': recreate(b,limited=True,protected=False); b.load('limited-disk',300,8); capture(b,'limited-disk')
    elif a.action=='protected': recreate(b,limited=True,protected=True); b.load('limited-protected',300,8); capture(b,'limited-protected')
    elif a.action=='protected-final': recreate(b,limited=True,protected=True); b.load('limited-protected-final',180,8); capture(b,'limited-protected-final')
    elif a.action=='probe':
        b.probe()
        report=json.loads((b.OUT/'probe.json').read_text())
        assert len(report)==28 and all(x['status']==200 for x in report)
        b.save('recovery',{'positive':28,'foreign_account_denied':8,'passed':True})
    elif a.action=='cleanup':
        b.cleanup()
        (JOB/'protected.enabled').unlink(missing_ok=True)
