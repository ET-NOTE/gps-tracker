"""Repackage 22D with rehearsed file-owner and legacy retention safeguards.

Build host only. No production credentials, connection, deployment or activation.
The API/web/migrations remain byte-identical to the previous verified package.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import tarfile

ROOT = pathlib.Path('/home/etcom-hub/build')
JOB = ROOT / 'gps-provision22-20261108cumulative'
PRIOR = ROOT / 'gps-provision22-20261108d'
BASE = PRIOR / 'candidate-provision22d-20261108-r1'
BASE_HASH = 'a4fc3a66b1ca0c9c410cfb811f720e74c3759a482edf8e057bd480801e58b8cc'


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def read(name):
    return json.loads((JOB / 'out' / name).read_text())


def stage(commit, helper_hash, preflight_hash):
    assert len(commit) == 40 and all(c in '0123456789abcdef' for c in commit)
    assert sha(BASE.with_suffix('.tar.gz')) == BASE_HASH
    base = json.loads((BASE / 'manifest.json').read_text())
    assert all(sha(BASE / p) == h for p, h in base['files'].items())
    main = read('cumulative108.json')
    assert main['runtime_ready_for_regressions'] and main['schema_path'] == [99, 108]
    assert main['legacy_retention']['scheduled_job_rejected']
    assert main['candidate_sha256'] == base['api_sha256']
    regression = read('regressions108.json')
    assert len(regression) == 8 and all(r['exit'] == 0 for r in regression)
    business = read('business-regressions.json')
    assert len(business) == 8 and all(r['exit'] == 0 for r in business)
    restore = read('protected-restore108.json')
    assert all(restore[k] for k in ('checkpoint_hash_checked', 'old_erased_rows_removed',
        'old_consent_not_revived', 'pause_reapplied', 'accepted_notice_not_resent',
        'sim_identity_preserved', 'old_resend_denied'))
    owner = read('file-owner108.json')
    assert owner['owner_group_preserved'] and owner['api_identity_can_read']
    load = read('mapping-history108.json')
    assert load['synthetic_rows'] == 32000 and max(load['owner_count_seconds']) < 5
    assert load['point_query_execution_ms'] < 2000
    helper = JOB / 'src/ops/crypto20b_transition.py'
    assert sha(helper) == helper_hash
    preflight = JOB / 'src/ops/crypto20b_preflight.py'
    assert sha(preflight) == preflight_hash
    dest = JOB / 'candidate-cumulative108-20261108-r1'
    shutil.copytree(BASE, dest)  # Existing candidates are never overwritten.
    shutil.copy2(helper, dest / 'ops/crypto20b_transition.py')
    shutil.copy2(preflight, dest / 'ops/crypto20b_preflight.py')
    file_hashes = {str(p.relative_to(dest)): sha(p) for p in sorted(dest.rglob('*'))
                   if p.is_file() and p.name != 'manifest.json'}
    changed = [p for p in file_hashes if base['files'].get(p) != file_hashes[p]]
    assert set(file_hashes) == set(base['files'])
    assert changed == ['ops/crypto20b_preflight.py', 'ops/crypto20b_transition.py']
    result = dict(base)
    result.update(source_commit=commit, binary_source_commit=base['source_commit'],
        base_artifact_sha256=BASE_HASH, production_applied=False, activation_ready=False,
        changed_files=changed, files=file_hashes,
        rehearsal='actual99 to108; larger synthetic row/sample counts, not a production clone',
        activation_gates=[
            'production maintenance window, live I/O/headroom and all GPS writers inventory',
            'bind logging disabled before keys; pgcrypto provisioned for restricted migration owner',
            'legacy Timescale retention jobs reviewed, paused and drained before conversion/restore',
            'separate runtime/maintenance identity, real key custody and protected backup restore',
            'latest external privacy checkpoint custody and offline replay before reopening',
            'reviewed retention/notice policy, explicit subject consent and administrator PC/IP/MFA',
            'real FCM handset arrival, notification entry and dedicated queue alarm acceptance',
            'physical TLS promotion, buffered pause/resume and 24-hour sleep acceptance',
            'legacy WAL, snapshots, backups and unclassified/company files separately governed',
        ])
    (dest / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    archive = dest.with_suffix('.tar.gz')
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(dest, arcname=dest.name)
    # Verify the packaged bytes, not just the directory that was packaged.
    with tarfile.open(archive) as tar:
        members = {m.name: m for m in tar.getmembers() if m.isfile()}
        assert len(members) == len(file_hashes) + 1
        for p, h in file_hashes.items():
            assert hashlib.sha256(tar.extractfile(members[dest.name + '/' + p]).read()).hexdigest() == h
    summary = {k: v for k, v in result.items() if k != 'files'}
    summary.update(artifact=str(archive), artifact_sha256=sha(archive), file_count=len(file_hashes))
    (JOB / 'out/candidate-manifest.json').write_text(json.dumps(summary, indent=2) + '\n')
    (JOB / 'out/package-verification.json').write_text(json.dumps({
        'archive_sha256': sha(archive), 'file_count': len(file_hashes),
        'all_archive_bytes_match': True, 'changed_from22d': changed,
        'api_web_migrations_unchanged': True, 'activation_ready': False}, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--commit', required=True)
    p.add_argument('--helper-sha256', required=True)
    p.add_argument('--preflight-sha256', required=True)
    args = p.parse_args()
    stage(args.commit, args.helper_sha256, args.preflight_sha256)
