"""Admission arithmetic, distinct from measured utilization or capacity claims."""
import json
from pathlib import Path
import sys

MIB = 1024**2


def assess(data):
    settings = {x['name']: x for x in data['settings']}
    memory = dict(line.split(':',1) for line in data['samples'][0]['memory'].splitlines())
    physical = int(memory['MemTotal'].split()[0])*1024
    other = {k:int(v['MemoryCurrent']) for k,v in data['units_before'].items()
        if k not in ('postgresql@14-main.service','gps-tracker-api.service') and v['MemoryCurrent'].isdigit()}
    role_peaks = {}
    for sample in data['samples']:
        counts = {}
        for r in sample['connections']:
            if r['backend_type'] == 'client backend':
                counts[r['usename']] = counts.get(r['usename'],0)+r['connections']
        for name,n in counts.items():role_peaks[name]=max(n,role_peaks.get(name,0))
    other_peak=max(sum(r['connections'] for r in sample['connections']
        if r['backend_type']=='client backend' and r['usename']!='gps_tracker_app') for sample in data['samples'])
    slots=int(settings['max_connections']['setting'])
    reserved=int(settings['superuser_reserved_connections']['setting'])
    profiles={
        'dedicated_gps_4g': dict(nominal_host_mib=4096,experiment_container_mib=3584,gps_aggregate_mib=3328,other_projects_mib=0,av_pressure_cap_mib=0,os_reserve_mib=512),
        'bounded_shared_6g': dict(nominal_host_mib=6144,experiment_container_mib=5632,gps_aggregate_mib=3328,other_projects_mib=1024,av_pressure_cap_mib=675,os_reserve_mib=512),
    }
    for p in profiles.values():
        p['reserved_mib']=p['gps_aggregate_mib']+p['other_projects_mib']+p['av_pressure_cap_mib']+p['os_reserve_mib']
        p['unassigned_mib']=p['nominal_host_mib']-p['reserved_mib']
        p['finite_arithmetic_fits']=p['unassigned_mib']>=0
        p['production_approved']=False
    sb=settings['shared_buffers'];assert sb['unit']=='8kB'
    return dict(observed_at=data['at'],read_only=True,production_admission=False,
        production=dict(physical_mib=physical/MIB,cpu=data['cpu_count'],
            shared_buffers_mib=int(sb['setting'])*8192/MIB,
            other_service_snapshot_mib=sum(other.values())/MIB,
            other_clients_peak=other_peak,role_observed_peaks=role_peaks,
            server_connections=slots,superuser_reserved=reserved,
            remaining_for_others_with_api28_and_ops4=slots-reserved-28-4,
            uncapped_roles=[x['rolname'] for x in data['roles'] if not x['rolsuper'] and x['rolconnlimit']<0],
            uncapped_other_services=[k for k in other if data['units_before'][k]['MemoryMax']=='infinity'],
            current_shortfall_mib=max(0,3328+sum(other.values())/MIB+675+512-physical/MIB),
            observation_is_not_peak_or_reservation=True),
        profiles=profiles,trial_gps_components_mib=dict(db=1408,api=640,pdf=896,one_cleanup=128,tls_proxy=64,sum=3136,aggregate=3328),
        trial_connections=dict(server=64,admin_reserved=3,single_api=28,cleanup=2,operations=2,shared_other=24,unassigned=5),
        trial_io=dict(cpu_quota_cores=2,read_write_bps_each=8*1024**2,read_write_iops_each=200,
            build_host_nvme_not_vps_disk=True),
        constraints=[
            'Do not apply either future profile to the current3GiB shared server.',
            'Dedicated profile excludes AV scanning alongside normal workload; schedule an exclusive maintenance window or add its675MiB budget.',
            'Shared profile requires all other services jointly bounded to1024MiB and DB clients jointly24; simulator does not prove their real workload fits.',
            'Recovery/migration jobs are exclusive maintenance workloads;128MiB cleanup proof does not qualify full restore at that cap.',
            'Finite caps, no swap and clean synthetic tests do not replace host-specific long-duration acceptance.'
        ])


if __name__=='__main__':
    print(json.dumps(assess(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))),indent=2))
