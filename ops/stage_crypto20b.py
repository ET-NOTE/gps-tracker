"""Assemble verified 20B candidates on the isolated build host, never deploy.

Run after test evidence exists. Includes no .env, DSN, keyring, fixture DB or uploads.
The web source manifest is compared with the current candidate source first.
"""
import argparse, hashlib, json, pathlib, shutil, subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stage(job, commit):
    job = pathlib.Path(job).resolve()
    if not str(job).startswith('/home/etcom-hub/build/gps-crypto20b-'):
        raise ValueError('isolated build job required')
    if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
        raise ValueError('full source commit required')
    out = job / 'out'
    results = {n: json.loads((out / n).read_text()) for n in
               ('20b-conversion.json', 'business-regressions.json', 'recovery.json', 'upgrade.json')}
    binary_sha = sha(out / 'gps-tracker-api')
    if not all(results[n]['api_sha256'] == binary_sha for n in ('20b-conversion.json', 'recovery.json')):
        raise ValueError('API changed after verification')
    if results['upgrade.json']['candidate_sha256'] != binary_sha:
        raise ValueError('upgrade candidate differs')
    business = results['business-regressions.json']
    if len(business) != 8 or any(r['exit'] for r in business):
        raise ValueError('all eight regression suites required')
    web_job = job.parent / 'gps-admin19-20261107'
    manifest = json.loads((web_job / 'source-manifest.json').read_text())
    web_sources = {p: h for p, h in manifest.items() if p.startswith('gps-tracker-web/')}
    if not web_sources:
        raise ValueError('missing web source manifest')
    for p, expected in web_sources.items():
        current = job / 'src' / p
        if not current.is_file() or sha(current) != expected:
            raise ValueError('web source differs: ' + p)
    dest = job / 'candidate-crypto20b-20261107-r1'
    dest.mkdir()  # Never overwrite an already staged release.
    shutil.copy2(out / 'gps-tracker-api', dest / 'gps-tracker-api')
    shutil.copytree(web_job / 'src/gps-tracker-web/dist', dest / 'web')
    (dest / 'ops').mkdir()
    names = ('crypto20b_transition.py', 'crypto20b_preflight.py', 'location_storage.py',
             'privacy_worker_db.py', 'privacy_account_closure.py', 'privacy_file_cleanup.py',
             'privacy_scope_inventory.py', 'admin_db_roles.py', 'admin_security_bootstrap.py',
             'crypto20b-fields.json')
    for name in names:
        shutil.copy2(job / name, dest / 'ops' / name)
    (dest / 'migrations').mkdir()
    for p in (job / 'src/gps-tracker-api/migrations').glob('01*.sql'):
        if 100 <= int(p.name[:4]) <= 104:
            shutil.copy2(p, dest / 'migrations' / p.name)
    (dest / 'worker-requirements.txt').write_text('psycopg[binary]==3.2.10\n')
    report = {'source_commit': commit, 'candidate_schema': 104, 'production_schema': 99,
              'production_applied': False, 'activation_ready': False,
              'api_sha256': binary_sha, 'verified_web_source_files': len(web_sources),
              'web_source_commit': 'a74bcfa44da8d3d493a3f85ff642c2d535017f29',
              'excluded': ['credentials', 'encryption keys', 'uploads', 'database snapshots', 'PDF service replacement'],
              'activation_gates': ['private production key custody and restore access',
                                   'disable database parameter logging before keys are loaded',
                                   'stop all GPS API and cleanup workers; preserve other projects',
                                   'protected backup plus current capacity and maintenance-window check',
                                   'schema-owner/runtime separation and worker dependency installation',
                                   'offline fence/convert/full validation/resume; no plaintext rollback'],
              'files': {str(p.relative_to(dest)): sha(p) for p in sorted(dest.rglob('*')) if p.is_file()}}
    (dest / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
    archive = job / (dest.name + '.tar.gz')
    subprocess.run(['tar', '-czf', str(archive), '-C', str(dest.parent), dest.name], check=True)
    summary = {**{k: v for k, v in report.items() if k != 'files'}, 'artifact': str(archive),
               'artifact_sha256': sha(archive), 'file_count': len(report['files'])}
    (out / 'candidate-manifest.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    stage(args.job, args.commit)
