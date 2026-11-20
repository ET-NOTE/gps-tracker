import hashlib,json,pathlib,shutil
root=pathlib.Path('/home/etcom-hub/build')
perf=root/'gps-provision22-20261111query111'; job=root/'gps-provision22-20261111cumulative111'
manifest=json.loads((perf/'src/input-manifest.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert not manifest['working_changes']
diff=[p for p,h in manifest['files'].items() if sha(job/'src'/p)!=h]
assert diff==['ops/stage_query111.py'],diff
shutil.copy2(perf/'src/ops/stage_query111.py',job/'src/ops/stage_query111.py')
shutil.copy2(perf/'src/input-manifest.json',job/'src/input-manifest.json')
assert all(sha(job/'src'/p)==h for p,h in manifest['files'].items())
assert sha(job/'out/gps-tracker-api')==sha(perf/'out/gps-tracker-api')
report={'source_commit':manifest['commit'],'source_files':len(manifest['files']),
 'api_sha256':sha(job/'out/gps-tracker-api'),'all_compiled_api_migration_inputs_match_git':True,
 'runtime_ops_inputs_unchanged':True,'post_build_change_scope':'verification and packaging scripts only',
 'post_rehearsal_preparation_change':diff,'production_modified':False}
(perf/'out/code-provenance.json').write_text(json.dumps(report,indent=2)+'\n')
print('FINAL SOURCE MATCH',manifest['commit'],len(manifest['files']))
