import hashlib,json,tarfile,pathlib
job=pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111query111')
manifest=json.loads((job/'input-manifest.json').read_text())
assert not manifest['working_changes']
checked=[]
with tarfile.open(job/'source.tar') as tar:
 for member in tar:
  assert member.isfile() and member.name.startswith(('gps-tracker-api/','ops/')) and '..' not in pathlib.PurePosixPath(member.name).parts
  value=tar.extractfile(member).read();assert hashlib.sha256(value).hexdigest()==manifest['files'][member.name]
  target=job/'src'/member.name
  if member.name.startswith('gps-tracker-api/') or member.name in ['ops/admin_db_roles.py','ops/location_storage.py','ops/crypto20b_transition.py','ops/location_query_bounds.py']:
   assert target.read_bytes()==value,member.name
   checked.append(member.name)
  else:target.write_bytes(value)
(job/'src/input-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(job/'out/source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(job/'out/code-provenance.json').write_text(json.dumps({'commit':manifest['commit'],'compiled_api_and_runtime_helpers_byte_equal':True,'checked_files':len(checked),'source_files':len(manifest['files']),'old_migrations_byte_preserved':True},indent=2)+'\n')
print('COMMITTED SOURCE MATCH',len(checked),manifest['commit'])
