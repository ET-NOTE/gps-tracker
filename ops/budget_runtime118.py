"""Calculate admission constraints from read-only inventory, not observed averages.

No configuration is applied. Unknown role/service caps remain a deployment block.
"""
import json
from pathlib import Path
import sys


def assess(data):
    settings = {s['name']: s for s in data['settings']}
    max_connections = int(settings['max_connections']['setting'])
    reserved = int(settings['superuser_reserved_connections']['setting'])
    # 117 code: query=10, privacy leases=16, cancellation=2. Single API only.
    gps = 28
    maintenance = 4  # proposed operator/migration/monitoring headroom; not measured usage
    other_peak = max(sum(r['connections'] for r in s['connections']
                         if r['backend_type'] == 'client backend' and r['usename'] != 'gps_tracker_app')
                     for s in data['samples'])
    uncapped_roles = [r['rolname'] for r in data['roles']
                      if not r['rolsuper'] and r['rolname'] != 'gps_tracker_app' and r['rolconnlimit'] < 0]
    other_units = {k: int(v['MemoryCurrent']) for k, v in data['units'].items()
                   if k not in ('postgresql@14-main.service', 'gps-tracker-api.service')
                   and v['MemoryCurrent'].isdigit()}
    meminfo = dict(line.split(':', 1) for line in data['samples'][0]['memory'].splitlines())
    total = int(meminfo['MemTotal'].split()[0]) * 1024
    other_observed = sum(other_units.values())
    # tmpfs data is charged within DB MemoryMax, not an extra 320 MiB here.
    pg_max, api_max, os_margin = 1500*1024**2, 550*1024**2, 512*1024**2
    sb = settings['shared_buffers']
    assert sb['unit'] == '8kB', 'unknown shared_buffers unit; refuse guess'
    unbounded_memory = sorted(k for k in other_units if data['units'][k]['MemoryMax'] == 'infinity')
    return {'read_only': True, 'production_admission_passed': False,
        'connections': {'server_max': max_connections, 'superuser_reserved': reserved,
            'single_api_max': gps, 'maintenance_proposed': maintenance,
            'remaining_other_budget': max_connections-reserved-gps-maintenance,
            'other_clients_observed_peak': other_peak, 'uncapped_other_login_roles': uncapped_roles,
            'observed_clients_are_not_maxima': True},
        'memory': {'physical_bytes': total, 'db_proposed_cap': pg_max, 'api_proposed_cap': api_max,
            'other_running_service_observed_bytes': other_observed, 'os_proposed_margin': os_margin,
            'proposed_plan_bytes': pg_max+api_max+other_observed+os_margin,
            'plan_shortfall_bytes': max(0, pg_max+api_max+other_observed+os_margin-total),
            'unbounded_other_units': unbounded_memory,
            'tmpfs_included_in_db_cap': True, 'observed_other_memory_is_not_reserved_or_peak': True,
            'antivirus_scan_extra_not_reserved': 675*1024**2,
            'production_shared_buffers_bytes': int(sb['setting'])*8192},
        'decision': 'Keep single API; do not activate protected candidate on current shared host without bounded budgets and combined rehearsal.',
        'alternatives': {'bounded_tmpfs': 'rehearsed filesystem choice, conditional on RAM budget; never swap-backed',
            'ephemeral_encrypted_disk': 'not selected or installed; would still require swap/core protection, encrypted fallback, key lifecycle and storage-I/O rehearsal',
            'host_isolation_or_capacity': 'recommended if other projects cannot commit finite caps; sizing requires full shared workload, not this snapshot'},
        'production_changes': False}


if __name__ == '__main__':
    print(json.dumps(assess(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))), indent=2))
