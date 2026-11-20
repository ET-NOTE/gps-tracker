"""Native PG/API/job profiles for an isolated 121 rehearsal, not an installer.

The root fixture controls unit configuration. Runtime jobs do not receive
systemctl permission. Transition retains root/CHOWN only to preserve existing
API file ownership; this is deliberately not called an unprivileged job.
"""
import json
from pathlib import Path
import pdf_runtime120

ROOT = '/opt/gps121'
UNIT = Path('/etc/systemd/system')
MOUNTS = ['run-gps121-sort.mount', 'run-gps121-fallback.mount', 'run-gps121-tmp.mount']


def files(library_sha):
    class Site:
        units = UNIT
        renderer = Path('/opt/gps-pdf-render')
    result = {str(k): v for k, v in pdf_runtime120.files(Site(), 4096).items()
              if '.service.d/' not in str(k)}
    result['/usr/local/lib/pdf_budget120.py'] = pdf_runtime120.budget_script()
    for name, size, mode, owner in [('sort', 256, '0700', ',uid=postgres,gid=postgres'),
                                     ('fallback', 64, '0700', ',uid=postgres,gid=postgres'),
                                     ('tmp', 64, '1777', '')]:
        result[str(UNIT / ('run-gps121-'+name+'.mount'))] = f'''[Unit]
Requires=gps121-underlay.service
After=gps121-underlay.service
[Mount]
What=tmpfs
Where=/run/gps121/{name}
Type=tmpfs
Options=size={size}M,mode={mode}{owner},nosuid,nodev,noexec
'''
    # Local mounts precede local-fs.target/sysinit. A normal service's implicit
    # After=sysinit would create a boot/shutdown ordering cycle with these mounts.
    result[str(UNIT/'gps121-underlay.service')] = '''[Unit]
DefaultDependencies=no
After=systemd-remount-fs.service
Before=local-fs.target shutdown.target
Conflicts=shutdown.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/install -d -o root -g root -m 0555 /run/gps121 /run/gps121/tmp /run/gps121/sort /run/gps121/fallback
'''
    result[str(UNIT/'gps121-temp-ready.service')] = '''[Unit]
BindsTo=run-gps121-sort.mount run-gps121-fallback.mount run-gps121-tmp.mount
After=run-gps121-sort.mount run-gps121-fallback.mount run-gps121-tmp.mount
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/install -d -o postgres -g postgres -m 0700 /run/gps121/sort/work /run/gps121/sort/work/PG_14_202107181 /run/gps121/fallback/pgsql_tmp /run/postgresql/14-main.pg_stat_tmp
'''
    sizes = {'db': 1500, 'api': 550, 'job': 550}
    for name, mib in sizes.items():
        plan = dict(library='/usr/local/lib/gps-nodump.so', library_sha256=library_sha,
                    mounts=[dict(path='/tmp', max_bytes=64*1024**2)],
                    fallback_link='/etc/gps121/tmp', fallback_target='/tmp', memory_max_bytes=mib*1024**2)
        if name == 'db':
            plan['mounts'] += [dict(path='/run/gps121/sort', max_bytes=256*1024**2),
                               dict(path='/run/gps121/fallback', max_bytes=64*1024**2)]
            plan.update(fallback_link='/var/lib/postgresql/14/main/base/pgsql_tmp',
                        fallback_target='/run/gps121/fallback/pgsql_tmp')
        result['/etc/gps121/'+name+'.json'] = json.dumps(plan)
    common = '''[Unit]
BindsTo=run-gps121-sort.mount run-gps121-fallback.mount run-gps121-tmp.mount
Requires=gps121-temp-ready.service
After=gps121-temp-ready.service run-gps121-sort.mount run-gps121-fallback.mount run-gps121-tmp.mount
[Service]
Environment=LD_PRELOAD=/usr/local/lib/gps-nodump.so
Environment=PYTHONDONTWRITEBYTECODE=1
MemorySwapMax=0
LimitCORE=0
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
BindPaths=/run/gps121/tmp:/tmp
BindPaths=/run/gps121/tmp:/var/tmp
Slice=gps-workload.slice
KillMode=control-group
TimeoutStartSec=900
TimeoutStopSec=25
'''
    result[str(UNIT/'gps121-db.service')] = common + '''User=postgres
Group=postgres
MemoryMax=1500M
CapabilityBoundingSet=
ExecStartPre=/usr/bin/python3 /usr/local/lib/runtime118_guard.py /etc/gps121/db.json
ExecStart=/usr/lib/postgresql/14/bin/postgres -D /var/lib/postgresql/14/main -c config_file=/etc/postgresql/14/main/postgresql.conf -c shared_preload_libraries=timescaledb -c shared_buffers=128MB -c max_connections=50 -c work_mem=2532kB -c logging_collector=off -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 -c listen_addresses=127.0.0.1
KillSignal=SIGINT
ReadWritePaths=/var/lib/postgresql/14/main /run/postgresql /run/gps121
[Install]
WantedBy=multi-user.target
'''
    for name, user, command in [
        ('api', 'gps-api', '/opt/gps121/active-api'),
        ('migration', 'gps-api', '/opt/gps-tracker-api'),
        ('transition', 'root', '/usr/bin/python3 /opt/gps121/runtime121_job.py transition'),
        ('cleanup', 'gps-api', '/usr/bin/python3 /opt/gps121/runtime121_job.py cleanup'),
        ('closure', 'gps-api', '/usr/bin/python3 /opt/gps121/runtime121_job.py closure'),
        ('recovery', 'postgres', '/usr/bin/python3 /opt/gps121/runtime121_job.py recovery'),
        ('checkpoint', 'postgres', '/usr/bin/python3 /opt/gps121/runtime121_job.py checkpoint'),
    ]:
        profile = 'api' if name == 'api' else 'job'
        credential = '' if name in ('api', 'migration') else f'BindReadOnlyPaths=/etc/gps121/credentials/{name}:/run/gps121creds\nEnvironment=CREDENTIALS_DIRECTORY=/run/gps121creds\n'
        env = 'EnvironmentFile=/etc/gps121/'+name+'.env\n' if name in ('api', 'migration') else ''
        caps = 'CAP_CHOWN CAP_DAC_OVERRIDE' if user == 'root' else ''
        result[str(UNIT/('gps121-'+name+'.service'))] = common + f'''User={user}
Group={user}
MemoryMax=550M
CapabilityBoundingSet={caps}
{credential}{env}ExecStartPre=/usr/bin/python3 /usr/local/lib/runtime118_guard.py /etc/gps121/{profile}.json
ExecStart={command}
ReadWritePaths=/opt/gps121/out /opt/gps121/test-storage /opt/gps121/job-results /opt/gps121/recovery
''' + ('Type=oneshot\n' if name != 'api' else '')
    return result
