"""Prepare/build/rehearse only the fixed isolated 109 job; never deploy.

Reuse the recorded 108 harness with explicit version/path/hash adaptations,
not a weakened acceptance budget. The generated scripts remain in evidence.
"""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess

ROOT = pathlib.Path('/home/etcom-hub/build')
JOB = ROOT / 'gps-provision22-20261108cumulative109'
PRIOR = ROOT / 'gps-provision22-20261108cumulative'
TAG = '20261108cumulative109'


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def prepare(source):
    assert source.is_dir() and not JOB.exists() and ROOT.is_dir()
    assert sha(PRIOR/'out/gps-tracker-api') == '36d89e4f0d0b0c6a1bcf73954fe019a2e29f3a761001a339f7cfc86b62b91cd0'
    shutil.copytree(PRIOR/'src', JOB/'src')
    # Reviewed Git export only. No environment files or runtime credentials.
    manifest=json.loads((source/'input-manifest.json').read_text())
    for name, digest in manifest['files'].items():
        path=pathlib.PurePosixPath(name)
        assert path.parts[0] in ('gps-tracker-api','ops') and '..' not in path.parts
        assert sha(source/name)==digest
        dest=JOB/'src'/name;dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(source/name,dest)
    (JOB/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (JOB/'out').mkdir()
    for name in ('gps-tracker-api.baseline99','gps-pdf-render'):
        shutil.copy2(PRIOR/'out'/name,JOB/'out'/name)
    shutil.copy2(PRIOR/'out/gps-tracker-api',JOB/'out/gps-tracker-api.baseline108')
    (JOB/'out/gps-tracker-api.baseline99').chmod(0o755)
    for name in ('fixtures','python-deps'):
        (JOB/name).symlink_to((PRIOR/name).resolve(),target_is_directory=True)
    shutil.copy2(PRIOR/'crypto20b-fields.json',JOB/'crypto20b-fields.json')
    dev=(JOB/'src/ops/dev_provision22d.sh').read_text().replace('20261108d',TAG)
    dev=dev.replace('GPS_RELEASE=provision22d-20261108-dev','GPS_RELEASE=cumulative109-20261108-dev')
    (JOB/'dev22.sh').write_text(dev)
    for name in ('prepare_cumulative109.py','test_subject_ancestry109.py','benchmark_subject_queries109.py',
                 'run_extra_cumulative109.py','stage_cumulative109.py'):
        shutil.copy2(JOB/'src/ops'/name,JOB/name)
    print(json.dumps({'prepared':str(JOB),'source_commit':manifest['commit'],'production_modified':False}))


def generate():
    assert JOB.is_dir() and (JOB/'out/gps-tracker-api').is_file()
    for name in ('rehearse_cumulative108.py','check_cumulative108.py','test_transition_file_owner.py'):
        code=(JOB/'src/ops'/name).read_text()
        code=code.replace('20261108cumulative',TAG)
        code=code.replace('cumulative108','cumulative109').replace('restore108','restore109')
        code=code.replace('to108','to109').replace('regressions108','regressions109')
        code=code.replace('file-owner108','file-owner109').replace('mapping-history108','mapping-history109')
        code=code.replace('all nine migration','all ten migration')
        code=re.sub(r'\b108\b','109',code)
        code=code.replace('range(100, 109)','range(100, 110)')
        if name=='rehearse_cumulative108.py':
            code=re.sub(r"API_SHA = '[a-f0-9]{64}'",'API_SHA = '+repr(sha(JOB/'out/gps-tracker-api')),code)
        target=name.replace('cumulative108','cumulative109')
        compile(code,target,'exec')
        (JOB/target).write_text(code)
    report={p.name:sha(p) for p in (JOB/'rehearse_cumulative109.py',JOB/'check_cumulative109.py',JOB/'test_transition_file_owner.py')}
    (JOB/'out/generated-harnesses.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))


def cleanup():
    # Existing cleanup checks exact paths, network membership and private paths.
    import prepare_cumulative108 as previous
    previous.JOB=JOB
    previous.NET='gps-provision22-test-'+TAG
    previous.NAMES=['gps-provision22-api-'+TAG,'gps-provision22-db-'+TAG]
    previous.cleanup()
    (JOB/'out/cleanup108.json').rename(JOB/'out/cleanup109.json')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['prepare','generate','cleanup'])
    p.add_argument('--source',type=pathlib.Path)
    a=p.parse_args()
    if a.action=='prepare':
        if not a.source:p.error('--source required')
        prepare(a.source)
    elif a.action=='generate':generate()
    else:cleanup()
