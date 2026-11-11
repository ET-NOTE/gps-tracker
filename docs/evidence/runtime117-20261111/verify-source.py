import json,hashlib
from pathlib import Path
root=Path('/home/etcom-hub/build/gps-provision22-20261111runtime117')
expected=json.loads((root/'source-expected.json').read_text())
actual={name:hashlib.sha256((root/'src'/name).read_bytes().replace(b'\r\n',b'\n')).hexdigest() for name in expected}
bad=[name for name in expected if actual[name]!=expected[name]]
assert not bad,bad
report={'normalization':'CRLF to LF only','all_match':True,'files':len(expected),'sha256':actual,'api_sha256':hashlib.sha256((root/'out/gps-tracker-api').read_bytes()).hexdigest()}
(root/'out/source-verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='sha256'}))
