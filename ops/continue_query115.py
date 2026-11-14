"""Bounded dual-API and constrained-I/O phases on query115 synthetic resources."""
import json
import subprocess
import time
import benchmark_location115 as b

single = json.loads((b.OUT / 'single.json').read_text())
assert single['requested_seconds'] == 900 and not single['errors']
b.start(b.API2)
b.load('dual', 300, 16, dual=True)

# Recreate only this disposable DB container, keeping its labelled synthetic
# volume. This is an artificial disk stress test, NOT a VPS I/O measurement.
for name in [b.API2, b.API]:
    b.ip(name)
    (b.OUT / (name + '-before-io.log')).write_bytes(subprocess.check_output(['docker', 'logs', name], stderr=subprocess.STDOUT))
    b.run('docker', 'rm', '-f', name, stdout=subprocess.DEVNULL)
db = b.info('container', b.DB)
assert b.info('volume', b.VOL)['Labels']['gps.query115'] == 'synthetic'
assert b.ip(b.DB) and len(db['Mounts']) == 1 and db['Mounts'][0]['Name'] == b.VOL
b.run('docker', 'stop', '-t', '30', b.DB, stdout=subprocess.DEVNULL)
b.run('docker', 'rm', b.DB, stdout=subprocess.DEVNULL)
device = '/dev/nvme0n1'  # io.stat accounts the parent block device (259:0).
b.run('docker', 'run', '-d', '--name', b.DB, '--network', b.NET, '--network-alias', 'query115-db',
      '--cpus=2', '--memory=1500m', '--pids-limit=256',
      '--device-read-bps', device + ':8mb', '--device-write-bps', device + ':8mb',
      '--device-read-iops', device + ':200', '--device-write-iops', device + ':200',
      '-v', b.VOL + ':/var/lib/postgresql/data',
      '-e', 'POSTGRES_PASSWORD=query115-test-only', '-e', 'POSTGRES_DB=gps_query115_test',
      db['Config']['Image'], *db['Config']['Cmd'], stdout=subprocess.DEVNULL)
for _ in range(60):
    try:
        if b.sql('SELECT 1') == [(1,)]: break
    except Exception: pass
    time.sleep(1)
else: raise AssertionError('limited DB readiness')
cfg = b.info('container', b.DB)['HostConfig']
b.save('io-limits', {k: cfg[k] for k in ['BlkioDeviceReadBps','BlkioDeviceWriteBps','BlkioDeviceReadIOps','BlkioDeviceWriteIOps']})
b.save('io-cgroup', {'limits': subprocess.check_output(['docker','exec',b.DB,'cat','/sys/fs/cgroup/io.max'],text=True),
                     'before': subprocess.check_output(['docker','exec',b.DB,'cat','/sys/fs/cgroup/io.stat'],text=True)})
b.start()
b.run('docker', 'restart', b.PROXY, stdout=subprocess.DEVNULL)
b.load('io-limited', 300, 8)
b.save('io-cgroup-after', {'after': subprocess.check_output(['docker','exec',b.DB,'cat','/sys/fs/cgroup/io.stat'],text=True)})
