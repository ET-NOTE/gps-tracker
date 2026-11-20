"""Read-only attestation for the fixed runtime117 rehearsal (not a VPS installer).

Both mounts, cgroup v2 swap control, core limit and role configuration are
checked. A SQL tablespace name alone is never reported as protected storage.
"""
import json
import subprocess
from datetime import datetime, timezone
import runtime117 as test

b = test.workload()
assert b.info('network', b.NET)['Internal']
assert b.info('volume', b.VOL)['Labels']['gps.runtime117'] == 'synthetic'
checks = []


def check(name, ok, evidence):
    checks.append({'name': name, 'passed': bool(ok), 'evidence': evidence})


for name in [b.DB, b.API]:
    b.ip(name)
    maximum = subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/memory.swap.max'],text=True).strip()
    used = subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/memory.swap.current'],text=True).strip()
    limit = b.info('container',name)['HostConfig']['Ulimits']
    check(name+'_swap',maximum == '0' and used == '0',{'max':maximum,'current':used})
    check(name+'_core',any(x['Name']=='core' and x['Soft']==0 and x['Hard']==0 for x in limit),limit)
mounts = subprocess.check_output(['docker','exec',b.DB,'cat','/proc/mounts'],text=True)
for path in ['/gps-temp','/var/lib/postgresql/data/base/pgsql_tmp']:
    entries = [x.split() for x in mounts.splitlines() if x.split()[1]==path]
    check('mount_'+path, len(entries)==1 and entries[0][2]=='tmpfs' and all(x in entries[0][3].split(',') for x in ['nosuid','nodev','noexec']), entries)
default = b.sql('SELECT t.spcname FROM pg_database d JOIN pg_tablespace t ON t.oid=d.dattablespace WHERE d.datname=current_database()')
check('known_database_fallback',default==[('pg_default',)],default)
space = b.sql("SELECT pg_tablespace_location(oid),has_tablespace_privilege('gps_runtime',oid,'CREATE') FROM pg_tablespace WHERE spcname='gps_runtime117_temp'")
check('dedicated_tablespace',space==[('/gps-temp/work',True)],space)
setting = b.sql("SELECT setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='gps_runtime'")
check('role_temp_file_limit',any('temp_file_limit=128MB' in x[0] for x in setting),setting)
report = {'checked_utc':datetime.now(timezone.utc).isoformat(), 'scope':'isolated runtime117 only',
          'passed':all(x['passed'] for x in checks),'checks':checks,'production_ready':False}
b.save('temp-preflight',report)
print(json.dumps(report,indent=2))
assert report['passed']
