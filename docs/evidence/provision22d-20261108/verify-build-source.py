import pathlib,json,hashlib
job=pathlib.Path('/home/etcom-hub/build/gps-provision22-20261108d')
m=json.loads((job/'source-manifest-final.json').read_text()); bad=[];n=0
for name,digest in m.items():
 if not name.startswith(('gps-tracker-api/','gps-tracker-web/')):continue
 n+=1;p=job/'src'/name;data=p.read_bytes()
 if '/migrations/' not in name and p.suffix.lower() in ('.rs','.toml','.lock','.sql','.json','.js','.mjs','.jsx','.ts','.tsx','.css','.html','.py','.sh','.example','.md','.txt'):data=data.replace(b'\r\n',b'\n')
 if hashlib.sha256(data).hexdigest()!=digest:bad.append(name)
r={'source_commit':(job/'source-commit.txt').read_text().strip(),'compiled_source_files_checked_before_archive_update':n,'mismatches':bad}
(job/'out/build-source-verification.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r));assert not bad
