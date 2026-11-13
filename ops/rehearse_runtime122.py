"""Fixed synthetic build-host capacity test; never deploys to production."""
import json
from pathlib import Path
import subprocess
import sys
import rehearse_runtime121 as base
import runtime121_units

JOB = Path('/home/etcom-hub/build/gps-runtime122-20261113')
HOST = 'gps-runtime122-host'
NET = 'gps-runtime122-private'
base.JOB, base.HOST, base.NET, base.OUT = JOB, HOST, NET, JOB/'out'
original_call = base.call
original_files = runtime121_units.files


def call(*args, **kw):
    if args[:2] == ('docker', 'build'):
        return original_call('docker', 'image', 'inspect', 'gps-runtime122:20261113')
    args = list(args)
    if args[:2] == ['docker', 'run']:
        args = [('gps.runtime122=synthetic' if x == 'gps.runtime121=synthetic' else
                 'gps-runtime122:20261113' if x == 'gps-runtime121:20261113' else
                 '--memory=5120m' if x == '--memory=4096m' else
                 '--memory-swap=5120m' if x == '--memory-swap=4096m' else x) for x in args]
        index = args.index('--memory=5120m')
        # Shared disk/CPU envelope; initialization is also inside this budget.
        args[index:index] = ['--cpus=2', '--device-read-bps=/dev/nvme0n1:8mb',
            '--device-write-bps=/dev/nvme0n1:8mb', '--device-read-iops=/dev/nvme0n1:200',
            '--device-write-iops=/dev/nvme0n1:200']
    if args[:3] == ['docker', 'network', 'create']:
        args = ['gps.runtime122=synthetic' if x == 'gps.runtime121=synthetic' else x for x in args]
    return original_call(*args, **kw)


def files(sha):
    result = original_files(sha)
    result['/etc/systemd/system/gps-workload.slice'] = result['/etc/systemd/system/gps-workload.slice'].replace('MemoryMax=4096M', 'MemoryMax=3072M')
    for kind, cap in [('db', 1408), ('api', 384), ('job', 128)]:
        plan = json.loads(result['/etc/gps121/'+kind+'.json'])
        plan['memory_max_bytes'] = cap*1024**2
        result['/etc/gps121/'+kind+'.json'] = json.dumps(plan)
    for name in ['db', 'api', 'migration', 'transition', 'cleanup', 'closure', 'recovery', 'checkpoint']:
        path = '/etc/systemd/system/gps121-'+name+'.service'
        cap = 1408 if name == 'db' else 384 if name == 'api' else 128
        result[path] = result[path].replace('MemoryMax=1500M', 'MemoryMax=1408M').replace('MemoryMax=550M', f'MemoryMax={cap}M')
    db = '/etc/systemd/system/gps121-db.service'
    result[db] = result[db].replace('shared_buffers=128MB', 'shared_buffers=512MB').replace('max_connections=50', 'max_connections=64').replace('work_mem=2532kB', 'work_mem=2532kB -c jit=off -c track_io_timing=on')
    return result


base.call = call
runtime121_units.files = files


def suite(action, timeout=1200):
    base.guard()
    p = base.inside('python3', '/opt/gps121/load_runtime122.py', action, check=False, timeout=timeout)
    (base.OUT/(action+'.log')).write_text(p.stdout+p.stderr)
    original_call('docker', 'cp', HOST+':/opt/gps121/out/.', str(base.OUT))
    print(p.stdout[-2500:]+p.stderr[-1500:], flush=True)
    assert p.returncode == 0, action


def cleanup():
    base.guard()
    info = json.loads(original_call('docker', 'inspect', HOST).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime122') == 'synthetic'
    network = json.loads(original_call('docker', 'network', 'inspect', NET).stdout)[0]
    assert network['Internal'] and network['Labels'].get('gps.runtime122') == 'synthetic'
    assert {v['Name'] for v in network['Containers'].values()} <= {HOST}
    original_call('docker', 'rm', '-f', HOST)
    original_call('docker', 'network', 'rm', NET)
    print('PASS only labelled122 synthetic container, database, keys and internal network removed')


if __name__ == '__main__':
    action = sys.argv[1]
    if action == 'setup': base.setup()
    elif action == 'cleanup': cleanup()
    else: suite(action)
