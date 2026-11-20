"""Package an isolated protection kit, not a deployable GPS release."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

JOB = Path('/home/etcom-hub/build/gps-runtime118-20261112')
OUT = JOB / 'out'
SOURCE_NAMES = ['runtime118_nodump.c','runtime118_guard.py','runtime118.Dockerfile',
                'rehearse_runtime118.py','observe_runtime118.py','budget_runtime118.py','stage_runtime118.py']
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    assert Path.cwd() == JOB
    result = json.loads((OUT/'rehearsal.json').read_text())
    assert result['all_passed'] and len(result['checks']) == 21 and all(x['passed'] for x in result['checks'])
    dest = JOB / 'protection-kit-runtime118-20261112-r1'
    assert not dest.exists()
    dest.mkdir()
    for name in SOURCE_NAMES:
        shutil.copy2(JOB/'src'/name, dest/name)
    subprocess.run(['docker','cp','gps-runtime118-host:/usr/local/lib/gps-nodump.so',str(dest/'gps-nodump.so')],check=True)
    assert sha(dest/'gps-nodump.so') == result['plan']['library_sha256']
    shutil.copytree(JOB/'generated', dest/'synthetic-profile')
    # Do not ship deliberately invalid test overrides or connection test credentials.
    for path in [dest/'synthetic-profile/etc/systemd/system/gps118-db.service.d/test-swap.conf',
                 dest/'synthetic-profile/usr/local/lib/gps118_connections.py']:
        if path.is_file():
            path.unlink()
    shutil.copy2(OUT/'rehearsal.json', dest/'rehearsal.json')
    manifest = {'kind': 'synthetic protection kit; NOT an installer or cumulative release',
        'production_applied': False, 'activation_ready': False, 'checks_passed': 21,
        'api_unchanged_sha256': 'f1e0d29ed9773f1279798021be511450003bc2239a73bc10c4204a853055ac3d',
        'required_cumulative_base_sha256': 'b0ad2eb25f993df683ccbcda76f0d0533e469132eca22798c23bc766a14c128f',
        'source_input_sha256': sha(JOB/'src/input-manifest.json'),
        'open_gates': ['bounded shared RAM/connection budgets','corrected production shared_buffers stress rerun',
                      'actual API/PDF/maintenance process preload integration','116 migration/restore + 117 API + protection profile combined rehearsal',
                      'production host deployment window/policy/keys/rights checkpoint and existing handoff gates'],
        'files': {str(p.relative_to(dest)):sha(p) for p in sorted(dest.rglob('*')) if p.is_file()}}
    (dest/'manifest.json').write_text(json.dumps(manifest,indent=2))
    archive=dest.with_suffix('.tar.gz')
    with tarfile.open(archive,'w:gz') as tar:
        tar.add(dest,arcname=dest.name)
    with tarfile.open(archive) as tar:
        for name, digest in manifest['files'].items():
            assert hashlib.sha256(tar.extractfile(dest.name+'/'+name).read()).hexdigest()==digest
    (OUT/'kit-manifest.json').write_text(json.dumps(manifest,indent=2))
    (OUT/'kit-archive.json').write_text(json.dumps({'path':str(archive),'sha256':sha(archive),'files':len(manifest['files']),
                                               'activation_ready':False},indent=2))
    print((OUT/'kit-archive.json').read_text())


if __name__=='__main__':
    main()
