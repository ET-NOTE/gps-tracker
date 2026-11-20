"""Read-only public evidence and pinned sources from the synthetic131 host."""
import hashlib
import json
import shutil
import subprocess
import rehearse_runtime131 as r

r.base.guard()
info=json.loads(r.call('docker','inspect',r.HOST).stdout)[0]
assert info['Config']['Labels'].get('gps.runtime131')=='synthetic'
net=json.loads(r.call('docker','network','inspect',r.NET).stdout)[0];cfg=info['HostConfig']
assert net['Internal'] and not cfg['Binds'] and not cfg['PortBindings']
(r.base.OUT/'isolation131.json').write_text(json.dumps(dict(image=info['Image'],container=r.HOST,
    internal_network=True,ports=cfg['PortBindings'],binds=cfg['Binds'],memory_bytes=cfg['Memory'],
    memory_swap_bytes=cfg['MemorySwap'],cpu_nanos=cfg['NanoCpus'],
    blkio={k:v for k,v in cfg.items() if k.startswith('Blkio')},
    api_sha256=r.base.inside('sha256sum','/opt/gps121/out/gps-tracker-api').stdout.split()[0],production_modified=False),indent=2))
for path in r.JOB.glob('source131-*.json'):
    shutil.copy2(path,r.base.OUT/path.name)
hashes={}
for name in ('load_runtime131.py','run_runtime131.py','audit_runtime131.py','profile_ingest131.py','test_ingest131.py','verify_endpoints131.py','verify_download131.py','location_query_bounds.py','location_query_statistics.py',
             'privacy_file_cleanup.py','runtime121_control.py','runtime121_job.py','verify_runtime124.py','verify_runtime122.py'):
    value=subprocess.check_output(['docker','exec',r.HOST,'cat','/opt/gps121/'+name])
    digest=hashlib.sha256(value).hexdigest();assert digest==r.sha(r.JOB/'src/ops'/name),name
    hashes[name]=digest
(r.base.OUT/'running-source131.json').write_text(json.dumps(hashes,indent=2))
for name in ('api','db'):
    (r.base.OUT/(name+'131-journal.log')).write_text(r.base.inside('journalctl','-u','gps121-'+name,'--no-pager','-o','short-iso').stdout)
folder=r.base.OUT/'units';folder.mkdir(exist_ok=True)
for name in ['gps121-db.service','gps121-api.service','gps121-cleanup.service','gps122-proxy.service',
             'gps122-other.service','gps122-av.service','gps-workload.slice','gps-workload-pdf.slice',
             'run-gps121-sort.mount','run-gps121-fallback.mount','run-gps121-tmp.mount']:
    (folder/(name+'.txt')).write_text(r.base.inside('systemctl','cat',name).stdout)
print('PASS131 public unit/journal/source/isolation evidence; credentials excluded',flush=True)
