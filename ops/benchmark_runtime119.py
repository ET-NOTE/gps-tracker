"""119: corrected PG buffers, guarded binaries, no-swap workload and cancellation.

The seed cluster contains no GPS schema/key/data until both temporary mounts
are attached and the db-disk guard has passed. Only this fixed synthetic volume
may be initialized. Not a production deployer or a general Docker wrapper.
"""
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import subprocess
import sys
import time

ROOT=Path('/home/etcom-hub/build')
JOB=ROOT/'gps-provision22-20261112runtime119'
KIT=ROOT/'gps-runtime119-20261112'


def workload():
    source=(JOB/'src/ops/benchmark_location115.py').read_text().replace('20261111query115','20261112runtime119').replace('query115','runtime119')
    sha=hashlib.sha256((JOB/'out/gps-tracker-api').read_bytes()).hexdigest()
    source=source.replace('fc8f97815eb02fc0ee9ca92e1788444f30398532bb670b6ed8d2178cb9565429',sha)
    source=source.replace('/proc/1/exe','/api')
    source=source.replace("'-e', 'GPS_LOCATION_ACCESS_LOG=on',", "'-e', 'GPS_LOCATION_TEMP_TABLESPACE=gps_runtime119_temp', '-e', 'GPS_LOCATION_ACCESS_LOG=on',")
    begin=source.index("    run('docker', 'volume', 'create'")
    end=source.index("    run('docker', 'run', '--rm'",begin)
    source=source[:begin]+"    bootstrap_database()\n"+source[end:]
    path=JOB/'benchmark_generated119.py';path.write_text(source)
    spec=importlib.util.spec_from_file_location('benchmark_generated119',path)
    b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
    b.bootstrap_database=lambda: database(b)
    original=b.start
    def start(*args,**kw):
        if not b.sql("SELECT 1 FROM pg_tablespace WHERE spcname='gps_runtime119_temp'"):
            b.run('docker','exec',b.DB,'sh','-c','mkdir -p /gps-temp/work && chown postgres:postgres /gps-temp/work /var/lib/postgresql/data/base/pgsql_tmp && chmod 700 /gps-temp/work /var/lib/postgresql/data/base/pgsql_tmp')
            b.sql("CREATE TABLESPACE gps_runtime119_temp LOCATION '/gps-temp/work'")
        b.sql('GRANT CREATE ON TABLESPACE gps_runtime119_temp TO gps_runtime')
        b.sql("ALTER ROLE gps_runtime IN DATABASE gps_runtime119_test SET temp_tablespaces='gps_runtime119_temp'")
        b.sql("ALTER ROLE gps_runtime IN DATABASE gps_runtime119_test SET temp_file_limit='128MB'")
        return original(*args,**kw)
    b.start=start
    return b


def database(b):
    # Initialize an empty cluster in a separate protected process. Use a shell
    # around the entrypoint so the seed tmpfs survives its clean DB shutdown.
    b.run('docker','volume','create','--label','gps.runtime119=synthetic',b.VOL,stdout=subprocess.DEVNULL)
    seed='gps-runtime119-seed'
    code='/usr/local/bin/docker-entrypoint.sh postgres & child=$!; while ! pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 2; su postgres -c "pg_ctl -D /var/lib/postgresql/data -m fast -w stop"; wait "$child"; test -z "$(ls -A /seed)"; cp -a /var/lib/postgresql/data/. /seed/'
    b.run('/usr/bin/docker','run','--rm','--name',seed,'--label','gps.runtime119=synthetic','--network',b.NET,
          '--memory=1500m','--memory-swap=1500m','--ulimit=core=0',
          '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=1600m',
          '--entrypoint','python3','-v',b.VOL+':/seed','-e','POSTGRES_PASSWORD=runtime119-test-only',
          '-e','POSTGRES_DB=gps_runtime119_test','gps-runtime119-db:20261112','/usr/local/lib/runtime119_entry.py','sh','-ec',code,
          stdout=subprocess.DEVNULL)
    limits=[]
    for flag,value in [('read-bps','8mb'),('write-bps','8mb'),('read-iops','200'),('write-iops','200')]:
        limits += ['--device-'+flag,'/dev/nvme0n1:'+value]
    b.run('/usr/bin/docker','run','-d','--name',b.DB,'--label','gps.runtime119=synthetic','--network',b.NET,'--network-alias','runtime119-db',
          '--cpus=2','--memory=1500m','--memory-swap=1500m','--ulimit=core=0',*limits,
          '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m','--tmpfs','/gps-temp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
          '--tmpfs','/var/lib/postgresql/data/base/pgsql_tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
          '-v',b.VOL+':/var/lib/postgresql/data','-e','GPS_RUNTIME_PROFILE=db-disk',
          'gps-runtime119-db:20261112','postgres','-c','max_connections=50','-c','shared_buffers=759736kB',
          '-c','work_mem=2532kB','-c','effective_cache_size=2225MB','-c','jit=off','-c','track_io_timing=on',
          '-c','log_parameter_max_length=0','-c','log_parameter_max_length_on_error=0',stdout=subprocess.DEVNULL)
    for _ in range(60):
        try:
            if b.sql('SELECT 1')==[(1,)]: break
        except Exception: pass
        time.sleep(1)
    else: raise RuntimeError('protected DB not ready')
    assert b.sql("SELECT setting::bigint*8192 FROM pg_settings WHERE name='shared_buffers'")==[(777969664,)]


def capture(b, name):
    raw = subprocess.check_output(['docker','logs',b.API],stderr=subprocess.STDOUT)
    lines = [x for x in raw.decode().splitlines() if 'access ledger timing' in x]
    (b.OUT/(name+'-timing.log')).write_text(re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(lines))+'\n')


if __name__=='__main__':
    b=workload()
    if sys.argv[1]=='setup': b.setup(); b.repair()
    elif sys.argv[1]=='load':
        b.run('docker','rm','-f',b.API,stdout=subprocess.DEVNULL)
        b.start(poll=300)
        b.run('docker','rm','-f',b.PROXY,stdout=subprocess.DEVNULL)
        b.tls_setup()
        b.load('protected-corrected',300,8)
        capture(b,'protected-corrected')
    elif sys.argv[1]=='probe': b.probe()
    elif sys.argv[1]=='business':
        exec(compile((JOB/'business119.py').read_text(),'business119.py','exec'))
    elif sys.argv[1]=='faults':
        exec(compile((JOB/'faults119.py').read_text(),'faults119.py','exec'))
