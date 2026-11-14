import hashlib,json,pathlib,tarfile
job=pathlib.Path('/home/etcom-hub/build/gps-provision22-20261108c')
source=json.loads((job/'source-manifest.json').read_text())
wrong=[]
for name,digest in source.items():
    p=job/'src'/name
    data=p.read_bytes()
    if 'migrations/' not in name and p.suffix in {'.rs','.toml','.lock','.sql','.json','.js','.mjs','.jsx','.ts','.tsx','.css','.html','.py','.sh','.example','.md','.txt'}:data=data.replace(b'\r\n',b'\n')
    if hashlib.sha256(data).hexdigest()!=digest:wrong.append(name)
print(json.dumps({'source_files':len(source),'source_mismatches':wrong}))
assert not wrong
manifest=json.loads((job/'out/candidate-manifest.json').read_text())
archive=pathlib.Path(manifest['artifact'])
assert hashlib.sha256(archive.read_bytes()).hexdigest()==manifest['artifact_sha256']
with tarfile.open(archive) as tf:
    root=archive.name.removesuffix('.tar.gz')
    files=json.load(tf.extractfile(root+'/manifest.json'))['files']
    assert len(files)==manifest['file_count']
    for name,digest in files.items():
        assert hashlib.sha256(tf.extractfile(root+'/'+name).read()).hexdigest()==digest,name
    names=[m.name for m in tf.getmembers() if m.isfile()]
    assert len(names)==len(files)+1
report={'source_commit':manifest['source_commit'],'source_files':len(source),'source_mismatches':[],
        'candidate_files':len(files),'all_archive_hashes_match':True,'source_archive_sha256':hashlib.sha256((job/'source.tar.gz').read_bytes()).hexdigest(),
        'archive_sha256':manifest['artifact_sha256'],'production_applied':False,'activation_ready':False}
(job/'out/package-verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
