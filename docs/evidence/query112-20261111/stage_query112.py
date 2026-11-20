"""Package the verified cumulative112 candidate, with no production activation."""
import hashlib
import json
import pathlib
import shutil
import tarfile

ROOT = pathlib.Path('/home/etcom-hub/build')
PERF = ROOT / 'gps-provision22-20261111query112'
JOB = ROOT / 'gps-provision22-20261111cumulative112'
BASE = ROOT / 'gps-provision22-20261111cumulative111/candidate-cumulative111-20261111-r1'
BASE_HASH = '2b22794ef68bd50f8214d208cd7d40a8618de6160278bca79e0a869cae46b7b2'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
read = lambda n: json.loads((JOB / 'out' / n).read_text())
perf = lambda n: json.loads((PERF / 'out' / n).read_text())


def stage():
    assert sha(BASE.with_suffix('.tar.gz')) == BASE_HASH
    base = json.loads((BASE / 'manifest.json').read_text())
    assert all(sha(BASE / p) == h for p, h in base['files'].items())
    source = json.loads((JOB / 'src/input-manifest.json').read_text())
    assert all(sha(JOB / 'src' / p) == h for p, h in source['files'].items())
    main = read('cumulative112.json')
    assert main['runtime_ready_for_regressions'] and main['schema_path'] == [99, 112]
    binary = sha(JOB / 'out/gps-tracker-api')
    assert main['candidate_sha256'] == binary == sha(PERF / 'out/gps-tracker-api.final112')
    for n in ('regressions112.json', 'business-regressions.json'):
        rows = read(n)
        assert len(rows) == 8 and all(r['exit'] == 0 for r in rows)
    assert len(read('additional112-tests.json')) == 4 and all(r['exit'] == 0 for r in read('additional112-tests.json'))
    restore = read('protected-restore112.json')
    assert all(restore[k] for k in ('checkpoint_hash_checked', 'old_erased_rows_removed', 'old_consent_not_revived',
        'pause_reapplied', 'accepted_notice_not_resent', 'sim_identity_preserved', 'old_resend_denied'))
    owner = read('file-owner112.json')
    assert owner['owner_group_preserved'] and owner['api_identity_can_read']
    assert read('mapping109-queries.json')['all_passed']
    oracle = read('ancestry109-regression.json')
    assert oracle['schema_path'] == [108, 112] and all(c['same_effective_ids'] and c['oracle_equal'] for c in oracle['cases'])
    assert 'test result: ok. 83 passed; 0 failed; 7 ignored' in (PERF / 'out/api-check-final.log').read_text()
    assert perf('equivalence112.json')['passed'] and perf('equivalence112.json')['checks']==585
    assert perf('projection112.json')['passed'] and perf('projection112.json')['checks']==42
    assert perf('compression112.json')['passed']
    baseline,final=perf('baseline111-full-month.json'),perf('final112-full-month.json')
    for name,old in baseline['queries'].items():
        new=final['queries'][name]
        assert len(old)==len(new)==3
        assert all(v['rows']==283001 and v['sha256']==old[0]['sha256'] for v in old+new)
        assert sum(v['seconds'] for v in new)<sum(v['seconds'] for v in old)
    assert perf('baseline111-http-oracle.json')==perf('final112-http-oracle.json')
    for label,workers,duration in [('final112',8,900),('stress112',16,300)]:
        load=perf(label+'-sustained.json')
        assert load['api_sha256']==binary and not load['errors']
        assert load['workers']==workers and load['target_duration_s']==duration and load['duration_s']>=duration
        assert load['pg_settings']['max_connections']=='50'
        assert load['health']['p95_s']<2 and load['signed_tls12_ingest']['p95_s']<2
        assert all(load['http'][name]['count']>0 for name in ('month_aggregate','month_history','day_aggregate','latest','month_page'))
        # Rejected 429 reads are recorded separately, never counted as success.
        assert load['requests']==sum(v['count'] for v in load['http'].values())
        assert all(row['route'] in load['http'] for row in load['busy_responses'])
        assert load['physical_plaintext_rows']==0 and load['physical_ciphertext_rows']>0
        assert all(not c['oom'] and c['restarts']==0 for r in load['resources'] for c in r['containers'])
    assert any(t['points']==283001 and t['pages']==57 for t in perf('final112-sustained.json')['traversals'])
    dest = JOB / 'candidate-cumulative112-20261111-r1'
    shutil.copytree(BASE, dest)
    shutil.copy2(JOB / 'out/gps-tracker-api', dest / 'gps-tracker-api')
    helpers = ['crypto20b_transition.py', 'admin_db_roles.py', 'location_storage.py', 'location_query_bounds.py']
    for name in helpers:
        shutil.copy2(JOB / 'src/ops' / name, dest / 'ops' / name)
    migration = '0112_location_window_pipeline.sql'
    shutil.copy2(JOB / 'src/gps-tracker-api/migrations' / migration, dest / 'migrations' / migration)
    hashes = {str(p.relative_to(dest)): sha(p) for p in sorted(dest.rglob('*')) if p.is_file() and p.name != 'manifest.json'}
    changed = sorted(p for p, h in hashes.items() if base['files'].get(p) != h)
    assert changed == sorted(['gps-tracker-api', 'migrations/' + migration] + ['ops/' + n for n in helpers])
    result = dict(base)
    result.update(source_commit=source['commit'], binary_source_commit=source['commit'],
        source_working_changes=source.get('working_changes', []),
        source_manifest_sha256=sha(JOB / 'src/input-manifest.json'), verified_source_files=len(source['files']),
        base_artifact_sha256=BASE_HASH, candidate_schema=112, production_schema=99,
        api_sha256=binary, production_applied=False, activation_ready=False,
        verification_status='full_month_equivalence_and_sustained_signed_ingest_pass', changed_files=changed, files=hashes,
        web_unchanged=True, rehearsal='actual99 to112; disk-backed HTTP8/900s and16/300s with TLS1.2 signed ingest; tmpfs cumulative recovery/consent')
    result['activation_gates'] = [g for g in base['activation_gates'] if not g.startswith(('full-period location decryption', 'actual VPS I/O/distribution', 'keyed resumable query-bound backfill'))]
    result['activation_gates'].insert(0, 'actual VPS I/O and other projects contention, dense31-day/multi-device distributions and larger-scale acceptance; bounded synthetic sustained load only')
    result['activation_gates'].insert(1, 'keyed resumable query-bound backfill and pending=0 verification before enabling the fast-path acceptance')
    result['activation_gates'].insert(2, 'DB connection budget: queries10 plus privacy leases16 per API, workers, reserved slots and other projects; isolated DB50 only was tested')
    result['activation_gates'].insert(3, 'decrypted PostgreSQL temporary sort/spill files and swap need infrastructure protection; field encryption is not whole-disk encryption')
    result['activation_gates'].insert(4, 'per-process read budget covers location history/page/aggregate only; fleet/export and multi-process fairness plus client429 retry UX require operating acceptance')
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
        'all_archive_bytes_match': True, 'changed_from111': changed, 'historic_migrations_and_web_unchanged': True,
        'activation_ready': False}, indent=2) + '\n')
    print('CANDIDATE VERIFIED', sha(archive), len(hashes), flush=True)


if __name__ == '__main__':
    stage()
