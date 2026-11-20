"""Read-only evidence from the labeled128 synthetic fixture; no key values."""
import hashlib
import json
import rehearse_runtime128 as r

r.base.guard()
info=json.loads(r.call('docker','inspect',r.HOST).stdout)[0]
assert info['Config']['Labels'].get('gps.runtime128')=='synthetic'
for unit in ('api','db'):
    result=r.base.inside('journalctl','-u','gps121-'+unit,'--no-pager','-o','short-iso')
    (r.base.OUT/(unit+'128-journal.log')).write_text(result.stdout)
units=r.base.OUT/'units';units.mkdir(exist_ok=True)
names=['gps121-'+n+'.service' for n in ('api','db','migration','transition','cleanup','closure','recovery','checkpoint')]
names+=['run-gps121-'+n+'.mount' for n in ('sort','fallback','tmp')]
names+=['gps-workload.slice','gps-pdf-render.socket','gps-pdf-render@.service','gps-pdf-budget.service']
for name in names:
    (units/(name+'.txt')).write_text(r.base.inside('systemctl','cat',name).stdout)
names=['admin_db_roles.py','crypto20b_transition.py','location_storage.py','location_query_bounds.py',
       'location_query_statistics.py','test_backfill128.py','test_backfill_guards128.py',
       'verify_runtime128.py','final_reads128.py','test_statistics128.py','verify_query128.py',
       'perf_after_backfill128.py','runtime121_cumulative.py','test_runtime121.py','restore_runtime121.py']
values={}
for name in names:
    value=r.base.inside('cat','/opt/gps121/'+name).stdout
    values[name]=hashlib.sha256(value.encode()).hexdigest()
(r.base.OUT/'running-source128.json').write_text(json.dumps(values,indent=2))
assert values['location_query_bounds.py']==r.sha((r.JOB/'src/ops/location_query_bounds.py').read_bytes())
net=json.loads(r.call('docker','network','inspect',r.NET).stdout)[0]
assert net['Internal'] and not info['HostConfig']['PortBindings']
(r.base.OUT/'isolation128.json').write_text(json.dumps(dict(container=r.HOST,internal_network=True,
    published_ports=info['HostConfig']['PortBindings'],cpu_nanos=info['HostConfig']['NanoCpus'],
    memory_bytes=info['HostConfig']['Memory'],memory_swap_bytes=info['HostConfig']['MemorySwap'],
    production_modified=False,api_sha256=r.base.inside('sha256sum','/opt/gps121/out/gps-tracker-api').stdout.split()[0]),indent=2))
print('PASS128 final journal/source/isolation evidence collected',flush=True)
