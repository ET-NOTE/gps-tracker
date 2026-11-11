"""Read-only fixed-scope production observation; no queries, identities or secrets logged."""
import json
import subprocess
import time
from datetime import datetime, timezone


def command(*args):
    return subprocess.check_output(args, text=True, timeout=15).strip()


def query(sql):
    return command('sudo', '-n', '-u', 'postgres', 'psql', '-X', '-d', 'gps_tracker',
                   '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql)


def observe():
    start = time.monotonic()
    result = {'started_utc': datetime.now(timezone.utc).isoformat(), 'read_only': True,
              'method': '180 seconds, 5 second interval; no artificial load or cache eviction'}
    result['storage'] = json.loads(command('lsblk', '-J', '-o', 'NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS'))
    result['swap'] = command('cat', '/proc/swaps')
    result['disk'] = command('df', '-B1', '/')
    result['db_settings'] = query("SELECT name||'='||setting||COALESCE(unit,'') FROM pg_settings WHERE name IN ('server_version','max_connections','shared_buffers','work_mem','temp_tablespaces','temp_file_limit','track_io_timing') ORDER BY name")
    result['tablespaces'] = query("SELECT spcname||'|'||pg_tablespace_location(oid) FROM pg_tablespace ORDER BY 1")
    result['role_settings'] = query("SELECT r.rolname||'|'||s.setconfig::text FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname LIKE 'gps%' ORDER BY 1")
    result['schema'] = query('SELECT max(version) FROM _sqlx_migrations WHERE success')
    result['units'] = {}
    for unit in ['gps-tracker-api', 'postgresql@14-main']:
        props = command('systemctl', 'show', unit, '-p', 'ControlGroup', '-p', 'MemoryMax',
                        '-p', 'MemorySwapMax', '-p', 'ActiveState', '-p', 'NRestarts', '-p', 'LimitCORE')
        result['units'][unit] = props
    result['samples'] = []
    for _ in range(36):
        sample = {'elapsed': round(time.monotonic()-start, 3)}
        sample['memory'] = command('cat', '/proc/meminfo')
        sample['io_pressure'] = command('cat', '/proc/pressure/io')
        sample['diskstats'] = command('cat', '/proc/diskstats')
        sample['db_counters'] = query("SELECT temp_bytes||'|'||temp_files||'|'||blk_read_time||'|'||blk_write_time||'|'||deadlocks FROM pg_stat_database WHERE datname=current_database()")
        sample['waits'] = query("SELECT COALESCE(wait_event_type,'none')||'|'||COALESCE(wait_event,'none')||'|'||count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() GROUP BY wait_event_type,wait_event")
        sample['active_counts'] = query("SELECT count(*)||'|'||count(*) FILTER(WHERE state='active')||'|'||count(*) FILTER(WHERE state='idle in transaction') FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")
        result['samples'].append(sample)
        time.sleep(max(0, start + (_+1)*5 - time.monotonic()))
    result['finished_utc'] = datetime.now(timezone.utc).isoformat()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    observe()
