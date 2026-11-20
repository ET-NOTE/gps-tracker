import hashlib,json,tarfile
from pathlib import Path
JOB=Path('/home/etcom-hub/build/gps-runtime143-20261118')
assert Path.cwd()==JOB
sha=lambda b:hashlib.sha256(b).hexdigest()
synced=[];checked={}
with tarfile.open('source143-final.tar') as archive:
    commit=archive.pax_headers['comment']
    for entry in archive:
        if not entry.isfile():continue
        assert entry.name.startswith(('gps-tracker-api/','gps-tracker-web/','ops/')) and '..' not in Path(entry.name).parts
        data=archive.extractfile(entry).read();target=JOB/'src'/entry.name
        old=target.read_bytes() if target.exists() else None
        if old!=data:
            assert entry.name in ['ops/test_company_tasks143.py','ops/check-company-tasks143-ui.mjs'],entry.name
            assert old is None or old.replace(b'\r\n',b'\n')==data,entry.name
            target.write_bytes(data);synced.append(entry.name)
        assert target.read_bytes()==data
        checked[entry.name]=sha(data)
report=dict(source_commit=commit,source_files=len(checked),export_command='git -c core.autocrlf=true archive HEAD gps-tracker-api gps-tracker-web ops',archive_sha256=sha(Path('source143-final.tar').read_bytes()),api_sha256=sha((JOB/'out/gps-tracker-api143').read_bytes()),api_web_source_changed=False,runner_only_synced=synced,files=checked)
(JOB/'out/source-final143.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='files'}))
