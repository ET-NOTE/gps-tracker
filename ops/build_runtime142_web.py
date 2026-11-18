"""Build/test the142 web candidate only. No production or dev deployment."""
from pathlib import Path
import json,hashlib,subprocess

JOB=Path('/home/etcom-hub/build/gps-runtime142-20261118')
assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub'
assert Path.cwd()==JOB
with (JOB/'out/build-web.log').open('w') as log:
    result=subprocess.run(['docker','run','--rm','--name','gps142-build-web','--label','gps.runtime142=synthetic',
      '--user','1000:1000','-v',str(JOB/'src')+':/src','-w','/src/gps-tracker-web',
      '-e','npm_config_cache=/tmp/npm-cache','-e','VITE_BASE=/','-e','VITE_BUILD_LABEL=runtime142-20261118-r1',
      'gps-build:rust1.88-node22.22.2','bash','-c',
      'node --version && npm ci --no-audit --no-fund && npm test && npm run build'],stdout=log,stderr=subprocess.STDOUT)
assert result.returncode==0,'See original out/build-web.log'
web=JOB/'src/gps-tracker-web/dist'
assert b'"/assets/' in (web/'index.html').read_bytes()
manifest={str(p.relative_to(web)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(web.rglob('*')) if p.is_file()}
(JOB/'out/web-files.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('PASS web full functional tests and root-base build:',len(manifest),'files')
