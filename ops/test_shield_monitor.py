"""Exercise the monitor SQL in a disposable, network-isolated PostgreSQL container."""
import json
import pathlib
import subprocess
import time
import uuid

query = (pathlib.Path(__file__).resolve().parents[1] /
         'gps-tracker-api/src/routes/arduino_shield.sql').read_text()
name = 'gps-shield-query-test-' + uuid.uuid4().hex[:10]


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def sql(statement):
    return run(['docker', 'exec', '-i', name, 'psql', '-U', 'postgres', '-At',
                '-v', 'ON_ERROR_STOP=1'], input=statement).stdout.strip()


try:
    run(['docker', 'run', '--rm', '-d', '--network', 'none', '--memory=192m',
         '--cpus=1', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
         'postgres:16-alpine'])
    for attempt in range(60):
        if subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', 'postgres'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(.25)
    else:
        raise RuntimeError('Isolated PostgreSQL failed to start')
    sql('''
      CREATE TABLE devices(id bigint, device_uid text, owner_id bigint, last_seen_at timestamptz);
      CREATE TABLE location_records(device_id bigint, recorded_at timestamptz, source text,
        device_uptime_s integer, fix boolean, sat integer, csq integer, reg integer, raw jsonb);
      INSERT INTO devices VALUES(1,'uno-shield-test',NULL,now()),(2,'private-device',42,now());
      INSERT INTO location_records SELECT 1,now()-n*interval '1 minute','lte_gnss',n,false,0,24,5,
        '{"diag":{"pv_mv":4180},"build_tag":"test","iccid":"secret","lat":37}'::jsonb
        FROM generate_series(1,103) n;
      INSERT INTO location_records VALUES
        (2,now(),'lte_gnss',1,true,8,24,5,'{"build_tag":"private"}'),
        (1,now()-interval '25 hours','lte_gnss',1,false,0,24,5,'{}'),
        (1,now(),'phone',1,true,8,24,5,'{}');
    ''')
    statement = query.replace('$1', "'uno-shield-test'") + ';'
    value = json.loads(sql(statement))
    assert value['available'] and value['count_24h'] == 103 and len(value['items']) == 100
    assert all(r['pv_mv'] == 4180 and r['build_tag'] == 'test' for r in value['items'])
    assert not any(k in value['items'][0] for k in ('raw', 'iccid', 'lat', 'lng', 'owner_id'))
    sql("UPDATE location_records SET raw='{}' WHERE device_id=1;")
    assert all(r['pv_mv'] is None for r in json.loads(sql(statement))['items'])
    sql("UPDATE location_records SET raw='{\"diag\":{\"pv_mv\":\"999999999999999999999999\"}}' WHERE device_id=1;")
    assert all(r['pv_mv'] is None for r in json.loads(sql(statement))['items'])
    sql('UPDATE devices SET owner_id=123 WHERE id=1;')
    value = json.loads(sql(statement))
    assert not value['available'] and value['last_seen_at'] is None
    assert value['count_24h'] == 0 and value['items'] == []
    print('Shield monitor SQL passed: fixed UID, owner guard, 24h window, 100-row limit, safe fields and malformed PV.')
finally:
    subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)
