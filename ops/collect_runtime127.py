"""Read-only final isolated evidence; no fixture secret values are printed."""
import hashlib
import json
import rehearse_runtime127 as r

r.base.guard()
info=json.loads(r.call('docker','inspect',r.HOST).stdout)[0]
assert info['Config']['Labels'].get('gps.runtime127')=='synthetic'
for unit in ('api','db'):
    result=r.base.inside('journalctl','-u','gps121-'+unit,'--no-pager','-o','short-iso')
    (r.base.OUT/(unit+'127-journal.log')).write_text(result.stdout)
names=['admin_db_roles.py','crypto20b_transition.py','location_storage.py','location_query_bounds.py',
       'location_query_statistics.py','regress_runtime127.py','test_statistics127.py','verify_query127.py',
       'perf_runtime127.py','restore_load127.py','compressed_oracle127.py','profile_runtime127.py']
values={}
for name in names:
    value=r.base.inside('cat','/opt/gps121/'+name).stdout
    values[name]=hashlib.sha256(value.encode()).hexdigest()
    if name in ('regress_runtime127.py','test_statistics127.py'):
        (r.base.OUT/'adapters'/name).write_text(value)
(r.base.OUT/'running-source127.json').write_text(json.dumps(values,indent=2))
net=json.loads(r.call('docker','network','inspect',r.NET).stdout)[0]
assert net['Internal'] and not info['HostConfig']['PortBindings']
(r.base.OUT/'isolation127.json').write_text(json.dumps(dict(container=r.HOST,internal_network=True,
    published_ports=info['HostConfig']['PortBindings'],cpu_nanos=info['HostConfig']['NanoCpus'],
    memory_bytes=info['HostConfig']['Memory'],memory_swap_bytes=info['HostConfig']['MemorySwap'],
    production_modified=False,api_sha256=r.base.inside('sha256sum','/opt/gps121/out/gps-tracker-api').stdout.split()[0]),indent=2))
print('PASS127 final journal/source/isolation evidence collected',flush=True)
