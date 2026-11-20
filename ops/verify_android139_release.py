"""Read-only: compare installed APK and public HTTPS artifacts to release hashes."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

serial=sys.argv[1]
out=Path('docs/evidence/android139-20261118')
manifest=json.loads((out/'apk-manifest.json').read_text())
def adb(*args):return subprocess.check_output(['adb','-s',serial,*args],timeout=30)
path=adb('shell','pm','path','com.etcompany.gpstracker').decode().strip().removeprefix('package:')
assert path.startswith('/data/app/') and path.endswith('/base.apk')
digest=adb('shell','sha256sum',path).decode().split()[0]
assert digest==manifest['apk_sha256']
installed={'model':adb('shell','getprop','ro.product.model').decode().strip(),
           'android':adb('shell','getprop','ro.build.version.release').decode().strip(),
           'version':'1.0.8','version_code':14,'installed_apk_sha256':digest,
           'release_apk_equal':True,'data_reset':False}
(out/'installed-apk.json').write_text(json.dumps(installed,indent=2))
results={}
for ext in ['apk','zip']:
    url='https://gps.serial.kr/gps-tracker-1.0.8-14.'+ext
    with urllib.request.urlopen(url,timeout=90) as response:
        h=hashlib.sha256();total=0
        while chunk:=response.read(1024*1024):h.update(chunk);total+=len(chunk)
        assert h.hexdigest()==manifest[ext+'_sha256']
        results[ext]={'url':url,'sha256':h.hexdigest(),'bytes':total,
                      'content_type':response.headers['Content-Type'],
                      'content_disposition':response.headers['Content-Disposition']}
(out/'public-downloads.json').write_text(json.dumps(results,indent=2))
print('PASS installed APK and both external public downloads match signed release')
