"""Fit an estimated voltage percentage curve to the user-selected test endpoint.
Usage: python ops/refit_battery_percentage.py SNAPSHOT_DIRECTORY OUTPUT_JSON
Relative elapsed time is a repeatable display convention for this test load,
not measured charge capacity. Raw telemetry is never changed.
"""
import csv
import datetime as dt
import json
import pathlib
import statistics as st
import sys

source, output = map(pathlib.Path, sys.argv[1:3])
start = dt.datetime.fromisoformat('2026-10-12T10:45:00+09:00')
end = dt.datetime.fromisoformat('2026-10-14T13:48:00+09:00')
with (source / 'scope_snapshot.csv').open(encoding='utf-8-sig', newline='') as file:
    rows = list(csv.DictReader(file))
    samples = [(dt.datetime.fromisoformat(r['read_time']), float(r['mean_V']) * 1000) for r in rows]
targets = []
for percent in [0, 1, 2, 3, 5, 10, 15, 20, 25, 40, 50, 60, 75, 80, 90, 95, 100]:
    when = start + (end-start) * (1-percent/100)
    values = [v for t, v in samples if abs((t-when).total_seconds()) <= 150]
    measured = st.median(values)
    mv = 2600 if percent == 0 else 4200 if percent == 100 else round(measured/5)*5
    targets.append({'percent': percent, 'mv': mv, 'scope_median_mv': round(measured, 2),
                    'center': when.isoformat(), 'samples': len(values)})

# Pool adjacent reversals caused by load/recovery; retain a monotonic curve.
blocks = []
for target in targets:
    blocks.append([target])
    while len(blocks) > 1 and st.mean(t['mv'] for t in blocks[-2]) >= st.mean(t['mv'] for t in blocks[-1]):
        blocks[-2:] = [blocks[-2] + blocks[-1]]
curve = [[round(st.mean(t['mv'] for t in group)), round(st.mean(t['percent'] for t in group))]
         for group in blocks]
assert curve[0] == [2600, 0] and curve[-1] == [4200, 100]
assert all(a[0] < b[0] and a[1] < b[1] for a, b in zip(curve, curve[1:]))
zero_rows = [r for r in rows if r['read_time'].startswith('2026-10-14T13:48:')]
zero_values = [float(r['mean_V'])*1000 for r in zero_rows]
result = {'version': 'gps-1s-standard-520211-20261014-final', 'standard_device': '520211',
          'user_zero_mv': 2600, 'zero_reference_window': ['2026-10-14T13:48:00+09:00', '2026-10-14T13:49:00+09:00'],
          'zero_window_mean_mv': round(st.mean(zero_values), 2), 'zero_window_median_mv': round(st.median(zero_values), 2),
          'zero_window_snapshot_min_mv': round(min(float(r['min_V'])*1000 for r in zero_rows)),
          'reboot_evidence': {'before': '2026-10-14T13:47:52.644074+09:00', 'before_uptime_s': 2566,
                              'after': '2026-10-14T13:48:35.998485+09:00', 'after_uptime_s': 23, 'reset_cause': 'BROWNOUT'},
          'start_reference': start.isoformat(), 'end_reference': end.isoformat(),
          'limitations': 'User-selected zero following repeated crash beeps; not the first brownout (also detected at 13:05). Zero is not a recommended safety cutoff or electrochemical empty. Exact initial USB removal unknown. Elapsed-time fraction at this load is not charge counting or guaranteed remaining runtime.',
          'method': 'Five-minute physical-voltage medians at relative elapsed-time fractions; rounded to 5mV, adjacent reversals pooled. User zero 2.60V, display full convention 4.20V.',
          'targets': targets, 'curve': curve}
output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'curve': curve, 'source': str(source)}, ensure_ascii=False))
