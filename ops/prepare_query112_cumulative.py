"""Prepare the fixed cumulative112 rehearsal from the reviewed query112 build.

No production connections. Generated adaptations retain the existing acceptance
checks, including schema checksums, non-superuser migration and consent recovery.
"""
import hashlib
import argparse
import json
import pathlib
import re
import shutil

ROOT = pathlib.Path('/home/etcom-hub/build')
BUILD = ROOT / 'gps-provision22-20261111query112'
JOB = ROOT / 'gps-provision22-20261111cumulative112'
PRIOR = ROOT / 'gps-provision22-20261108cumulative109'
TAG = '20261111cumulative112'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()


def prepare():
    assert not JOB.exists()
    (JOB / 'out').mkdir(parents=True)
    # The file-owner regression mounts JOB as a whole. A sibling source symlink
    # is outside that container mount, so keep a self-contained source copy.
    shutil.copytree(BUILD / 'src', JOB / 'src')
    for name in ('fixtures', 'python-deps'):
        (JOB / name).symlink_to((PRIOR / name).resolve(), target_is_directory=True)
    for name in ('gps-tracker-api.baseline99', 'gps-tracker-api.baseline108', 'gps-pdf-render'):
        shutil.copy2(PRIOR / 'out' / name, JOB / 'out' / name)
    # The performance harness switches its active file to111 for comparison.
    # Always consume the immutable final112 artifact, never that moving path.
    shutil.copy2(BUILD / 'out/gps-tracker-api.final112', JOB / 'out/gps-tracker-api')
    shutil.copy2(PRIOR / 'crypto20b-fields.json', JOB / 'crypto20b-fields.json')
    dev = (JOB / 'src/ops/dev_provision22d.sh').read_text().replace('20261108d', TAG)
    dev = dev.replace('GPS_RELEASE=provision22d-20261108-dev', 'GPS_RELEASE=query112-20261111-dev')
    dev = dev.replace('--cpus=12', '--cpus=6').replace('CARGO_BUILD_JOBS=12', 'CARGO_BUILD_JOBS=6')
    dev = dev.replace('-e CARGO_BUILD_JOBS=6', '-e CARGO_BUILD_JOBS=6 -e CARGO_INCREMENTAL=0')
    (JOB / 'dev22.sh').write_text(dev)
    for name in ('rehearse_cumulative108.py', 'check_cumulative108.py', 'test_transition_file_owner.py'):
        code = (JOB / 'src/ops' / name).read_text().replace('20261108cumulative', TAG)
        for before, after in [('cumulative108', 'cumulative112'), ('restore108', 'restore112'), ('to108', 'to112'),
                              ('regressions108', 'regressions112'), ('file-owner108', 'file-owner112'),
                              ('mapping-history108', 'mapping-history112')]:
            code = code.replace(before, after)
        code = code.replace('all nine migration', 'all thirteen migration')
        code = re.sub(r'\b108\b', '112', code).replace('range(100, 109)', 'range(100, 113)')
        if name == 'rehearse_cumulative108.py':
            code = re.sub(r"API_SHA = '[a-f0-9]{64}'", 'API_SHA = ' + repr(sha(JOB / 'out/gps-tracker-api')), code)
        target = name.replace('cumulative108', 'cumulative112')
        compile(code, target, 'exec')
        (JOB / target).write_text(code)
    # Re-run the 109 consent oracle with the same populated108 baseline and the
    # final 112 binary. Only expected endpoint version/path changes; oracle stays.
    code = (JOB / 'src/ops/test_subject_ancestry109.py').read_text().replace('20261108cumulative109', TAG)
    code = code.replace("one('SELECT max(version) FROM _sqlx_migrations')==109", "one('SELECT max(version) FROM _sqlx_migrations')==112")
    code = code.replace('[108,109]', '[108,112]').replace('populated108->109:', 'populated108->112:')
    (JOB / 'test_subject_ancestry109.py').write_text(code)
    code = (JOB / 'src/ops/benchmark_subject_queries109.py').read_text().replace('20261108cumulative109', TAG)
    code = code.replace("'schema':109", "'schema':112")
    (JOB / 'benchmark_subject_queries109.py').write_text(code)
    scripts = {p.name: sha(p) for p in JOB.glob('*.py')}
    (JOB / 'out/generated-harnesses.json').write_text(json.dumps(scripts, indent=2) + '\n')
    print('PREPARED', JOB)


def cleanup():
    # Reuse the reviewed cleanup path guards; never traverse the source/dependency
    # symlinks or remove previous rounds' artifacts and shared build caches.
    import prepare_cumulative108 as previous
    previous.JOB = JOB
    previous.NET = 'gps-provision22-test-' + TAG
    previous.NAMES = ['gps-provision22-api-' + TAG, 'gps-provision22-db-' + TAG]
    previous.cleanup()
    (JOB / 'out/cleanup108.json').rename(JOB / 'out/cleanup112.json')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cleanup', action='store_true')
    args = parser.parse_args()
    cleanup() if args.cleanup else prepare()
