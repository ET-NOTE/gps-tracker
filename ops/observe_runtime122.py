"""Bounded read-only VPS capacity inventory. No query text or credentials."""
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import time
import urllib.request


def run(*args):
    return subprocess.check_output(args, text=True, timeout=15).strip()


def sql(query):
    query = "SET statement_timeout='5s'; SET default_transaction_read_only=on; SELECT COALESCE(json_agg(t),'[]'::json) FROM (" + query + ') t'
    return json.loads(run('sudo', '-n', '-u', 'postgres', 'psql', '-XqAt', '-d', 'gps_tracker', '-v', 'ON_ERROR_STOP=1', '-c', query))


def unit_state():
    result = {}
    for line in run('systemctl', 'list-units', '--type=service', '--state=running', '--no-legend', '--plain').splitlines():
        unit = line.split()[0]
        result[unit] = dict(x.split('=', 1) for x in run('systemctl', 'show', unit, '-p',
            'MemoryCurrent,MemoryMax,MemorySwapMax,ControlGroup,NRestarts,ActiveEnterTimestamp,CPUQuotaPerSecUSec').splitlines())
    return result


def main():
    result = dict(at=datetime.now(timezone.utc).isoformat(), read_only=True, cpu_count=run('nproc'),
        disk=run('df', '-B1', '/'), swap=Path('/proc/swaps').read_text(),
        settings=sql("SELECT name,setting,unit FROM pg_settings WHERE name IN ('max_connections','superuser_reserved_connections','shared_buffers','work_mem','max_parallel_workers_per_gather','temp_tablespaces','temp_file_limit','effective_cache_size') ORDER BY name"),
        roles=sql('SELECT rolname,rolsuper,rolconnlimit FROM pg_roles WHERE rolcanlogin ORDER BY rolname'),
        databases=sql('SELECT datname,datconnlimit FROM pg_database WHERE datallowconn ORDER BY datname'),
        schema=sql('SELECT max(version) version FROM _sqlx_migrations WHERE success'),
        units_before=unit_state(), samples=[])
    for _ in range(12):
        result['samples'].append(dict(at=datetime.now(timezone.utc).isoformat(),
            memory=Path('/proc/meminfo').read_text(), cpu=Path('/proc/stat').read_text().splitlines()[0],
            memory_pressure=Path('/proc/pressure/memory').read_text(), io_pressure=Path('/proc/pressure/io').read_text(),
            diskstats=Path('/proc/diskstats').read_text(),
            connections=sql("SELECT datname,usename,backend_type,state,count(*) connections FROM pg_stat_activity WHERE pid<>pg_backend_pid() GROUP BY datname,usename,backend_type,state ORDER BY datname,usename,backend_type,state"),
            db_io=sql('SELECT datname,xact_commit,xact_rollback,blks_read,blks_hit,temp_bytes,blk_read_time,blk_write_time FROM pg_stat_database WHERE datname IS NOT NULL')))
        time.sleep(5)
    result['units_after'] = unit_state()
    with urllib.request.urlopen('http://127.0.0.1:3040/gps-tracker/health', timeout=5) as response:
        result['health'] = json.load(response)
    result['changed_service_lifetimes'] = [name for name, state in result['units_before'].items()
        if name not in result['units_after'] or any(state[k] != result['units_after'][name][k]
            for k in ('NRestarts', 'ActiveEnterTimestamp'))]
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
