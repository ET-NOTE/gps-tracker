"""Pinned 99->113 native recovery rehearsal. Synthetic build host only.

Reuse reviewed121 services and124 binaries; never edits historical fixtures or
migration checksums. Generated adapters and their hashes are retained as evidence.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time
import rehearse_runtime121 as base

JOB = Path('/home/etcom-hub/build/gps-runtime125-20261114')
HOST, NET = 'gps-runtime125-host', 'gps-runtime125-private'
API_SHA = '89293eb52d7c07229e7fdfa594a63aa61282abe14ed1bf5d0a66d21fb3e15bc8'
base.JOB, base.HOST, base.NET, base.OUT = JOB, HOST, NET, JOB/'out'
original_call = base.call


def call(*args, **kw):
    if args[:2] == ('docker', 'build'):
        return original_call('docker', 'image', 'inspect', 'gps-runtime123:20261113')
    args = ['gps.runtime125=synthetic' if x == 'gps.runtime121=synthetic' else
            'gps-runtime123:20261113' if x == 'gps-runtime121:20261113' else x for x in args]
    if args[:2] == ['docker', 'run']:
        args.insert(args.index('--memory=4096m'), '--cpus=2')
    return original_call(*args, **kw)


base.call = call


def sha(data):
    return hashlib.sha256(data).hexdigest()


def replace(source, old, new, count=None):
    assert old in source, old
    if count is not None:
        assert source.count(old) == count, (old, source.count(old), count)
    return source.replace(old, new)


def adapter(name):
    raw = (JOB/'src/ops'/name).read_bytes()
    source = raw.decode().replace('\r\n', '\n')
    if name == 'runtime121_cumulative.py':
        source = replace(source, '56912e102bd55db65f253d7f19c409a04e239b8e993f60baead577e51efbf536', API_SHA, 1)
        source = replace(source, 'range(100, 113)', 'range(100, 114)', 1)
        source = replace(source, '112', '113')
        source = replace(source, 'all thirteen', 'all fourteen', 1)
        #113 only changes functions: column-only fingerprints cannot prove rollback.
        source = replace(source, '        try:\n            with db.transaction():',
            '        before_functions = db.execute("SELECT md5(string_agg(pg_get_functiondef(p.oid),\'\' ORDER BY p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=\'public\' AND p.prokind=\'f\'").fetchone()[0]\n        try:\n            with db.transaction():', 1)
        source = replace(source, '        assert identities(db) == before_id and locations(db) == before_location',
            '        assert db.execute("SELECT md5(string_agg(pg_get_functiondef(p.oid),\'\' ORDER BY p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=\'public\' AND p.prokind=\'f\'").fetchone()[0] == before_functions\n        assert identities(db) == before_id and locations(db) == before_location', 1)
        source = replace(source, "quiet('docker', 'exec', DB, 'dropdb', '-U', 'postgres', '--force', 'gps_cumulative_restore')",
            "from verify_runtime125_reads import restored\nrestored(restore_dsn, runtime.rsplit('/',1)[0]+'/gps_cumulative_restore', uid, did, ring)\nquiet('docker', 'exec', DB, 'dropdb', '-U', 'postgres', '--force', 'gps_cumulative_restore')", 1)
    elif name in ('test_runtime121.py', 'validate_runtime121.py', 'collect_runtime121.py'):
        source = replace(source, '112', '113')
    compile(source, name, 'exec')
    folder = base.OUT/'adapters'; folder.mkdir(exist_ok=True)
    target = folder/name; target.write_text(source)
    manifest = folder/'hashes.json'
    values = json.loads(manifest.read_text()) if manifest.exists() else {}
    values[name] = dict(source_sha256=sha(raw), generated_sha256=sha(target.read_bytes()))
    manifest.write_text(json.dumps(values, indent=2))
    return target


def prepare():
    base.guard()
    base.OUT.mkdir(exist_ok=True)
    assert not (base.OUT/'host-before.json').exists()
    from build_cleanup_20261113 import protected, containers
    snapshot = dict(protected=protected(), containers=containers(), free_bytes=shutil.disk_usage(JOB).free)
    (base.OUT/'host-before.json').write_text(json.dumps(snapshot, indent=2))
    #Only reproducible Rust targets; retained binaries, archives and DBs untouched.
    if snapshot['free_bytes'] < 4.5*1024**3:
        import fcntl
        cache=JOB.parent/'gps-tracker/cache'
        with (cache/'build.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            assert not any(p.read_text().strip() in ('cargo','rustc') for p in Path('/proc').glob('[0-9]*/comm') if p.exists())
            removed=[]
            for name in ('debug','release'):
                path=cache/'target'/name
                assert path.resolve()==path and not path.is_symlink() and path.parent==cache/'target'
                size=int(original_call('du','-sx','-B1',str(path)).stdout.split()[0])
                shutil.rmtree(path); removed.append(dict(path=str(path),bytes=size))
            after=protected()
            assert all(after.get(k)==v for k,v in snapshot['protected'].items())
            (base.OUT/'cache-cleanup125.json').write_text(json.dumps(dict(removed=removed,
                preserved_files=len(snapshot['protected']),free_bytes=shutil.disk_usage(JOB).free),indent=2))
    assert shutil.disk_usage(JOB).free > 4*1024**3
    prior = JOB.parent/'gps-runtime124-20261114'
    archive = prior/'candidate-runtime124-20261114-r1.tar.gz'
    assert sha(archive.read_bytes()) == '353c16488c7f4aa0fb6cbc264ab0a30f9330ec0fe875ae59208c8be9ec195649'
    for name, digest in [('gps-tracker-api', API_SHA),
        ('gps-pdf-render', 'f73150c48d4a4507547ae5f63f01f3f7a817e820e87c49492a08948059b662d2'),
        ('gps-tracker-api.baseline99', 'fa1e51e3d39473ca2852ac6b2899790547fa6667bb7337c646d29258a3e1c0fe')]:
        source = prior/'out'/name
        if not source.exists(): source = JOB.parent/'gps-runtime121-20261113/out'/name
        assert sha(source.read_bytes()) == digest, name
        shutil.copy2(source, base.OUT/name)
    #Exact older SQLx bytes from the tested124 canonical tree;113 unchanged.
    source = prior/'canonical/gps-tracker-api/migrations'
    target = JOB/'canonical/gps-tracker-api/migrations'
    shutil.copytree(source, target)
    finish_prepare()


def finish_prepare():
    assert sha((base.OUT/'gps-tracker-api').read_bytes()) == API_SHA
    target = JOB/'canonical/gps-tracker-api/migrations'
    newer = JOB/'src/gps-tracker-api/migrations/0113_location_device_projection.sql'
    built = JOB.parent/'gps-runtime124-20261114/src/gps-tracker-api/migrations'/newer.name
    assert newer.read_bytes()==built.read_bytes()
    shutil.copy2(built,target/built.name)
    manifest = {p.name:sha(p.read_bytes()) for p in target.glob('*.sql')}
    assert len(manifest) == 113
    (base.OUT/'migration-bytes.json').write_text(json.dumps(manifest, indent=2))
    print('PASS pinned124/99 binaries, all113 exact migration bytes, host preservation snapshot', flush=True)


def setup():
    base.setup()
    for name in ('runtime121_cumulative.py', 'test_runtime121.py'):
        original_call('docker', 'cp', str(adapter(name)), HOST+':/opt/gps121/'+name)
    base.write('/opt/gps121/candidate124.sha256', API_SHA)
    print('PASS125 native fixture ready:2CPU/4GiB, internal network, no published port/bind', flush=True)


def suite(name, timeout=1800):
    info = json.loads(original_call('docker','inspect',HOST).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime125') == 'synthetic'
    started = time.time()
    p = base.inside('python3', '/opt/gps121/'+name, check=False, timeout=timeout)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(started))
    log = base.OUT/(stamp+'-'+name.replace('.py','.log'))
    log.write_text(p.stdout+p.stderr)
    original_call('docker','cp',HOST+':/opt/gps121/out/.',str(base.OUT))
    with (base.OUT/'commands.jsonl').open('a') as f:
        f.write(json.dumps(dict(started_utc=stamp,seconds=round(time.time()-started,3),
            command=['python3','/opt/gps121/'+name],exit=p.returncode,log=log.name,
            free_bytes=shutil.disk_usage(JOB).free))+'\n')
    print(p.stdout[-4000:]+p.stderr[-3000:], flush=True)
    assert p.returncode == 0, name


def reboot():
    import importlib.util
    path = adapter('validate_runtime121.py')
    spec = importlib.util.spec_from_file_location('validate125',path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    for n in (1,2):
        module.reboot()
        shutil.copy2(base.OUT/'reboot121.json', base.OUT/f'reboot125-{n}.json')
        shutil.copy2(base.OUT/'reboot-order121.log',base.OUT/f'reboot-order125-{n}.log')


def cleanup():
    info = json.loads(original_call('docker','inspect',HOST).stdout)[0]
    net = json.loads(original_call('docker','network','inspect',NET).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime125') == 'synthetic'
    assert net['Internal'] and net['Labels'].get('gps.runtime125') == 'synthetic'
    assert {v['Name'] for v in net['Containers'].values()} <= {HOST}
    original_call('docker','rm','-f',HOST)
    original_call('docker','network','rm',NET)
    from build_cleanup_20261113 import protected, containers
    before=json.loads((base.OUT/'host-before.json').read_text()); after=protected()
    assert all(after.get(k)==v for k,v in before['protected'].items())
    assert containers()==before['containers']
    (base.OUT/'host-after.json').write_text(json.dumps(dict(
        preserved_files=len(before['protected']),unchanged_containers=len(before['containers']),
        free_bytes=shutil.disk_usage(JOB).free,synthetic_resources_removed=True,
        finished_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())),indent=2))
    print('PASS125 test DB/keys removed; prior artifacts and unrelated containers unchanged',flush=True)


if __name__=='__main__':
    base.guard()
    action=sys.argv[1]
    if action=='prepare':prepare()
    elif action=='finish-prepare':finish_prepare()
    elif action=='setup':setup()
    elif action=='reboot':reboot()
    elif action=='cleanup':cleanup()
    else:suite(action)
