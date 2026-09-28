#!/usr/bin/env python3
"""Check the enrolled real Shield; optionally associate its locally read SIM.

No provider, recharge or payment API is called. Private enrollment and hardware
files must already exist in the mode-0700 operator directory, never in Git.
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import urllib.parse

ROOT = Path('/home/mmm/shield-deploy')
spec = importlib.util.spec_from_file_location('checks', ROOT/'verify-production.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--attach-sim', action='store_true')
    p.add_argument('--require-fix', action='store_true')
    args = p.parse_args()
    assert os.geteuid() == 0
    v = json.loads((ROOT/'bench-enrollment.json').read_text())
    device, user = int(v['device_id']), int(v['user_id'])
    client = c.Client()
    assert client.call('/api/auth/login', {'email': v['email'], 'password': v['password']})[0] == 200
    try:
        assert client.call('/api/auth/session')[1]['id'] == user
        owned = client.call('/api/devices')[1]
        assert any(d['id'] == device and d['device_uid'] == v['device']['device_uid'] for d in owned)
        if args.attach_sim:
            iccids = set(json.loads((ROOT/'hardware-identifiers.json').read_text())['iccid'])
            assert len(iccids) == 1
            iccid = next(iter(iccids))
            assert re.fullmatch(r'\d{19,20}', iccid)
            # Conflicting SIMs or ownership stop the update. No GPS rows change.
            updated = c.pg(f"UPDATE devices SET sim_iccid='{iccid}' WHERE id={device} AND owner_id={user} AND (sim_iccid IS NULL OR sim_iccid='{iccid}') RETURNING id;")
            assert updated.splitlines() == [str(device), 'UPDATE 1']
            print('SIM association verified; last four: '+iccid[-4:])
        now = dt.datetime.now(dt.timezone.utc)
        period = urllib.parse.urlencode({'since': (now-dt.timedelta(hours=24)).isoformat(), 'until': now.isoformat()})
        status, readings, _ = client.call(f'/api/devices/{device}/readings?{period}')
        assert status == 200 and readings['items']
        latest = readings['items'][0]
        assert latest['build_tag'] == 'shield-tls-20260928-v12'
        age = (now-dt.datetime.fromisoformat(latest['received_at'].replace('Z', '+00:00'))).total_seconds()
        assert 0 <= age < 720, 'No fresh real-device report'
        status, locations, _ = client.call(f'/api/devices/{device}/locations?{period}')
        assert status == 200
        valid = [r for r in locations['items'] if r['fix'] and r['lat'] is not None and r['lng'] is not None]
        if args.require_fix:
            assert valid, 'Real GNSS location still pending'
        result = {
            'email': v['email'], 'device_id': device, 'user_id': user,
            'latest_report': latest['received_at'], 'report_age_seconds': round(age),
            'build': latest['build_tag'], 'visible_reports': len(readings['items']),
            'valid_coordinates': len(valid),
            'latest_fix_time': valid[0]['recorded_at'] if valid else None,
            'legacy_last_seen': c.pg("SELECT last_seen_at FROM devices WHERE id=3015 AND device_uid='uno-shield-test';", 'gps_tracker'),
        }
        (ROOT/'bench-verification.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    finally:
        assert client.call('/api/auth/logout', {})[0] == 200


if __name__ == '__main__':
    main()
