import sys,json,hashlib
from pathlib import Path
sys.path.insert(0,'src/ops')
from build_cleanup_20261113 import protected,containers
assert Path.cwd()==Path('/home/etcom-hub/build/gps-runtime140-20261118')
b=json.loads(Path('out/host-before.json').read_text());a=protected()
changed={k:{'before':v,'after':a.get(k)} for k,v in b['protected'].items() if a.get(k)!=v}
k='gps-runtime140-20261118/out/gps-tracker-api'
assert set(changed)=={k}
assert changed[k]['before']['sha256']==hashlib.sha256(Path('out/gps-tracker-api140-pre-normalization').read_bytes()).hexdigest()
assert changed[k]['after']['sha256']==hashlib.sha256(Path('out/gps-tracker-api140').read_bytes()).hexdigest()
assert containers()==b['containers']
result={'expected_own_candidate_alias_update':changed,'other_prior_artifacts_unchanged':True,'other_containers_unchanged':True,'reason':'setup copied new build into own alias after taking protected snapshot; setup now stages before snapshot'}
Path('out/cleanup-initial-alias-assertion.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
