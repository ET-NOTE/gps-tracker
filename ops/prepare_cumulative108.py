"""Prepare (or clean up) only the named disposable cumulative108 build-host job.

No production connection. Requires the already verified 22D artifacts locally.
Cleanup removes only this job's test containers/network/credentials/fixture data;
source, binaries and verification reports are retained.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path('/home/etcom-hub/build')
JOB = ROOT / 'gps-provision22-20261108cumulative'
PRIOR = ROOT / 'gps-provision22-20261108d'
NET = 'gps-provision22-test-20261108cumulative'
NAMES = ['gps-provision22-api-20261108cumulative', 'gps-provision22-db-20261108cumulative']


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def prepare(source):
    assert ROOT.is_dir() and source.is_dir() and not JOB.exists()
    assert digest(PRIOR / 'out/gps-tracker-api') == '36d89e4f0d0b0c6a1bcf73954fe019a2e29f3a761001a339f7cfc86b62b91cd0'
    baseline = ROOT / 'gps-ledger18b-20261107/out/gps-tracker-api.baseline99'
    assert digest(baseline) == 'fa1e51e3d39473ca2852ac6b2899790547fa6667bb7337c646d29258a3e1c0fe'
    JOB.mkdir()
    shutil.copytree(PRIOR / 'src', JOB / 'src')
    (JOB / 'out').mkdir()
    for name in ('gps-tracker-api', 'gps-pdf-render'):
        shutil.copy2(PRIOR / 'out' / name, JOB / 'out' / name)
    shutil.copy2(baseline, JOB / 'out/gps-tracker-api.baseline99')
    (JOB / 'out/gps-tracker-api.baseline99').chmod(0o755)
    for name in ('python-deps', 'fixtures'):
        (JOB / name).symlink_to((PRIOR / name).resolve(), target_is_directory=True)
    shutil.copy2(PRIOR / 'crypto20b-fields.json', JOB / 'crypto20b-fields.json')
    dev = (PRIOR / 'src/ops/dev_provision22d.sh').read_text().replace('20261108d', '20261108cumulative')
    (JOB / 'dev22.sh').write_bytes(dev.encode())
    for name in ('rehearse_cumulative108.py', 'check_cumulative108.py', 'test_transition_file_owner.py'):
        shutil.copy2(source / name, JOB / name)
    for name in ('crypto20b_transition.py', 'crypto20b_preflight.py'):
        shutil.copy2(source / name, JOB / 'src/ops' / name)
    print(json.dumps({'prepared': str(JOB), 'production_modified': False}))


def cleanup():
    assert JOB.is_dir() and not JOB.is_symlink() and JOB.resolve().parent == ROOT
    removed = []
    for name in NAMES:
        p = subprocess.run(['docker', 'inspect', name], capture_output=True)
        if p.returncode == 0:
            info = json.loads(p.stdout)[0]
            assert NET in info['NetworkSettings']['Networks']
            subprocess.run(['docker', 'rm', '-f', name], check=True, stdout=subprocess.DEVNULL)
            removed.append(name)
    p = subprocess.run(['docker', 'network', 'inspect', NET], capture_output=True)
    if p.returncode == 0:
        network = json.loads(p.stdout)[0]
        assert network['Internal'] and not network['Containers']
        subprocess.run(['docker', 'network', 'rm', NET], check=True, stdout=subprocess.DEVNULL)
        removed.append(NET)
    private = ['test-storage', 'restored-storage', 'owner-fixture', 'test-keys.json',
               'test-runtime.json', 'test-latest-checkpoint.json', 'regression.env']
    for name in private:
        p = JOB / name
        assert not p.is_symlink() and p.resolve().parent == JOB
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink(missing_ok=True)
    import datetime
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'removed_resources': removed, 'private_fixture_paths_absent': all(not (JOB / n).exists() for n in private),
              'other_projects_modified': False, 'production_modified': False}
    (JOB / 'out/cleanup108.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['prepare', 'cleanup'])
    p.add_argument('--ops-source', type=pathlib.Path)
    a = p.parse_args()
    if a.action == 'prepare':
        if not a.ops_source:
            p.error('--ops-source required')
        prepare(a.ops_source)
    else:
        cleanup()
