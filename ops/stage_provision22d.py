"""Package a verified round 22D candidate on the build host. Never deploy or enable erasure."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_sha(path):
    data = path.read_bytes()
    # Match Git text normalization; deployed migrations are compared byte-for-byte.
    if 'migrations' not in path.parts and path.suffix.lower() in (
        '.rs', '.toml', '.lock', '.sql', '.json', '.js', '.mjs', '.jsx', '.ts',
        '.tsx', '.css', '.html', '.py', '.sh', '.example', '.md', '.txt',
    ):
        data = data.replace(b'\r\n', b'\n')
    return hashlib.sha256(data).hexdigest()


def stage(job, commit):
    job = pathlib.Path(job).resolve()
    if not str(job).startswith('/home/etcom-hub/build/gps-provision22-'):
        raise ValueError('isolated build job required')
    if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
        raise ValueError('full source commit required')
    out = job / 'out'
    binary_sha = sha(out / 'gps-tracker-api')
    encrypted = json.loads((out / 'round22d-encrypted.json').read_text())
    plain = json.loads((out / 'round22d-integration.json').read_text())
    upgrade = json.loads((out / 'upgrade22d.json').read_text())
    regressions = json.loads((out / 'business-regressions.json').read_text())
    if any(r['api_sha256'] != binary_sha for r in (encrypted, plain, upgrade)):
        raise ValueError('API differs from verified candidate')
    if encrypted['schema'] != 108 or upgrade['schema_path'] != [107, 108]:
        raise ValueError('schema rehearsal missing')
    if len(regressions) != 8 or any(r['exit'] for r in regressions):
        raise ValueError('all eight business suites required')
    load = json.loads((out / 'queue-load.json').read_text())
    health = json.loads((out / 'queue-health-verification.json').read_text())
    if any(r['api_sha256'] != binary_sha for r in (load, health)):
        raise ValueError('queue checks differ from candidate')
    if load['notice_count'] != 1200 or load['unique_settlements'] != 1200 or load['api_health_failures'] != 0:
        raise ValueError('queue load incomplete')
    if not health['no_external_send'] or len(encrypted['passed']) != 6 or len(plain['passed']) != 6:
        raise ValueError('alarm checks missing')
    if 'external_company_boundary22d ... ok' not in (out / 'boundary22d.log').read_text():
        raise ValueError('external company boundary test missing')
    sources = json.loads((job / 'source-manifest.json').read_text())
    if not sources or any(source_sha(job / 'src' / p) != h for p, h in sources.items()):
        raise ValueError('candidate source differs from reviewed source manifest')
    dest = job / 'candidate-provision22d-20261108-r1'
    dest.mkdir()  # Refuse to overwrite a candidate.
    shutil.copy2(out / 'gps-tracker-api', dest / 'gps-tracker-api')
    shutil.copytree(job / 'src/gps-tracker-web/dist-root', dest / 'web')
    (dest / 'ops').mkdir()
    for name in ('privacy_retention.py', 'privacy_restore_checkpoint.py', 'privacy_subject_checkpoint.py', 'privacy_worker_db.py',
                 'privacy_account_closure.py', 'privacy_file_cleanup.py', 'privacy_scope_inventory.py',
                 'location_storage.py', 'admin_db_roles.py', 'admin_security_bootstrap.py',
                 'crypto20b_transition.py', 'crypto20b_preflight.py',
                 'notice_queue_probe.py', 'gps_watch.py', 'gps-watch.example.ini',
                 'gps-privacy-retention.service.example', 'gps-privacy-retention.timer.example'):
        shutil.copy2(job / 'src/ops' / name, dest / 'ops' / name)
    shutil.copy2(job / 'src/gps-tracker-api/sql/subject_queue_health.sql', dest / 'ops/subject_queue_health.sql')
    shutil.copy2(job / 'crypto20b-fields.json', dest / 'ops/crypto20b-fields.json')
    (dest / 'migrations').mkdir()
    for path in sorted((job / 'src/gps-tracker-api/migrations').glob('01*.sql')):
        if 100 <= int(path.name[:4]) <= 108:
            shutil.copy2(path, dest / 'migrations' / path.name)
    (dest / 'worker-requirements.txt').write_text('psycopg[binary]==3.2.10\n')
    report = {
        'source_commit': commit, 'candidate_schema': 108, 'production_schema': 99,
        'production_applied': False, 'activation_ready': False,
        'api_sha256': binary_sha, 'verified_source_files': len(sources),
        'source_manifest_sha256': sha(job / 'source-manifest.json'),
        'excluded': ['credentials', 'keyring', 'uploads', 'database snapshots', 'PDF service replacement'],
        'activation_gates': [
            'real FCM handset arrival/entry; external company sharing requires separately reviewed recipient and consent policy',
            'real subject declaration and reviewed provision/notice policy',
            'cumulative 99 to 108 production-sized protected rehearsal',
            'reviewed policy and explicit subject consent; no inferred historic consent',
            'runtime and maintenance role separation; dedicated worker and key custody',
            'latest external checkpoint custody and offline restore procedure',
            'company/unattributed records, files, audit and backups remain separate review scopes',
            'dedicated SELECT-only forced-command monitoring account/key and live alarm acceptance; real-device buffered pause/resume',
            '20B encryption/parameter-log/backup/rollback prerequisites still apply',
        ],
        'files': {str(p.relative_to(dest)): sha(p) for p in sorted(dest.rglob('*')) if p.is_file()},
    }
    (dest / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
    archive = job / (dest.name + '.tar.gz')
    subprocess.run(['tar', '-czf', str(archive), '-C', str(job), dest.name], check=True)
    summary = {k: v for k, v in report.items() if k != 'files'}
    summary.update(artifact=str(archive), artifact_sha256=sha(archive), file_count=len(report['files']))
    (out / 'candidate-manifest.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    stage(args.job, args.commit)
