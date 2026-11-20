"""Create a new isolated page-query job; retain previous candidates and evidence."""
import hashlib
import json
import pathlib
import shutil
import tarfile

ROOT = pathlib.Path('/home/etcom-hub/build')
JOB = ROOT / 'gps-provision22-20261111query111'
PRIOR = ROOT / 'gps-provision22-20261111query110'


def main():
    assert JOB.resolve() == JOB and not (JOB / 'src').exists()
    with tarfile.open(JOB / 'source.tar') as tar:
        for item in tar.getmembers():
            assert item.isfile() and item.name.startswith(('gps-tracker-api/', 'ops/'))
            assert '..' not in pathlib.PurePosixPath(item.name).parts
        tar.extractall(JOB / 'src', filter='data')
    manifest = json.loads((JOB / 'input-manifest.json').read_text())
    assert all(hashlib.sha256((JOB / 'src' / p).read_bytes()).hexdigest() == h
               for p, h in manifest['files'].items())
    (JOB / 'out').mkdir()
    shutil.copy2(JOB / 'input-manifest.json', JOB / 'src/input-manifest.json')
    shutil.copy2(PRIOR / 'out/gps-tracker-api', JOB / 'out/gps-tracker-api.baseline110')
    shutil.copy2(PRIOR / 'out/gps-tracker-api', JOB / 'out/gps-tracker-api')
    for name in ('benchmark_location111.py', 'load_location111.py'):
        shutil.copy2(JOB / 'src/ops' / name, JOB / name)
    script = (JOB / 'src/ops/dev_provision22d.sh').read_text().replace('20261108d', '20261111query111')
    script = script.replace('provision22d-20261108-dev', 'query111-20261111-dev')
    script = script.replace('--cpus=12', '--cpus=6').replace('CARGO_BUILD_JOBS=12', 'CARGO_BUILD_JOBS=6')
    script = script.replace('-e CARGO_BUILD_JOBS=6', '-e CARGO_BUILD_JOBS=6 -e CARGO_INCREMENTAL=0')
    (JOB / 'dev22.sh').write_text(script)
    print('PREPARED: no production connection; prior110 preserved')


if __name__ == '__main__':
    main()
