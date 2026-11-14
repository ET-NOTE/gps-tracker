"""Derive voltage-to-runtime anchors from the recorded absolute-time evidence.
Run from the repository root. Does not change voltage calibration or SOC policy.
"""
import datetime as dt
import hashlib
import json
from pathlib import Path

source = Path('gps-tracker-api/battery-percentage-evidence.json')
evidence = json.loads(source.read_text(encoding='utf-8'))
start = dt.datetime.fromisoformat(evidence['start_reference'])
end = dt.datetime.fromisoformat(evidence['end_reference'])
anchors = []
for target in evidence['targets']:
    # The SOC convention forces 100% to 4.20 V; runtime uses the observed full
    # starting voltage instead, so it remains tied to the actual time record.
    mv = round(target['scope_median_mv']) if target['percent'] == 100 else target['mv']
    seconds = round((end - dt.datetime.fromisoformat(target['center'])).total_seconds())
    anchors.append([mv, seconds])
assert anchors[0] == [2600, 0]
assert all(a[0] < b[0] and a[1] < b[1] for a, b in zip(anchors, anchors[1:]))
result = dict(
    version='520211-continuous-runtime-20261014-v1',
    reference_start=start.isoformat(), reference_end=end.isoformat(),
    reference_seconds=round((end-start).total_seconds()),
    reference_label='MEGACANON 2개 병렬 · 절전 해제·연속 통신 기준',
    note='충전하지 않고 측정 당시와 같은 부하로 사용할 때의 예상입니다. 배터리 용량·온도·통신·절전에 따라 달라집니다. 최초 포트 분리 시각은 미확인이며, 종료는 사용자가 지정한 저전압 재부팅 구간으로 안전 방전 한계가 아닙니다.',
    external_power_above_mv=4200, stale_after_seconds=300,
    source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
    method='Linear interpolation of calibrated voltage and seconds until the observed endpoint; no rounded-SOC multiplication.',
    curve=anchors,
)
Path('gps-tracker-api/battery-runtime-policy.json').write_text(
    json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'reference_seconds': result['reference_seconds'], 'curve': anchors}))
