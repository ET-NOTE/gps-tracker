"""Package the verified cumulative111 candidate, with no production activation."""
import hashlib
import json
import pathlib
import shutil
import tarfile

ROOT = pathlib.Path('/home/etcom-hub/build')
PERF = ROOT / 'gps-provision22-20261111query111'
JOB = ROOT / 'gps-provision22-20261111cumulative111'
BASE = ROOT / 'gps-provision22-20261111cumulative110/candidate-cumulative110-20261111-r1'
BASE_HASH = '02df050a4f624ec47943bdfd414328083bc191afc5a726ee54e437fed5441fc7'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
read = lambda n: json.loads((JOB / 'out' / n).read_text())
perf = lambda n: json.loads((PERF / 'out' / n).read_text())


def stage():
    assert sha(BASE.with_suffix('.tar.gz')) == BASE_HASH
    base = json.loads((BASE / 'manifest.json').read_text())
    assert all(sha(BASE / p) == h for p, h in base['files'].items())
    source = json.loads((JOB / 'src/input-manifest.json').read_text())
    assert all(sha(JOB / 'src' / p) == h for p, h in source['files'].items())
    main = read('cumulative111.json')
    assert main['runtime_ready_for_regressions'] and main['schema_path'] == [99, 111]
    binary = sha(JOB / 'out/gps-tracker-api')
    assert main['candidate_sha256'] == binary == sha(PERF / 'out/gps-tracker-api')
    for n in ('regressions111.json', 'business-regressions.json'):
        rows = read(n)
        assert len(rows) == 8 and all(r['exit'] == 0 for r in rows)
    assert len(read('additional111-tests.json')) == 4 and all(r['exit'] == 0 for r in read('additional111-tests.json'))
    restore = read('protected-restore111.json')
    assert all(restore[k] for k in ('checkpoint_hash_checked', 'old_erased_rows_removed', 'old_consent_not_revived',
        'pause_reapplied', 'accepted_notice_not_resent', 'sim_identity_preserved', 'old_resend_denied'))
    owner = read('file-owner111.json')
    assert owner['owner_group_preserved'] and owner['api_identity_can_read']
    assert read('mapping109-queries.json')['all_passed']
    oracle = read('ancestry109-regression.json')
    assert oracle['schema_path'] == [108, 111] and all(c['same_effective_ids'] and c['oracle_equal'] for c in oracle['cases'])
    assert 'test result: ok. 81 passed; 0 failed; 7 ignored' in (PERF / 'out/api-check-final.log').read_text()
    assert perf('page-equivalence111.json')['passed']
    assert perf('compression111.json')['passed']
    assert perf('page-dataset111.json')['rows'] == 283001
    assert perf('page-dataset111.json')['passed'] and perf('page-snapshot111.json')['passed']
    assert perf('http-pages111.json')['all_item_fields_and_cursors_equal']
    for workers, requests in [(8, 200), (16, 800)]:
        load = perf(f'load111-{workers}.json')
        assert load['api_sha256'] == binary and load['requests'] == requests and not load['errors']
        assert load['db_connection_settings']['max_connections'] == '50'
        assert load['api_pool_limits'] == {'queries': 10, 'privacy_leases': 16}
        assert load['health']['p95_s'] < 2 and load['encrypted_writes']['p95_s'] < 2
        assert load['http']['month_page']['p95_s'] < 5
    assert perf('load111-8.json')['http']['month_page']['p95_s'] < .5 * perf('baseline110-http8.json')['http']['month_page']['p95_s']
    dest = JOB / 'candidate-cumulative111-20261111-r1'
    shutil.copytree(BASE, dest)
    shutil.copy2(JOB / 'out/gps-tracker-api', dest / 'gps-tracker-api')
    helpers = ['crypto20b_transition.py', 'admin_db_roles.py', 'location_storage.py', 'location_query_bounds.py']
    for name in helpers:
        shutil.copy2(JOB / 'src/ops' / name, dest / 'ops' / name)
    migration = '0111_location_page_windows.sql'
    shutil.copy2(JOB / 'src/gps-tracker-api/migrations' / migration, dest / 'migrations' / migration)
    hashes = {str(p.relative_to(dest)): sha(p) for p in sorted(dest.rglob('*')) if p.is_file() and p.name != 'manifest.json'}
    changed = sorted(p for p, h in hashes.items() if base['files'].get(p) != h)
    assert changed == sorted(['gps-tracker-api', 'migrations/' + migration] + ['ops/' + n for n in helpers])
    result = dict(base)
    result.update(source_commit=source['commit'], binary_source_commit=source['commit'],
        source_working_changes=source.get('working_changes', []),
        source_manifest_sha256=sha(JOB / 'src/input-manifest.json'), verified_source_files=len(source['files']),
        base_artifact_sha256=BASE_HASH, candidate_schema=111, production_schema=99,
        api_sha256=binary, production_applied=False, activation_ready=False,
        verification_status='encrypted_query_and_isolated_concurrency_pass', changed_files=changed, files=hashes,
        web_unchanged=True, rehearsal='actual99 to111; disk-backed HTTP8/16 and complete page equivalence; tmpfs cumulative recovery/consent')
    result['activation_gates'] = [g for g in base['activation_gates'] if not g.startswith(('full-period location decryption', 'actual VPS I/O/distribution', 'keyed resumable query-bound backfill'))]
    result['activation_gates'].insert(0, 'actual VPS I/O/distribution and long-duration production-sized query acceptance; synthetic page budget passed')
    result['activation_gates'].insert(1, 'keyed resumable query-bound backfill and pending=0 verification before enabling the fast-path acceptance')
    result['activation_gates'].insert(2, 'DB connection budget: queries10 plus privacy leases16 per API, workers, reserved slots and other projects; isolated DB50 only was tested')
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
    (JOB / 'out/package-verification.json').write_text(json.dumps({'archive_sha256': sha(archive), 'file_count': len(hashes),
        'all_archive_bytes_match': True, 'changed_from110': changed, 'historic_migrations_and_web_unchanged': True,
        'activation_ready': False}, indent=2) + '\n')
    print('CANDIDATE VERIFIED', sha(archive), len(hashes), flush=True)


if __name__ == '__main__':
    stage()
