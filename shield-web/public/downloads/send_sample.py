#!/usr/bin/env python3
"""Synthetic Shield telemetry. Use a dedicated test device, never a real tracker ID.

Python 3.10+, no packages. Required environment: SHIELD_DEVICE_UID, SHIELD_DEVICE_KEY.
Optional SHIELD_URL (default https://shield.serial.kr), --count 10, --interval 15.
"""
import argparse
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--count', type=int, default=10)
    parser.add_argument('--interval', type=int, default=15)
    args = parser.parse_args()
    if not 1 <= args.count <= 10000 or not 15 <= args.interval <= 3600:
        parser.error('count: 1..10000, interval: 15..3600 seconds')
    origin = os.environ.get('SHIELD_URL', 'https://shield.serial.kr').rstrip('/')
    target = urllib.parse.urlsplit(origin)
    if target.path or target.query or target.fragment or target.username or target.password:
        parser.error('SHIELD_URL must contain only scheme, host and optional port')
    if not (target.scheme == 'https' or (target.scheme == 'http' and target.hostname in ('localhost','127.0.0.1'))):
        parser.error('HTTPS required except for a loopback preview')
    uid, key = os.environ.get('SHIELD_DEVICE_UID',''), os.environ.get('SHIELD_DEVICE_KEY','')
    if not uid or len(key) != 64:
        parser.error('Set SHIELD_DEVICE_UID and the 64-character SHIELD_DEVICE_KEY')
    started = time.monotonic()
    for batch in range(args.count):
        now = int(time.time())
        points = []
        for i in range(6):
            angle = (batch*6+i)/60
            points.append([now-10+i*2,round((37.5665+math.sin(angle)*0.0005)*1e6),round((126.978+math.cos(angle)*0.0006)*1e6),8])
        payload = {'shield_v':2,'device_uid':uid,'build_tag':'shield-synthetic-example-v1',
                   'ts':int(time.monotonic()-started),'csq':20,'reg':5,'diag':{'pv_mv':3300,'gnss':1},'points':points,
                   'sensors':[{'at':now,'temp_c':round(24+math.sin(batch/8),1),'hum_pct':round(58+math.cos(batch/8)*2,1)}]}
        encoded = json.dumps(payload,separators=(',',':')).encode()
        # Retry the same sample/UTC, not a newly generated measurement.
        for attempt in range(3):
            request = urllib.request.Request(origin+'/ingest/shield',data=encoded,headers={'Content-Type':'application/json','X-Device-Key':key})
            try:
                with urllib.request.urlopen(request,timeout=20) as response:
                    result = json.load(response)
                print(f'{batch+1}/{args.count}: accepted={result.get("accepted")} duplicate={result.get("duplicate")}',flush=True)
                break
            except urllib.error.HTTPError as error:
                if error.code < 500 and error.code != 429:
                    raise SystemExit(f'Upload rejected ({error.code}). Check registration, device key and PC clock.') from None
                if attempt == 2:
                    raise SystemExit(f'Upload failed ({error.code}); stopped.') from None
            except (urllib.error.URLError,TimeoutError):
                if attempt == 2:
                    raise SystemExit('Network unavailable; stopped without skipping samples.') from None
            time.sleep(2 ** attempt)
        if batch+1 < args.count:
            time.sleep(args.interval)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nStopped.')
