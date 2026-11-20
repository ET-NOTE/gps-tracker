"""Small functional fixtures only; no sustained load or production connection."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time
import rehearse_runtime121 as base

JOB = Path('/home/etcom-hub/build/gps-runtime145-20261118')
HOST, NET = 'gps-runtime145-host', 'gps-runtime145-private'
base.JOB, base.HOST, base.NET, base.OUT = JOB, HOST, NET, JOB/'out'
original = base.call


def call(*args, **kw):
    if args[:2] == ('docker', 'build'):
        return original('docker', 'image', 'inspect', 'gps-runtime123:20261113')
    return original(*('gps.runtime145=synthetic' if x == 'gps.runtime121=synthetic' else
                      'gps-runtime123:20261113' if x == 'gps-runtime121:20261113' else x for x in args), **kw)


base.call = call


def setup():
    # This is our candidate alias, not a protected prior-round artifact. Stage it
    # before the baseline snapshot so rebuilding this round does not look like
    # a rehearsal mutation of an unrelated executable.
    shutil.copy2(base.OUT/'gps-tracker-api145', base.OUT/'gps-tracker-api')
    previous_out = JOB.parent/'gps-runtime144-20261118/out'
    for name in ('gps-pdf-render', 'gps-tracker-api.baseline99'):
        shutil.copy2(previous_out/name, base.OUT/name)
    from build_cleanup_20261113 import protected, containers
    snapshot=dict(protected=protected(), containers=containers())
    previous=base.OUT/'host-before.json'
    if previous.exists():
        old=json.loads(previous.read_text())
        assert old['containers']==snapshot['containers']
        assert all(snapshot['protected'].get(k)==v for k,v in old['protected'].items())
        assert all(k.startswith(JOB.name+'/') for k in snapshot['protected'].keys()-old['protected'].keys())
    else:
        previous.write_text(json.dumps(snapshot, indent=2))
    base.setup()
    call('docker', 'cp', str(previous_out/'gps-tracker-api144'), HOST+':/opt/gps121/out/gps-tracker-api144')


def test():
    info = json.loads(call('docker', 'inspect', HOST).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime145') == 'synthetic'
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    shutil.copy2(JOB/'src/ops/test_notion_integration145.py', base.OUT/(stamp+'-functional-source.py'))
    result = base.inside('python3', '/opt/gps121/test_notion_integration145.py', check=False, timeout=300)
    (base.OUT/(stamp+'-functional.log')).write_text(result.stdout+result.stderr)
    call('docker', 'cp', HOST+':/opt/gps121/out/.', str(base.OUT))
    print(result.stdout[-5000:]+result.stderr[-3000:], flush=True)
    assert result.returncode == 0, 'functional suite failed; original log retained'


def cleanup():
    info = json.loads(call('docker', 'inspect', HOST).stdout)[0]
    net = json.loads(call('docker', 'network', 'inspect', NET).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime145') == 'synthetic'
    assert net['Internal'] and net['Labels'].get('gps.runtime145') == 'synthetic'
    assert {v['Name'] for v in net['Containers'].values()} <= {HOST}
    call('docker', 'rm', '-f', HOST)
    call('docker', 'network', 'rm', NET)
    from build_cleanup_20261113 import protected, containers
    before = json.loads((base.OUT/'host-before.json').read_text())
    after = protected()
    assert all(after.get(k) == v for k, v in before['protected'].items())
    assert containers() == before['containers']
    (base.OUT/'host-after.json').write_text(json.dumps(dict(
        preserved_files=len(before['protected']), unchanged_containers=len(before['containers']),
        synthetic_resources_removed=True, free_bytes=shutil.disk_usage(JOB).free,
        finished_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())), indent=2))
    print('PASS only145 synthetic resources removed; prior artifacts and other containers unchanged')


if __name__ == '__main__':
    base.guard()
    {'setup': setup, 'test': test, 'cleanup': cleanup}[sys.argv[1]]()
