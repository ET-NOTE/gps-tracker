"""Package a rehearsed99->112 candidate with115 API/web. Never activate production."""
import hashlib
import json
from pathlib import Path
import shutil
import tarfile

ROOT = Path('/home/etcom-hub/build')
JOB = ROOT / 'gps-provision22-20261111cumulative116'
BASE = ROOT / 'gps-provision22-20261111cumulative112/candidate-cumulative112-20261111-r1'
LATEST = ROOT / 'gps-provision22-20261111query115'
API_SHA = 'a433b9a114131e235068cc0359b8535aaf9529d396b47785c8eb6c4c6ca17d10'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
read = lambda n: json.loads((JOB / 'out' / n).read_text())


def stage():
    assert sha(BASE.with_suffix('.tar.gz')) == '8b4d5b3884a6bf522738a5c77c75be965e78159eab1e7d15a303d7851eda7ff6'
    base = json.loads((BASE / 'manifest.json').read_text())
    assert all(sha(BASE / p) == h for p, h in base['files'].items())
    source = json.loads((JOB / 'src/input-manifest.json').read_text())
    assert all(sha(JOB / 'src' / p) == h for p, h in source['files'].items())
    main = read('cumulative116.json')
    assert main['runtime_ready_for_regressions'] and main['schema_path'] == [99, 112]
    assert main['candidate_sha256'] == sha(JOB / 'out/gps-tracker-api') == API_SHA
    migrations = next(c['versions'] for c in main['checks'] if 'versions' in c)
    assert migrations == list(range(100, 113))
    for name in ('regressions116.json', 'business-regressions.json'):
        results = read(name)
        assert len(results) == 8 and all(r['exit'] == 0 for r in results)
    extra = read('additional116-tests.json')
    assert len(extra) == 4 and all(r['exit'] == 0 for r in extra)
    restore = read('protected-restore116.json')
    for key in ('checkpoint_hash_checked', 'old_erased_rows_removed', 'old_consent_not_revived',
                'pause_reapplied', 'accepted_notice_not_resent', 'sim_identity_preserved', 'old_resend_denied'):
        assert restore[key]
    owner = read('file-owner116.json')
    assert owner['owner_group_preserved'] and owner['api_identity_can_read']
    assert read('mapping109-queries.json')['all_passed']
    oracle = read('ancestry109-regression.json')
    assert oracle['schema_path'] == [108, 112] and all(c['same_effective_ids'] and c['oracle_equal'] for c in oracle['cases'])
    release = read('release116.json')
    assert len(release['checks']) == 6 and release['checks'][-1]['check'] == 'no residual location queries or idle transactions'
    stress = json.loads((LATEST / 'out/candidate-manifest.json').read_text())['stress_assessment']
    assert stress['single']['performance_gate_passed']
    assert not stress['dual']['performance_gate_passed'] and not stress['io-limited']['performance_gate_passed']
    dest = JOB / 'candidate-cumulative116-20261111-r1'
    assert not dest.exists()
    shutil.copytree(BASE, dest)
    shutil.copy2(JOB / 'out/gps-tracker-api', dest / 'gps-tracker-api')
    # Only the new candidate's copied web tree is replaced. Keep old bundles intact.
    assert (dest / 'web').resolve().parent == dest and dest.parent == JOB
    shutil.rmtree(dest / 'web')
    shutil.copytree(JOB / 'out/web-root', dest / 'web')
    for file in (dest / 'ops').iterdir():
        current = JOB / 'src/ops' / file.name
        if current.is_file():
            shutil.copy2(current, file)
    for migration in (dest / 'migrations').iterdir():
        assert sha(migration) == sha(JOB / 'src/gps-tracker-api/migrations' / migration.name)
    hashes = {str(p.relative_to(dest)): sha(p) for p in sorted(dest.rglob('*')) if p.is_file() and p.name != 'manifest.json'}
    result = dict(base)
    result.update(candidate='candidate-cumulative116-20261111-r1',
        source_commit=source['commit'], binary_source_commit='897892337f6d1c79151a1416314f7b64af3d5231',
        source_working_changes=source.get('working_changes', []),
        source_manifest_sha256=sha(JOB / 'src/input-manifest.json'), verified_source_files=len(source['files']),
        candidate_schema=112, production_schema_last_observed=99, production_applied=False,
        activation_ready=False, api_sha256=API_SHA, files=hashes, web_unchanged=False,
        web_source_commit='897892337f6d1c79151a1416314f7b64af3d5231', stress_assessment=stress,
        verification_status='cumulative99_to112_with115_api_web_and_protected_recovery_passed',
        rehearsal='single API; synthetic tmpfs DB; migration faults; compatible112 API/web recovery; encrypted DB/files plus latest checkpoint',
        production_probe_performed_this_round=False)
    result['changed_files'] = sorted(set(base['files']) ^ set(hashes) | {p for p, h in hashes.items() if p in base['files'] and base['files'][p] != h})
    result['activation_gates'] = [
        'single API only; retain115 dual-API408 and constrained-I/O503 failures as open conditions',
        'measure actual shared VPS I/O, ledger start/finish latency and resource headroom before rollout',
        'protect decrypted PostgreSQL temporary spill files and swap before encrypted operational use',
        'confirm full DB connection budget: API10+privacy16+cancel2, workers, other projects and reserved slots',
        'fresh production schema/binary/web/hash inventory and separate maintenance window; no production preflight this round',
        'stop and drain all GPS writers; review legacy Timescale retention and bind logging before conversion',
        'provision pgcrypto with DB administrator; separate restricted migration owner and runtime identity',
        'real key custody and protected backup plus latest external privacy checkpoint verified before reopening',
        'reviewed retention/notice policy, explicit subject consent and administrator PC/IP/MFA; no inferred consent',
        'production WAF compatibility, cancellation propagation and static asset/service-worker rollout acceptance',
        'physical TLS promotion, buffered maintenance/pause/resume and24-hour sleep; actual FCM/alarm delivery',
        'legacy WAL/snapshots/backups and unclassified/company files remain separately governed',
    ]
    (dest / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    archive = dest.with_suffix('.tar.gz')
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(dest, arcname=dest.name)
    with tarfile.open(archive) as tar:
        members = {m.name: m for m in tar.getmembers() if m.isfile()}
        assert len(members) == len(hashes) + 1
        assert all(hashlib.sha256(tar.extractfile(members[dest.name + '/' + p]).read()).hexdigest() == h for p, h in hashes.items())
    summary = {k: v for k, v in result.items() if k != 'files'}
    summary.update(artifact=str(archive), artifact_sha256=sha(archive), file_count=len(hashes))
    (JOB / 'out/candidate-manifest.json').write_text(json.dumps(summary, indent=2) + '\n')
    (JOB / 'out/package-verification.json').write_text(json.dumps(dict(archive_sha256=sha(archive),
        file_count=len(hashes), all_archive_bytes_match=True, historical_migrations_unchanged=True,
        activation_ready=False, failed_stress_conditions_preserved=True), indent=2) + '\n')
    print('CANDIDATE VERIFIED', sha(archive), len(hashes), flush=True)


if __name__ == '__main__':
    stage()
