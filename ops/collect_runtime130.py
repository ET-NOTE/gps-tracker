"""Read-only public evidence and pinned sources from the synthetic130 host."""
import hashlib
import json
import shutil
import subprocess
import rehearse_runtime130 as r

r.base.guard()
info=json.loads(r.call('docker','inspect',r.HOST).stdout)[0]
assert info['Config']['Labels'].get('gps.runtime130')=='synthetic'
net=json.loads(r.call('docker','network','inspect',r.NET).stdout)[0];cfg=info['HostConfig']
assert net['Internal'] and not cfg['Binds'] and not cfg['PortBindings']
(r.base.OUT/'isolation130.json').write_text(json.dumps(dict(image=info['Image'],container=r.HOST,
    internal_network=True,ports=cfg['PortBindings'],binds=cfg['Binds'],memory_bytes=cfg['Memory'],
    memory_swap_bytes=cfg['MemorySwap'],cpu_nanos=cfg['NanoCpus'],
    blkio={k:v for k,v in cfg.items() if k.startswith('Blkio')},
    api_sha256=r.base.inside('sha256sum','/opt/gps121/out/gps-tracker-api').stdout.split()[0],production_modified=False),indent=2))
for path in r.JOB.glob('source130-*.json'):
    shutil.copy2(path,r.base.OUT/path.name)
hashes={}
for name in ('load_runtime130.py','run_runtime130.py','audit_runtime130.py','profile_ingest130.py','test_ingest130.py','location_query_bounds.py','location_query_statistics.py',
             'privacy_file_cleanup.py','runtime121_control.py','runtime121_job.py','verify_runtime124.py','verify_runtime122.py'):
    value=subprocess.check_output(['docker','exec',r.HOST,'cat','/opt/gps121/'+name])
    digest=hashlib.sha256(value).hexdigest();assert digest==r.sha(r.JOB/'src/ops'/name),name
    hashes[name]=digest
(r.base.OUT/'running-source130.json').write_text(json.dumps(hashes,indent=2))
for name in ('api','db'):
    (r.base.OUT/(name+'130-journal.log')).write_text(r.base.inside('journalctl','-u','gps121-'+name,'--no-pager','-o','short-iso').stdout)
folder=r.base.OUT/'units';folder.mkdir(exist_ok=True)
for name in ['gps121-db.service','gps121-api.service','gps121-cleanup.service','gps122-proxy.service',
             'gps122-other.service','gps122-av.service','gps-workload.slice','gps-workload-pdf.slice',
             'run-gps121-sort.mount','run-gps121-fallback.mount','run-gps121-tmp.mount']:
    (folder/(name+'.txt')).write_text(r.base.inside('systemctl','cat',name).stdout)
print('PASS130 public unit/journal/source/isolation evidence; credentials excluded',flush=True)
