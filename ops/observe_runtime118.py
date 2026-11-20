"""Read-only shared-host inventory; never log queries, environment or credentials."""
import json
import subprocess
import time
from datetime import datetime, timezone


def run(*args):
    return subprocess.check_output(args, text=True, timeout=20).strip()


def sql(query):
    return json.loads(run('sudo', '-n', '-u', 'postgres', 'psql', '-X', '-d', 'gps_tracker',
                          '-At', '-v', 'ON_ERROR_STOP=1', '-c',
                          'SELECT COALESCE(json_agg(t),\'[]\'::json) FROM (' + query + ') t'))


def main():
    result = {'utc': datetime.now(timezone.utc).isoformat(), 'read_only': True}
    result['settings'] = sql("SELECT name,setting,unit FROM pg_settings WHERE name IN ('max_connections','superuser_reserved_connections','shared_buffers','work_mem','max_parallel_workers_per_gather','temp_tablespaces','temp_file_limit') ORDER BY name")
    result['roles'] = sql('SELECT rolname,rolsuper,rolconnlimit FROM pg_roles WHERE rolcanlogin ORDER BY rolname')
    result['databases'] = sql('SELECT datname,datconnlimit FROM pg_database WHERE datallowconn ORDER BY datname')
    result['schema'] = sql('SELECT max(version) version FROM _sqlx_migrations WHERE success')
    result['units'] = {}
    units = run('systemctl', 'list-units', '--type=service', '--state=running', '--no-legend', '--plain').splitlines()
    for line in units:
        unit = line.split()[0]
        data = run('systemctl', 'show', unit, '-p', 'MemoryCurrent', '-p', 'MemoryMax', '-p', 'MemorySwapMax',
                   '-p', 'ControlGroup', '-p', 'LimitCORE', '-p', 'NRestarts', '-p', 'ActiveEnterTimestamp')
        result['units'][unit] = dict(x.split('=', 1) for x in data.splitlines())
    result['core_pattern'] = run('cat', '/proc/sys/kernel/core_pattern')
    result['swap'] = run('cat', '/proc/swaps')
    result['disk'] = run('df', '-B1', '/')
    result['cgroup_type'] = run('stat', '-fc', '%T', '/sys/fs/cgroup')
    result['samples'] = []
    for _ in range(6):
        result['samples'].append({'utc': datetime.now(timezone.utc).isoformat(),
            'memory': run('cat', '/proc/meminfo'),
            'connections': sql("SELECT datname,usename,backend_type,state,count(*) connections FROM pg_stat_activity WHERE pid<>pg_backend_pid() GROUP BY datname,usename,backend_type,state ORDER BY datname,usename,backend_type,state"),
            'pressure': run('cat', '/proc/pressure/memory')})
        time.sleep(5)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
