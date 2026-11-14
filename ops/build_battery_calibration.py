"""Reproduce the 520211 discharge standard from an immutable measurement snapshot.

Usage: python ops/build_battery_calibration.py SNAPSHOT_DIRECTORY OUTPUT_JSON
This tool does not change telemetry, the running logger, or production policy.
"""
import csv
import datetime as dt
import hashlib
import json
import pathlib
import statistics as st
import sys
from collections import defaultdict

source, output = map(pathlib.Path, sys.argv[1:3])
scope, server = defaultdict(list), defaultdict(list)
cutoff = dt.datetime.fromisoformat('2026-10-12T11:00:00+09:00')

def minute(value):
    return dt.datetime.fromisoformat(value).replace(second=0, microsecond=0)

with (source / 'scope_snapshot.csv').open(encoding='utf-8-sig', newline='') as f:
    for row in csv.DictReader(f):
        scope[minute(row['read_time'])].append(float(row['mean_V']) * 1000)
for row in json.loads((source / 'server_snapshot.json').read_text(encoding='utf-8-sig')):
    if row.get('vbat_mv') is not None and (row.get('device_uptime_s') or 0) >= 120:
        server[minute(row['recorded_at'])].append(row['vbat_mv'])
samples = [(t, st.mean(server[t]), st.mean(values)) for t, values in sorted(scope.items())
           if t >= cutoff and not dt.datetime.fromisoformat('2026-10-14T13:11:00+09:00') <= t < dt.datetime.fromisoformat('2026-10-14T13:15:00+09:00') and len(values) >= 10 and len(server[t]) >= 2]
centers = [2475, 2525, 2575, 2625, 2675, 2725, 2775, 2825, 2875, 2925, 2975, 3050, 3150, 3250,
           3350, 3450, 3550, 3650, 3750, 3850, 3950, 4050, 4125]

def fit(rows):
    bins = []
    for center in centers:
        half = 25 if center < 3000 or center == 4125 else 50
        group = [(raw, physical) for _, raw, physical in rows if center-half <= raw < center+half]
        if not group:
            continue
        raw = round(st.median(r for r, _ in group))
        offset = st.median(p-r for r, p in group)
        bins.append({'raw_mv': raw, 'calibrated_mv': round(raw+offset),
                     'minutes': len(group), 'median_offset_mv': round(offset, 2)})
    assert all(a['raw_mv'] < b['raw_mv'] and a['calibrated_mv'] < b['calibrated_mv']
               for a, b in zip(bins, bins[1:]))
    return bins

def correct(raw, bins):
    if raw <= bins[0]['raw_mv']:
        return raw + bins[0]['calibrated_mv'] - bins[0]['raw_mv']
    for a, b in zip(bins, bins[1:]):
        if raw <= b['raw_mv']:
            return a['calibrated_mv'] + (raw-a['raw_mv'])*(b['calibrated_mv']-a['calibrated_mv'])/(b['raw_mv']-a['raw_mv'])
    return raw + bins[-1]['calibrated_mv'] - bins[-1]['raw_mv']

train = [r for r in samples if r[0].minute % 2]
validation = [r for r in samples if not r[0].minute % 2]
train_bins, bins = fit(train), fit(samples)

def metrics(errors):
    return {'mean_bias_mv': round(st.mean(errors), 2),
            'mean_absolute_error_mv': round(st.mean(map(abs, errors)), 2),
            'p95_absolute_error_mv': round(sorted(map(abs, errors))[int(len(errors)*.95)], 2)}

result = {'standard_device': '520211', 'battery': 'MEGACANON 2 cells parallel',
          'source_sha256': {name: hashlib.sha256((source/name).read_bytes()).hexdigest()
                            for name in ['scope_snapshot.csv', 'server_snapshot.json']},
          'cutoff': cutoff.isoformat(), 'paired_minutes': len(samples),
          'first': samples[0][0].isoformat(), 'last': samples[-1][0].isoformat(),
          'exclusions': 'First 120 seconds of each boot; API deployment window 2026-10-14 13:11..13:15 KST.',
          'method': 'Median scope-minus-ADC offset by ADC bin; linear interpolation. Endpoint offset outside measured range.',
          'limitations': 'Initial 23 minutes excluded; exact USB removal time unknown. Same-minute matching, not simultaneous ADC samples. Scope 20mV sample quantization. Adjacent minute validation shares the same device and discharge; not independent hardware/charging validation.',
          'bins': bins,
          'points': [[b['raw_mv'], b['calibrated_mv']] for b in bins],
          'validation': {'training': 'odd clock minutes', 'held_out': 'even clock minutes',
                         'minutes': len(validation),
                         'raw': metrics([raw-physical for _, raw, physical in validation]),
                         'corrected': metrics([correct(raw, train_bins)-physical for _, raw, physical in validation])}}
output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps({k: result[k] for k in ['paired_minutes', 'points', 'validation']}, ensure_ascii=False))
