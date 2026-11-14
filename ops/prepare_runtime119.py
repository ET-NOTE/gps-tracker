"""Prepare fixed cumulative119 and benchmark119 jobs from reviewed artifacts.

No production credentials, URLs or state are accepted. All mutations live on
the build host in the two newly created jobs and labelled private containers.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path('/home/etcom-hub/build')
KIT = ROOT/'gps-runtime119-20261112'
OLD = ROOT/'gps-provision22-20261111cumulative116'
PREVIOUS = ROOT/'gps-provision22-20261111runtime117'
JOB = ROOT/'gps-provision22-20261112cumulative119'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()


def prepare():
    assert subprocess.check_output(['hostname'], text=True).strip() == 'etcom-hub'
    assert sha(OLD/'candidate-cumulative116-20261111-r1.tar.gz') == 'b0ad2eb25f993df683ccbcda76f0d0533e469132eca22798c23bc766a14c128f'
    assert sha(PREVIOUS/'out/gps-tracker-api') == 'f1e0d29ed9773f1279798021be511450003bc2239a73bc10c4204a853055ac3d'
    API_SHA = sha(KIT/'out/gps-tracker-api')
    # SQLx embeds byte hashes. Normalizing only for a source comparison is not
    # enough: 117's working-tree CRLF bytes fail against the LF116 database.
    for old in (OLD/'src/gps-tracker-api/migrations').glob('*.sql'):
        assert old.read_bytes() == (KIT/'src/gps-tracker-api/migrations'/old.name).read_bytes(), old.name
    JOB.mkdir(); (JOB/'out').mkdir(); (JOB/'bin').mkdir()
    shutil.copytree(OLD/'src', JOB/'src')
    shutil.copytree(KIT/'src/gps-tracker-api', JOB/'src/gps-tracker-api', dirs_exist_ok=True)
    shutil.copytree(KIT/'src/ops', JOB/'src/ops', dirs_exist_ok=True)
    for fixture in (JOB/'src/ops').glob('test_*.py'):
        fixture.write_text(fixture.read_text().replace('/proc/1/exe','/api'))
    shutil.copytree(OLD/'fixtures', JOB/'fixtures')
    for fixture in (JOB/'fixtures').glob('*.py'):
        fixture.write_text(fixture.read_text().replace('/proc/1/exe','/api'))
    shutil.copytree(OLD/'python-deps', JOB/'python-deps')
    shutil.copy2(KIT/'ops/runtime119_docker.py', JOB/'bin/docker'); (JOB/'bin/docker').chmod(0o755)
    for name in ('gps-tracker-api.baseline99', 'gps-tracker-api.baseline108'):
        shutil.copy2(OLD/'out'/name, JOB/'out'/name)
    shutil.copy2(KIT/'out/gps-tracker-api', JOB/'out/gps-tracker-api')
    shutil.copy2(KIT/'out/gps-pdf-render', JOB/'out/gps-pdf-render')
    shutil.copy2(OLD/'crypto20b-fields.json', JOB/'crypto20b-fields.json')
    for label in ('root', 'subpath'): shutil.copytree(OLD/'out'/('web-'+label), JOB/'out'/('web-'+label))
    for name in ('rehearse_cumulative116.py','check_cumulative116.py','rehearse_release116.py','test_transition_file_owner.py','dev22.sh'):
        code = (OLD/name).read_text().replace('20261111cumulative116','20261112cumulative119')
        code = code.replace('cumulative116','cumulative119').replace('restore116','restore119').replace('regressions116','regressions119')
        code = code.replace('a433b9a114131e235068cc0359b8535aaf9529d396b47785c8eb6c4c6ca17d10', API_SHA)
        # Non-dumpable processes correctly deny /proc/exe inspection without
        # ptrace. Check the immutable bind-mounted executable, not ptrace grants.
        code = code.replace('/proc/1/exe', '/api')
        code = code.replace('/home/etcom-hub/build/gps-location-erasure-20261105/venv/bin/python', '/usr/bin/python3')
        # Never import the old external Python ABI in the new controller image.
        code = code.replace('PYTHONPATH="$job/python-deps:$job/src/ops"','PYTHONPATH="$job/src/ops"')
        code = code.replace("str((HERE / 'python-deps').resolve()) + ':/deps:ro'", "str(HERE / 'src/ops') + ':/deps:ro'")
        (JOB/name.replace('116','119')).write_text(code)
    # Copy compatible112 recovery target without a broad build-root mount.
    shutil.copytree(ROOT/'gps-provision22-20261111cumulative112/candidate-cumulative112-20261111-r1', JOB/'compatible112')
    f = JOB/'rehearse_release119.py'
    f.write_text(f.read_text().replace("JOB.parent / 'gps-provision22-20261111cumulative112/candidate-cumulative112-20261111-r1'", "JOB / 'compatible112'").replace(
        '    atomic_link(new)\n    verify(new)', '    install_api(new)\n    atomic_link(new)\n    verify(new)', 1))
    report = dict(production_modified=False, activation_ready=False, api_sha256=API_SHA,
                  pdf_sha256=sha(JOB/'out/gps-pdf-render'), sources={p.name:sha(p) for p in KIT.joinpath('ops').glob('*') if p.is_file()})
    (JOB/'out/preparation119.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))


def prepare_benchmark():
    target=ROOT/'gps-provision22-20261112runtime119'
    assert not target.exists()
    (target/'out').mkdir(parents=True); (target/'bin').mkdir()
    shutil.copytree(KIT/'src/ops', target/'src/ops')
    shutil.copy2(KIT/'out/gps-tracker-api', target/'out/gps-tracker-api')
    for name in ('benchmark_runtime119.py',): shutil.copy2(KIT/'ops'/name,target/name)
    shutil.copy2(KIT/'ops/runtime119_docker.py',target/'bin/docker'); (target/'bin/docker').chmod(0o755)
    adapt_benchmark(target)


def adapt_benchmark(target):
    assert target == ROOT/'gps-provision22-20261112runtime119'
    for source,new in [(PREVIOUS/'business117.py','business119.py'),(KIT/'src/ops/runtime117_faults.py','faults119.py')]:
        code=source.read_text().replace('20261111runtime117','20261112runtime119')
        code=code.replace('runtime117','runtime119').replace('import runtime119 as test','import benchmark_runtime119 as test')
        code=code.replace('import runtime119','import benchmark_runtime119 as runtime119')
        code=code.replace("assert (b.JOB/'protected.enabled').exists()", "assert b.info('container',b.DB)['HostConfig']['MemorySwap']==1500*1024**2")
        (target/new).write_text(code)


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['benchmark']: prepare_benchmark()
    elif sys.argv[1:] == ['refresh-fixtures']:
        for fixture in [*(JOB/'fixtures').glob('*.py'),*(JOB/'src/ops').glob('test_*.py')]:
            fixture.write_text(fixture.read_text().replace('/proc/1/exe','/api'))
        adapt_benchmark(ROOT/'gps-provision22-20261112runtime119')
    else: prepare()
