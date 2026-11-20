"""Preserve the two119 failed synthetic attempts before their isolated rerun."""
import json
from pathlib import Path
import subprocess

root=Path('/home/etcom-hub/build')
assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub'
for suffix,names,reason in [
    ('cumulative119',['gps-provision22-db-20261112cumulative119'],'recovery-1500m-oom'),
    ('runtime119',['gps-runtime119-db'],'seed-dependency-failed')]:
    job=root/('gps-provision22-20261112'+suffix)
    destination=job.with_name(job.name+'-'+reason)
    assert job.resolve().parent==root and not job.is_symlink() and not destination.exists()
    report={'production_modified':False,'reason':reason,'containers':[]}
    for name in names:
        info=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
        assert info['Config']['Labels']['gps.runtime119']=='synthetic'
        assert not info['HostConfig']['PortBindings']
        report['containers'].append({'name':name,'state':info['State'],
          'memory_events':subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/memory.events'],text=True)})
        (job/'out'/(reason+'-db.log')).write_bytes(subprocess.check_output(['docker','logs',name],stderr=subprocess.STDOUT))
        subprocess.run(['docker','rm','-f',name],check=True,stdout=subprocess.DEVNULL)
    if suffix=='runtime119':
        vol='gps-runtime119-data'
        info=json.loads(subprocess.check_output(['docker','volume','inspect',vol]))[0]
        assert info['Labels']['gps.runtime119']=='synthetic'
        subprocess.run(['docker','volume','rm',vol],check=True,stdout=subprocess.DEVNULL)
    (job/'out/failure119.json').write_text(json.dumps(report,indent=2))
    job.rename(destination)
    print('Preserved',reason)
