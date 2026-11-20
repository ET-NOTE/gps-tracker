"""Package the rehearsed 109 candidate only; no production connection/activation."""
import hashlib
import json
import pathlib
import shutil
import tarfile

ROOT=pathlib.Path('/home/etcom-hub/build')
JOB=ROOT/'gps-provision22-20261108cumulative109'
BASE=ROOT/'gps-provision22-20261108cumulative/candidate-cumulative108-20261108-r2'
BASE_HASH='0b470b08e8442917879867e4c4c1b3cc398cfd864c0f1b68ea5b8b0e478f5339'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
read=lambda n:json.loads((JOB/'out'/n).read_text())


def stage():
    assert sha(BASE.with_suffix('.tar.gz'))==BASE_HASH
    base=json.loads((BASE/'manifest.json').read_text())
    assert all(sha(BASE/p)==h for p,h in base['files'].items())
    source=json.loads((JOB/'source-manifest.json').read_text())
    assert all(sha(JOB/'src'/p)==h for p,h in source['files'].items())
    main=read('cumulative109.json')
    assert main['runtime_ready_for_regressions'] and main['schema_path']==[99,109]
    assert main['candidate_sha256']==sha(JOB/'out/gps-tracker-api')
    for n in ('regressions109.json','business-regressions.json'):
        rows=read(n);assert len(rows)==8 and all(r['exit']==0 for r in rows)
    restore=read('protected-restore109.json')
    assert all(restore[k] for k in ('checkpoint_hash_checked','old_erased_rows_removed',
        'old_consent_not_revived','pause_reapplied','accepted_notice_not_resent','sim_identity_preserved','old_resend_denied'))
    owner=read('file-owner109.json')
    assert owner['owner_group_preserved'] and owner['api_identity_can_read']
    load=read('mapping-history109.json')
    assert load['synthetic_rows']==32000 and len(load['owner_count_seconds'])==3
    assert max(load['owner_count_seconds'])<5 and load['point_query_execution_ms']<2000
    queries=read('mapping109-queries.json')
    assert queries['all_passed'] and len(queries['queries'])==4
    assert all(max(q['seconds'])<q['budget_seconds'] for q in queries['queries'])
    oracle=read('ancestry109-regression.json')
    assert len(oracle['cases'])==8 and all(c['same_effective_ids'] and c['oracle_equal'] for c in oracle['cases'])
    assert oracle['schema_path']==[108,109] and oracle['failed109_transaction_atomic']
    tests=read('additional109-tests.json')
    assert {t['check'] for t in tests}=={'external-all','external-boundary','ancestry109','query109'}
    assert all(t['exit']==0 for t in tests)
    assert 'test result: ok. 81 passed; 0 failed; 7 ignored' in (JOB/'out/api-check.log').read_text()
    dest=JOB/'candidate-cumulative109-20261108-r1'
    shutil.copytree(BASE,dest)  # Never overwrite an existing candidate.
    shutil.copy2(JOB/'out/gps-tracker-api',dest/'gps-tracker-api')
    helpers=('crypto20b_transition.py','admin_db_roles.py','location_storage.py')
    for n in helpers:shutil.copy2(JOB/'src/ops'/n,dest/'ops'/n)
    migration='0109_subject_effective_ancestry.sql'
    # Existing packages carry reviewed migrations next to the binary.
    assert (dest/'migrations').is_dir()
    shutil.copy2(JOB/'src/gps-tracker-api/migrations'/migration,dest/'migrations'/migration)
    hashes={str(p.relative_to(dest)):sha(p) for p in sorted(dest.rglob('*')) if p.is_file() and p.name!='manifest.json'}
    changed=sorted(p for p,h in hashes.items() if base['files'].get(p)!=h)
    assert changed==sorted(['gps-tracker-api','migrations/'+migration]+['ops/'+n for n in helpers])
    result=dict(base)
    for key in ('base_source_manifest_sha256','base_verified_source_files','patched_operations_sha256'):
        result.pop(key,None)
    result.update(source_commit=source['commit'],binary_source_commit=source['commit'],
        source_manifest_sha256=sha(JOB/'source-manifest.json'),verified_source_files=len(source['files']),
        base_artifact_sha256=BASE_HASH,candidate_schema=109,production_schema=99,
        api_sha256=sha(JOB/'out/gps-tracker-api'),production_applied=False,activation_ready=False,
        verification_status='functional_and_mapping_performance_pass',mapping_performance_gate_passed=True,
        mapping_owner_count_seconds=load['owner_count_seconds'],changed_files=changed,files=hashes,
        web_source_commit=base['binary_source_commit'],web_unchanged=True,
        rehearsal='actual99 to109; populated108 to109 consent oracle; encrypted full recovery; synthetic tmpfs workload')
    result['activation_gates']=[g for g in base['activation_gates'] if not g.startswith('mapping effective-view')]
    result['activation_gates'].insert(0,'full-period location decryption and concurrent VPS I/O remain separate performance acceptance')
    (dest/'manifest.json').write_text(json.dumps(result,indent=2)+'\n')
    archive=dest.with_suffix('.tar.gz')
    with tarfile.open(archive,'w:gz') as tar:tar.add(dest,arcname=dest.name)
    with tarfile.open(archive) as tar:
        members={m.name:m for m in tar.getmembers() if m.isfile()}
        assert len(members)==len(hashes)+1
        for p,h in hashes.items():assert hashlib.sha256(tar.extractfile(members[dest.name+'/'+p]).read()).hexdigest()==h
    summary={k:v for k,v in result.items() if k!='files'}
    summary.update(artifact=str(archive),artifact_sha256=sha(archive),file_count=len(hashes))
    (JOB/'out/candidate-manifest.json').write_text(json.dumps(summary,indent=2)+'\n')
    (JOB/'out/package-verification.json').write_text(json.dumps({'archive_sha256':sha(archive),
        'file_count':len(hashes),'all_archive_bytes_match':True,'changed_from108':changed,
        'historic_migrations_and_web_unchanged':True,'activation_ready':False},indent=2)+'\n')
    print(json.dumps(summary,indent=2))


if __name__=='__main__':stage()
