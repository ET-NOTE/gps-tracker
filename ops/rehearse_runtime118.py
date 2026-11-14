"""Real systemd/PG14 rehearsal, synthetic data only, build host only.

python3 rehearse_runtime118.py [run|cleanup]
No host devices/sysctls, published ports, production data or production writes.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone

JOB = Path('/home/etcom-hub/build/gps-runtime118-20261112')
HOST = 'gps-runtime118-host'
NET = 'gps-runtime118-private'
IMAGE = 'gps-runtime118:20261112'
OUT = JOB / 'out'


def call(*args, check=True):
    p = subprocess.run(args, text=True, capture_output=True, timeout=120)
    if check and p.returncode:
        raise RuntimeError('command failed: ' + repr(args[:4]) + '\n' + p.stdout[-3000:] + p.stderr[-3000:])
    return p


def inside(*args, check=True):
    return call('docker', 'exec', HOST, *args, check=check)


def write(path, content):
    target = JOB / 'generated' / path.lstrip('/')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    inside('mkdir', '-p', str(Path(path).parent))
    call('docker', 'cp', str(target), HOST + ':' + path)
    inside('chown', 'root:root', path)
    inside('chmod', '0644', path)


def sql(query, check=True):
    return inside('sudo', '-u', 'postgres', 'psql', '-X', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query, check=check)


def wait_db(active=True):
    for _ in range(60):
        state = inside('systemctl', 'is-active', 'gps118-db.service', check=False).stdout.strip()
        ready = inside('sudo', '-u', 'postgres', 'pg_isready', check=False).returncode == 0
        if (active and state == 'active' and ready) or (not active and state != 'active' and not ready):
            return state
        time.sleep(.2)
    raise RuntimeError('database did not reach expected state: ' + state)


def cleanup():
    inspect = call('docker', 'inspect', HOST, check=False)
    if inspect.returncode == 0:
        assert json.loads(inspect.stdout)[0]['Config']['Labels']['gps.runtime118'] == 'synthetic'
        call('docker', 'rm', '-f', HOST)
    inspect = call('docker', 'network', 'inspect', NET, check=False)
    if inspect.returncode == 0:
        assert json.loads(inspect.stdout)[0]['Labels']['gps.runtime118'] == 'synthetic'
        call('docker', 'network', 'rm', NET)


def configure():
    write('/etc/systemd/system/run-gps118-sort.mount', '''[Unit]
Description=GPS118 synthetic protected sort
[Mount]
What=tmpfs
Where=/run/gps118/sort
Type=tmpfs
Options=size=256M,mode=0700,uid=postgres,gid=postgres,nosuid,nodev,noexec
''')
    write('/etc/systemd/system/run-gps118-fallback.mount', '''[Unit]
Description=GPS118 synthetic protected fallback
[Mount]
What=tmpfs
Where=/run/gps118/fallback
Type=tmpfs
Options=size=64M,mode=0700,uid=postgres,gid=postgres,nosuid,nodev,noexec
''')
    # Root-owned underlays: absence cannot silently create a plaintext directory.
    inside('install', '-d', '-o', 'root', '-g', 'root', '-m', '0555', '/run/gps118', '/run/gps118/sort', '/run/gps118/fallback')
    inside('ln', '-s', '/run/gps118/fallback/pgsql_tmp', '/var/lib/postgresql/14/main/base/pgsql_tmp')
    write('/etc/systemd/system/gps118-temp-ready.service', '''[Unit]
BindsTo=run-gps118-sort.mount run-gps118-fallback.mount
After=run-gps118-sort.mount run-gps118-fallback.mount
Before=gps118-db.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/install -d -o postgres -g postgres -m 0700 /run/gps118/sort/work /run/gps118/sort/work/PG_14_202107181 /run/gps118/fallback/pgsql_tmp /run/postgresql/14-main.pg_stat_tmp
''')
    library_sha = inside('sha256sum', '/usr/local/lib/gps-nodump.so').stdout.split()[0]
    plan = {'library': '/usr/local/lib/gps-nodump.so', 'library_sha256': library_sha,
        'mounts': [{'path': '/run/gps118/sort', 'max_bytes': 256*1024**2},
                   {'path': '/run/gps118/fallback', 'max_bytes': 64*1024**2}],
        'fallback_link': '/var/lib/postgresql/14/main/base/pgsql_tmp',
        'fallback_target': '/run/gps118/fallback/pgsql_tmp', 'memory_max_bytes': 1500*1024**2}
    write('/etc/gps118/plan.json', json.dumps(plan))
    write('/etc/systemd/system/gps118-db.service', '''[Unit]
Description=GPS118 isolated PostgreSQL
BindsTo=run-gps118-sort.mount run-gps118-fallback.mount
Requires=gps118-temp-ready.service
After=gps118-temp-ready.service run-gps118-sort.mount run-gps118-fallback.mount
[Service]
User=postgres
Group=postgres
Environment=LD_PRELOAD=/usr/local/lib/gps-nodump.so
ExecStartPre=/usr/bin/python3 /usr/local/lib/runtime118_guard.py /etc/gps118/plan.json
ExecStart=/usr/lib/postgresql/14/bin/postgres -D /var/lib/postgresql/14/main -c config_file=/etc/postgresql/14/main/postgresql.conf -c shared_buffers=128MB -c max_connections=50 -c work_mem=64kB -c logging_collector=off
KillSignal=SIGINT
TimeoutStopSec=20
MemoryMax=1500M
MemorySwapMax=0
LimitCORE=0
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/postgresql/14/main /run/postgresql /run/gps118
[Install]
WantedBy=multi-user.target
''')
    inside('systemctl', 'daemon-reload')
    inside('systemctl', 'enable', 'gps118-db.service')
    return plan


SORT = "SET temp_tablespaces='gps118_sort'; SET work_mem='64kB'; EXPLAIN (ANALYZE,FORMAT JSON) SELECT count(*) FROM (SELECT repeat(md5(g::text),4) s FROM generate_series(1,100000) g ORDER BY s) q"


def run():
    assert Path.cwd() == JOB and JOB.name == 'gps-runtime118-20261112'
    assert call('hostname').stdout.strip() == 'etcom-hub'
    OUT.mkdir(exist_ok=True)
    cleanup()
    call('docker', 'network', 'create', '--internal', '--label', 'gps.runtime118=synthetic', NET)
    call('docker', 'run', '-d', '--name', HOST, '--label', 'gps.runtime118=synthetic', '--network', NET,
         '--cgroupns=private', '--cap-add', 'SYS_ADMIN', '--security-opt', 'seccomp=unconfined',
         '--security-opt', 'apparmor=unconfined', '--tmpfs', '/run', '--tmpfs', '/run/lock', '--tmpfs', '/tmp',
         '--memory=1900m', '--memory-swap=1900m', '-e', 'container=docker', IMAGE,
         'sh', '-c', 'mount -o remount,rw /sys/fs/cgroup; exec /sbin/init')
    for _ in range(60):
        if inside('systemctl', 'is-system-running', check=False).stdout.strip() in ('running', 'degraded'):
            break
        time.sleep(.3)
    plan = configure()
    report = {'utc': datetime.now(timezone.utc).isoformat(), 'scope': 'isolated real systemd + PostgreSQL14; synthetic data only',
              'production_changed': False, 'checks': [], 'plan': plan}

    def record(name, passed, **evidence):
        report['checks'].append({'name': name, 'passed': bool(passed), **evidence})
        (OUT / 'rehearsal.json').write_text(json.dumps(report, indent=2))
        print(name + ': ' + ('PASS' if passed else 'FAIL'), flush=True)
        assert passed, name

    inside('systemctl', 'start', 'gps118-db')
    wait_db()
    record('guarded database starts', True, version=sql('SHOW server_version').stdout.strip())
    inside('rmdir', '/run/gps118/sort/work/PG_14_202107181')
    sql("CREATE TABLESPACE gps118_sort LOCATION '/run/gps118/sort/work'")
    sort = sql(SORT).stdout
    record('real SQL spills to protected sort', 'external merge' in sort, explain=sort)
    sql("CREATE TABLE fixture_keep(id int PRIMARY KEY); INSERT INTO fixture_keep VALUES(118)")
    # Failed startup must not revive without valid storage/library/swap controls.
    for key in ('library_sha256', 'memory_max_bytes'):
        inside('systemctl', 'stop', 'gps118-db')
        invalid = dict(plan, **{key: '0'*64 if key == 'library_sha256' else 1})
        write('/etc/gps118/plan.json', json.dumps(invalid))
        attempt = inside('systemctl', 'start', 'gps118-db', check=False)
        record('startup rejects '+key, attempt.returncode != 0 and wait_db(False) != 'active')
        write('/etc/gps118/plan.json', json.dumps(plan))
        inside('systemctl', 'reset-failed', 'gps118-db')
        inside('systemctl', 'start', 'gps118-db')
        wait_db()
    inside('systemctl', 'stop', 'gps118-db')
    write('/etc/systemd/system/gps118-db.service.d/test-swap.conf', '[Service]\nMemorySwapMax=infinity\n')
    inside('systemctl', 'daemon-reload')
    rejected = inside('systemctl', 'start', 'gps118-db', check=False)
    record('startup rejects unbounded service swap', rejected.returncode != 0 and wait_db(False) != 'active')
    inside('rm', '/etc/systemd/system/gps118-db.service.d/test-swap.conf')
    inside('systemctl', 'daemon-reload')
    inside('systemctl', 'reset-failed', 'gps118-db')
    inside('systemctl', 'start', 'gps118-db')
    wait_db()
    inside('systemctl', 'stop', 'gps118-db')
    inside('mount', '-o', 'remount,exec', '/run/gps118/sort')
    rejected = inside('systemctl', 'start', 'gps118-db', check=False)
    record('startup rejects unsafe mount options', rejected.returncode != 0 and wait_db(False) != 'active')
    inside('mount', '-o', 'remount,noexec', '/run/gps118/sort')
    inside('systemctl', 'reset-failed', 'gps118-db')
    inside('systemctl', 'start', 'gps118-db')
    wait_db()
    for which in ('sort', 'fallback'):
        unit = 'run-gps118-'+which+'.mount'
        inside('systemctl', 'stop', unit)
        state = wait_db(False)
        target = '/run/gps118/'+which+'/forbidden'
        denied = inside('sudo', '-u', 'postgres', 'mkdir', target, check=False)
        record('mount loss stops DB and underlay denies writes: '+which, denied.returncode != 0,
               database_state=state, underlay=inside('stat','-c','%u %g %a','/run/gps118/'+which).stdout.strip())
        # Unit masking models mount failure at next startup.
        inside('mv', '/etc/systemd/system/'+unit, '/root/'+unit)
        inside('systemctl', 'mask', unit)
        attempt = inside('systemctl', 'start', 'gps118-db', check=False)
        record('missing mount refuses DB startup: '+which, attempt.returncode != 0 and wait_db(False) != 'active')
        inside('systemctl', 'unmask', unit)
        inside('mv', '/root/'+unit, '/etc/systemd/system/'+unit)
        inside('systemctl', 'daemon-reload')
        inside('systemctl', 'reset-failed')
        inside('systemctl', 'start', 'gps118-db')
        wait_db()
        record('mount restored and persistent data retained: '+which, sql('SELECT id FROM fixture_keep').stdout.strip() == '118' and 'external merge' in sql(SORT).stdout)
    # Externally unmount without systemctl: systemd detects it and stops dependents.
    inside('umount', '/run/gps118/sort')
    record('external unmount detected', wait_db(False) != 'active')
    inside('systemctl', 'start', 'gps118-db')
    wait_db()
    # Physical selected directory loss is different from mount loss: PG falls back.
    inside('mv', '/run/gps118/sort/work', '/run/gps118/sort/work.hidden')
    before = sql("SELECT temp_bytes FROM pg_stat_database WHERE datname=current_database()").stdout
    fallback = sql(SORT)
    record('missing selected directory uses protected fallback', 'external merge' in fallback.stdout,
           fallback_target=inside('readlink', '/var/lib/postgresql/14/main/base/pgsql_tmp').stdout.strip(), previous_temp_bytes=before.strip())
    # Fill fallback while selected directory is absent; no ordinary disk bypass.
    filled = inside('sudo', '-u', 'postgres', 'dd', 'if=/dev/zero', 'of=/run/gps118/fallback/fill', 'bs=1M', 'count=64', check=False)
    failed = sql(SORT, check=False)
    record('full fallback rejects sort instead of disk bypass', failed.returncode != 0 and 'No space left' in failed.stderr,
           expected_error=failed.stderr.strip())
    inside('rm', '/run/gps118/fallback/fill')
    inside('mv', '/run/gps118/sort/work.hidden', '/run/gps118/sort/work')
    record('capacity recovery', 'external merge' in sql(SORT).stdout)
    # Do not mutate shared host core_pattern. Process itself disables core dumping.
    write('/usr/local/lib/gps118_probe.py', '''import ctypes, json, os, signal, subprocess, sys
libc=ctypes.CDLL(None)
dumpable=libc.prctl(3,0,0,0,0)
if len(sys.argv)>1:
    print(dumpable)
    sys.exit(0)
child=subprocess.check_output([sys.executable,__file__,'child'],text=True).strip()
pid=os.fork()
if pid==0:
    os.abort()
_,status=os.waitpid(pid,0)
print(json.dumps(dict(dumpable=dumpable,exec_dumpable=int(child),fork_abort_signal=os.WTERMSIG(status),core_dumped=os.WCOREDUMP(status))))
''')
    probe = inside('sudo', '-u', 'postgres', 'env', 'LD_PRELOAD=/usr/local/lib/gps-nodump.so', 'python3', '/usr/local/lib/gps118_probe.py')
    values = json.loads(probe.stdout)
    record('non-dumpable after exec and fork crash', values['dumpable'] == 0 and values['exec_dumpable'] == 0 and values['fork_abort_signal'] == 6 and not values['core_dumped'], result=values,
           core_pattern=inside('cat', '/proc/sys/kernel/core_pattern').stdout.strip())
    # Real PG backend abort, not a synthetic service replacing postgres.
    sleeper = subprocess.Popen(['docker','exec',HOST,'sudo','-u','postgres','psql','-X','-Atc','SELECT pg_sleep(30)'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    pid = ''
    for _ in range(30):
        pid=sql("SELECT pid FROM pg_stat_activity WHERE query='SELECT pg_sleep(30)' AND pid<>pg_backend_pid()").stdout.strip()
        if pid:
            break
        time.sleep(.1)
    assert pid.isdigit()
    inside('kill', '-ABRT', pid)
    sleeper.communicate(timeout=15)
    for _ in range(60):
        if sql('SELECT id FROM fixture_keep', check=False).stdout.strip() == '118':
            break
        time.sleep(.2)
    logs=inside('journalctl','-u','gps118-db','--no-pager','-n','45').stdout
    record('PG backend crash recovers data and protected sort', sql('SELECT id FROM fixture_keep').stdout.strip()=='118' and 'external merge' in sql(SORT).stdout and 'signal 6' in logs and 'core dumped' not in logs,
           crash_logged='signal 6' in logs, log=logs)
    # Container restart executes real unit boot dependencies with empty /run tmpfs.
    call('docker', 'restart', HOST)
    wait_db()
    record('cold service boot reconstructs protected mounts', sql('SELECT id FROM fixture_keep').stdout.strip()=='118' and 'external merge' in sql(SORT).stdout,
           service=inside('systemctl','show','gps118-db','-p','MemoryCurrent','-p','MemorySwapMax','-p','MemoryMax','-p','LimitCORE').stdout)
    sql("CREATE ROLE gps118_client LOGIN PASSWORD 'synthetic-only' CONNECTION LIMIT 28; CREATE ROLE shared118_client LOGIN PASSWORD 'synthetic-only' CONNECTION LIMIT 16; CREATE ROLE maintenance118 LOGIN PASSWORD 'synthetic-only' CONNECTION LIMIT 4")
    write('/usr/local/lib/gps118_connections.py', '''import json,psycopg2
connections=[]
def connect(role):
    c=psycopg2.connect(host='127.0.0.1',dbname='postgres',user=role,password='synthetic-only',connect_timeout=3)
    connections.append(c)
    return c
result={}
try:
    for _ in range(26): connect('gps118_client')
    for _ in range(16): connect('shared118_client')
    for _ in range(2): connect('gps118_client')
    result['gps_26_plus_2_cancel_connections']=len(connections)==44
    try: connect('gps118_client'); result['role_cap']=False
    except psycopg2.OperationalError as e: result['role_cap']='too many connections for role' in str(e)
    for _ in range(3): connect('maintenance118')
    result['non_superuser_connections']=len(connections)
    try: connect('maintenance118'); result['reserved_superuser_slots']=False
    except psycopg2.OperationalError as e: result['reserved_superuser_slots']='reserved for non-replication superuser' in str(e)
    with psycopg2.connect(dbname='postgres',user='postgres') as admin:
        with admin.cursor() as cur:
            cur.execute('SELECT 1'); result['emergency_admin_connects']=cur.fetchone()[0]==1
finally:
    for c in connections: c.close()
print(json.dumps(result))
''')
    budget = json.loads(inside('sudo','-u','postgres','python3','/usr/local/lib/gps118_connections.py').stdout)
    record('bounded role connections preserve reserved access', budget.get('non_superuser_connections') == 47 and all(v is True for k,v in budget.items() if k != 'non_superuser_connections'), result=budget)
    remaining=sql("SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()").stdout.strip()
    record('connection exhaustion cleanup', remaining=='0', remaining=remaining,
           cgroup=inside('cat','/sys/fs/cgroup/system.slice/gps118-db.service/memory.events').stdout,
           swap=inside('cat','/sys/fs/cgroup/system.slice/gps118-db.service/memory.swap.current').stdout.strip())
    report['finished_utc']=datetime.now(timezone.utc).isoformat()
    report['all_passed']=all(x['passed'] for x in report['checks'])
    report['activation_ready']=False
    report['limitations']=['Shared production memory/connection budgets unbounded; no operational approval',
        'Isolated DB shared_buffers=128MB; not production performance test',
        'No production service restart, whole VPS reboot or host-wide core policy change',
        'Full cumulative116/117 API migration integration remains separate']
    (OUT/'rehearsal.json').write_text(json.dumps(report,indent=2))
    (OUT/'service-journal.log').write_text(inside('journalctl','-u','gps118-db','--no-pager').stdout)


if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='cleanup':
        cleanup()
    else:
        run()
