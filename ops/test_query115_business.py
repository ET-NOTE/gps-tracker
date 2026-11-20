"""Synthetic Fleet read admission/cancellation and consent boundaries over TLS."""
import http.client
import json
import socket
import time
import benchmark_location115 as b

client = b.Client()
data = b.fixture(); device = data['devices'][4]; did, uid = device['device_id'], device['user_id']
base = '/gps-tracker/api/v1/corporate'
routes = b.routes(did)[3:] + [
    ('fleet_stats', base + '/fleet/trip-stats?' + b.PERIOD),
    ('vehicle_stats', base + '/vehicle-stats?month=2026-10'),
    ('terminals', base + '/terminals?' + b.MONTH)]
report = []
def record(name, **kw):
    report.append({'test': name, **kw}); b.save('business-tests', report); print(report[-1], flush=True)
def active():
    return b.sql("SELECT pid,state,wait_event_type FROM pg_stat_activity WHERE application_name LIKE 'gps-read-%'")
def until(fn):
    t = time.monotonic()
    while time.monotonic() - t < 8:
        if fn(): return time.monotonic() - t
        time.sleep(.025)
    raise AssertionError('read cleanup deadline')
def pending(path):
    c = http.client.HTTPSConnection(client.host, 8443, context=client.tls, timeout=30)
    c.request('GET', path, headers={'Authorization': 'Bearer ' + b.token(uid)})
    return c
for name, path in routes:
    status, body, _, elapsed = client.get(path, uid)
    assert status == 200, (name, status, body[:300])
    if name.endswith('stats'):
        rows = json.loads(body)['per_device']; assert len(rows) == 4
        assert all(row['fix_count'] == 89280 for row in rows)
    if name == 'terminals':
        assert len(json.loads(body)) == 4 and all(row['last_lat'] is not None for row in json.loads(body))
    record(name + ' response', status=status, seconds=elapsed, bytes=len(body))
    lock = b.connect(); lock.autocommit = False
    first = second = None
    try:
        with lock.cursor() as cur: cur.execute('LOCK TABLE location_records IN ACCESS EXCLUSIVE MODE')
        first, second = pending(path), pending(path)
        until(lambda: len(active()) == 2 and all(r[2] == 'Lock' for r in active()))
        status, body, headers, _ = client.get(path, uid)
        assert status == 429 and json.loads(body)['code'] == 'location_read_busy' and headers['retry-after'] == '2'
        assert client.get('/gps-tracker/health')[0] == 200
        began = time.monotonic()
        for c in (first, second): c.sock.shutdown(socket.SHUT_RDWR); c.close()
        until(lambda: not active())
        record(name + ' shared admission and TLS disconnect', status=429, cancel_seconds=time.monotonic()-began)
    finally:
        for c in (first, second):
            if c: c.close()
        lock.rollback(); lock.close()

b.sql('INSERT INTO privacy_processing_controls(user_id,use_paused) VALUES(%s,true) ON CONFLICT(user_id) DO UPDATE SET use_paused=true', (uid,))
try:
    codes = [client.get(path, uid)[0] for _, path in routes]
    assert all(c in (403, 423) for c in codes), codes
    record('owner use pause', statuses=codes)
finally:
    b.sql('UPDATE privacy_processing_controls SET use_paused=false WHERE user_id=%s', (uid,))
mapping = next(x for x in json.loads((b.OUT/'mappings.json').read_text()) if x['device'] == did)
b.sql("UPDATE location_subject_mappings SET status='revoked' WHERE id=%s", (mapping['mapping'],))
try:
    status, body, _, _ = client.get(b.routes(did)[3][1], uid)
    assert status == 200 and json.loads(body) == []
    status, body, _, _ = client.get(base+'/fleet/trip-stats?'+b.PERIOD, uid)
    assert status == 200 and all(r['device_id'] != did for r in json.loads(body)['per_device'])
    record('withdrawn subject excluded', trips_empty=True, stats_excluded=True)
finally:
    # Restore this disposable fixture only, not a product reconsent operation.
    b.sql("UPDATE location_subject_mappings SET status='confirmed' WHERE id=%s", (mapping['mapping'],))
status, body, _, _ = client.get(b.routes(did)[3][1], uid)
assert status == 200 and len(json.loads(body)) == 31
record('fixture restored', trips=31)
assert not active()
assert b.sql("SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%'") == [(0,)]
record('no residual reads or transactions', passed=True)
