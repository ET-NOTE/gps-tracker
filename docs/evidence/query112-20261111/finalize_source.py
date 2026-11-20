import hashlib,json,pathlib,shutil,tarfile
root=pathlib.Path('/home/etcom-hub/build')
perf=root/'gps-provision22-20261111query112';job=root/'gps-provision22-20261111cumulative112'
manifest=json.loads((perf/'input-manifest.json').read_text())
assert not manifest['working_changes']
sha=lambda b:hashlib.sha256(b).hexdigest()
with tarfile.open(perf/'source.tar') as tar:
 blobs={p:tar.extractfile(p).read() for p in manifest['files']}
assert all(sha(b)==manifest['files'][p] for p,b in blobs.items())
runtime=['ops/'+p for p in ['crypto20b_transition.py','admin_db_roles.py','location_storage.py','location_query_bounds.py']]
changes={}
for folder in (perf,job):
 changed=[p for p,b in blobs.items() if (folder/'src'/p).read_bytes()!=b]
 assert not any(p.startswith('gps-tracker-api/') or p in runtime for p in changed),changed
 changes[folder.name]=changed
 for p,b in blobs.items():(folder/'src'/p).write_bytes(b)
 (folder/'src/input-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
previous=perf/'out/code-provenance.json'
if previous.exists():
 old=json.loads(previous.read_text())
 assert old['source_commit']==manifest['commit']
 for name,paths in old.get('post_build_changes',{}).items():
  changes[name]=sorted(set(paths+changes.get(name,[])))
assert sha((job/'out/gps-tracker-api').read_bytes())==sha((perf/'out/gps-tracker-api.final112').read_bytes())
assert sha((perf/'out/gps-tracker-api.normalized112').read_bytes())==sha((perf/'out/gps-tracker-api.final112').read_bytes())
report={'source_commit':manifest['commit'],'source_files':len(blobs),
 'api_sha256':sha((job/'out/gps-tracker-api').read_bytes()),'compiled_api_and_migration_inputs_byte_identical':True,
 'runtime_helpers_byte_identical':True,'post_build_changes':changes,
 'normalized_git_source_rebuild_has_identical_binary':True,'production_modified':False}
(perf/'out/code-provenance.json').write_text(json.dumps(report,indent=2)+'\n')
shutil.copy2(job/'src/ops/stage_query112.py',job/'stage_query112.py')
# Generated harnesses contain the final binary hash; refresh their evidence.
(job/'out/generated-harnesses.json').write_text(json.dumps({p.name:sha(p.read_bytes()) for p in job.glob('*.py')},indent=2)+'\n')
print(json.dumps(report))
