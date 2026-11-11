"""Remove artificial limits from only the disposable query115 DB, then verify reads."""
import json
import subprocess
import time
import benchmark_location115 as b

r = json.loads((b.OUT / 'io-limited.json').read_text())
assert r['requested_seconds'] == 300
assert b.info('network', b.NET)['Internal']
assert b.info('volume', b.VOL)['Labels']['gps.query115'] == 'synthetic'
b.ip(b.API)
(b.OUT / 'api-io-limited.log').write_bytes(subprocess.check_output(['docker', 'logs', b.API], stderr=subprocess.STDOUT))
b.run('docker', 'rm', '-f', b.API, stdout=subprocess.DEVNULL)
db = b.info('container', b.DB)
assert b.ip(b.DB) and len(db['Mounts']) == 1 and db['Mounts'][0]['Name'] == b.VOL
b.run('docker', 'stop', '-t', '30', b.DB, stdout=subprocess.DEVNULL)
b.run('docker', 'rm', b.DB, stdout=subprocess.DEVNULL)
b.run('docker', 'run', '-d', '--name', b.DB, '--network', b.NET, '--network-alias', 'query115-db',
      '--cpus=2', '--memory=1500m', '--pids-limit=256', '-v', b.VOL + ':/var/lib/postgresql/data',
      '-e', 'POSTGRES_PASSWORD=query115-test-only', '-e', 'POSTGRES_DB=gps_query115_test',
      db['Config']['Image'], *db['Config']['Cmd'], stdout=subprocess.DEVNULL)
for _ in range(60):
    try:
        if b.sql('SELECT 1') == [(1,)]: break
    except Exception: pass
    time.sleep(1)
else: raise AssertionError('recovery DB readiness')
b.start()
b.run('docker', 'restart', b.PROXY, stdout=subprocess.DEVNULL)
for n in ['probe.json', 'probe.log']:
    (b.OUT / n).rename(b.OUT / ('initial-' + n))
b.probe()
result = json.loads((b.OUT / 'probe.json').read_text())
assert len(result) == 28 and all(x['status'] == 200 for x in result)
b.save('stress-recovery', {'passed': True, 'positive_reads': len(result),
    'limits': subprocess.check_output(['docker', 'exec', b.DB, 'cat', '/sys/fs/cgroup/io.max'], text=True),
    'negative_account_reads': 8, 'schema': b.sql('SELECT max(version) FROM _sqlx_migrations')[0][0],
    'active_reads': b.sql("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'gps-read-%'")[0][0],
    'idle_transactions': b.sql("SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'")[0][0]})
