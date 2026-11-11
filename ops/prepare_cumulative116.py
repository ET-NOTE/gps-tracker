"""Prepare round116's fixed, isolated 99->112 rehearsal with the round115 API/web.

This is not a production deployer. Inputs are pinned artifacts on the build host.
It never accepts an operational DSN, address, credentials or mutable source path.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile

ROOT = Path('/home/etcom-hub/build')
JOB = ROOT / 'gps-provision22-20261111cumulative116'
OLD = ROOT / 'gps-provision22-20261111cumulative112'
LATEST = ROOT / 'gps-provision22-20261111query115'
API_SHA = 'a433b9a114131e235068cc0359b8535aaf9529d396b47785c8eb6c4c6ca17d10'
OVERLAY_SHA = 'bc9edcf72f961a20f4053074b3f8b69cc9421766bda4ba94963abec573522a7e'
BASE_SHA = '8b4d5b3884a6bf522738a5c77c75be965e78159eab1e7d15a303d7851eda7ff6'
TAG = '20261111cumulative116'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()


def prepare():
    assert not JOB.exists()
    assert sha(OLD / 'candidate-cumulative112-20261111-r1.tar.gz') == BASE_SHA
    assert sha(LATEST / 'candidate-query115-20261111-r1.tar.gz') == OVERLAY_SHA
    assert sha(LATEST / 'out/gps-tracker-api') == API_SHA
    (JOB / 'out').mkdir(parents=True)
    with tarfile.open(ROOT / 'cumulative116-source.tar') as tar:
        tar.extractall(JOB / 'src', filter='data')
    inputs = json.loads((JOB / 'src/input-manifest.json').read_text())
    assert all(sha(JOB / 'src' / p) == h for p, h in inputs['files'].items())
    # Reuse the verified immutable binary only if every compilation input matches.
    checked = 0
    for p in (JOB / 'src/gps-tracker-api').rglob('*'):
        if p.is_file():
            prior = LATEST / 'src' / p.relative_to(JOB / 'src')
            assert prior.is_file() and p.read_bytes().replace(b'\r\n', b'\n') == prior.read_bytes().replace(b'\r\n', b'\n'), str(p)
            checked += 1
    for name in ('fixtures', 'python-deps'):
        (JOB / name).symlink_to((OLD / name).resolve(), target_is_directory=True)
    for name in ('gps-tracker-api.baseline99', 'gps-tracker-api.baseline108', 'gps-pdf-render'):
        shutil.copy2(OLD / 'out' / name, JOB / 'out' / name)
    shutil.copy2(LATEST / 'out/gps-tracker-api', JOB / 'out/gps-tracker-api')
    shutil.copy2(OLD / 'crypto20b-fields.json', JOB / 'crypto20b-fields.json')
    for label in ('root', 'subpath'):
        shutil.copytree(LATEST / 'out' / ('web-' + label), JOB / 'out' / ('web-' + label))
    dev = (JOB / 'src/ops/dev_provision22d.sh').read_text().replace('20261108d', TAG)
    dev = dev.replace('--cpus=12', '--cpus=6').replace('CARGO_BUILD_JOBS=12', 'CARGO_BUILD_JOBS=6')
    dev = dev.replace('-e CARGO_BUILD_JOBS=6', '-e CARGO_BUILD_JOBS=6 -e CARGO_INCREMENTAL=0')
    (JOB / 'dev22.sh').write_text(dev)
    for name in ('rehearse_cumulative112.py', 'check_cumulative112.py', 'test_transition_file_owner.py'):
        code = (OLD / name).read_text().replace('20261111cumulative112', TAG)
        for before, after in [('cumulative112', 'cumulative116'), ('restore112', 'restore116'),
                              ('regressions112', 'regressions116'), ('file-owner112', 'file-owner116'),
                              ('mapping-history112', 'mapping-history116')]:
            code = code.replace(before, after)
        if name.startswith('rehearse_'):
            import re
            code = re.sub(r"API_SHA = '[a-f0-9]{64}'", 'API_SHA = ' + repr(API_SHA), code)
        target = name.replace('cumulative112', 'cumulative116')
        compile(code, target, 'exec')
        (JOB / target).write_text(code)
    extra = (JOB / 'src/ops/run_query112_regressions.py').read_text()
    extra = extra.replace('20261111cumulative112', TAG).replace('cumulative112.json', 'cumulative116.json')
    extra = extra.replace('regressions112.json', 'regressions116.json').replace('additional112-tests.json', 'additional116-tests.json')
    (JOB / 'run_regressions116.py').write_text(extra)
    for name in ('rehearse_release116.py',):
        if (JOB / 'src/ops' / name).exists():
            shutil.copy2(JOB / 'src/ops' / name, JOB / name)
    report = dict(production_modified=False, source_commit=inputs['commit'], source_files=len(inputs['files']),
                  api_compilation_inputs_matched=checked, api_sha256=API_SHA,
                  base_archive_sha256=BASE_SHA, overlay_archive_sha256=OVERLAY_SHA,
                  candidate_schema=112, activation_ready=False,
                  generated_harnesses={p.name: sha(p) for p in JOB.glob('*.py')})
    (JOB / 'out/preparation116.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)


def cleanup():
    import prepare_cumulative108 as prior
    prior.JOB = JOB
    prior.NET = 'gps-provision22-test-' + TAG
    prior.NAMES = ['gps-provision22-api-' + TAG, 'gps-provision22-db-' + TAG]
    prior.cleanup()
    (JOB / 'out/cleanup108.json').rename(JOB / 'out/cleanup116.json')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cleanup', action='store_true')
    args = parser.parse_args()
    cleanup() if args.cleanup else prepare()
