"""Prepare a disposable stats-repair job. No production connection or deployment."""
import hashlib
import json
import pathlib
import shutil
import tarfile

JOB = pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111repair113')
PRIOR = JOB.parent / 'gps-provision22-20261111query112'

assert JOB.resolve() == JOB and not (JOB / 'src').exists()
with tarfile.open(JOB / 'source.tar') as archive:
    for item in archive.getmembers():
        assert item.isfile() and item.name.startswith(('gps-tracker-api/', 'ops/'))
        assert '..' not in pathlib.PurePosixPath(item.name).parts
    archive.extractall(JOB / 'src', filter='data')
manifest = json.loads((JOB / 'input-manifest.json').read_text())
assert all(hashlib.sha256((JOB / 'src' / p).read_bytes()).hexdigest() == h
           for p, h in manifest['files'].items())
(JOB / 'out').mkdir()
shutil.copy2(PRIOR / 'out/gps-tracker-api', JOB / 'out/gps-tracker-api')
shutil.copy2(PRIOR / 'out/gps-tracker-api', JOB / 'out/gps-tracker-api.baseline112')
script = (JOB / 'src/ops/dev_provision22d.sh').read_text().replace('20261108d', '20261111repair113')
script = script.replace('provision22d-20261108-dev', 'stats-repair113-20261111-dev')
script = script.replace('--cpus=12', '--cpus=6').replace('CARGO_BUILD_JOBS=12', 'CARGO_BUILD_JOBS=6')
script = script.replace('-e CARGO_BUILD_JOBS=6', '-e CARGO_BUILD_JOBS=6 -e CARGO_INCREMENTAL=0')
script = script.replace('-e APP_ENV=test -e BIND_ADDR=', '-e GPS_STATS_POLL_SECONDS=5 -e APP_ENV=test -e BIND_ADDR=')
(JOB / 'dev22.sh').write_text(script)
print('Prepared repair113: schema112; prior candidate preserved; production untouched')
