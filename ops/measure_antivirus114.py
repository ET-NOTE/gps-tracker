#!/usr/bin/env python3
"""Measure real bounded job; stop only this job on low memory or unhealthy GPS."""
import argparse
import datetime
import json
from pathlib import Path
import statistics
import subprocess
import time
import urllib.request


def props(unit):
    p = subprocess.run(['systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'Result', '-p', 'ControlGroup', '-p', 'MemoryCurrent', '-p', 'MemoryPeak', '-p', 'CPUUsageNSec', '-p', 'ExecMainStatus'], text=True, capture_output=True, check=True)
    return dict(line.split('=', 1) for line in p.stdout.splitlines() if '=' in line)


def system_sample():
    mem = dict((line.split(':')[0], int(line.split()[1])) for line in Path('/proc/meminfo').read_text().splitlines())
    start = time.monotonic()
    try:
        with urllib.request.urlopen('http://127.0.0.1:3040/health', timeout=3) as response:
            health = response.status == 200
            response.read()
    except Exception:
        health = False
    return {'available_kib': mem['MemAvailable'], 'swap_used_kib': mem['SwapTotal'] - mem['SwapFree'], 'health_ok': health, 'health_ms': round((time.monotonic() - start) * 1000, 3)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('unit', choices=['gps-antivirus-update.service', 'gps-antivirus-scan@selftest.service', 'gps-antivirus-scan@daily.service'])
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    before = [system_sample() for _ in range(5)]
    assert all(x['health_ok'] for x in before), 'GPS unhealthy before test'
    assert before[-1]['available_kib'] > 650 * 1024, 'Insufficient starting headroom'
    subprocess.run(['systemctl', 'reset-failed', args.unit], capture_output=True)
    subprocess.run(['systemctl', 'start', '--no-block', args.unit], check=True)
    samples = []
    started = time.monotonic()
    bad = 0
    stopped = None
    while time.monotonic() - started < 960:
        p = props(args.unit)
        sample = system_sample()
        sample['seconds'] = round(time.monotonic() - started, 2)
        sample['unit'] = p
        cg = Path('/sys/fs/cgroup' + p.get('ControlGroup', ''))
        for name in ['memory.current', 'memory.peak', 'memory.swap.current', 'memory.events', 'cpu.stat', 'io.stat']:
            try:
                sample[name] = (cg / name).read_text().strip()
            except OSError:
                pass
        samples.append(sample)
        bad = bad + 1 if not sample['health_ok'] or sample['health_ms'] > 2000 else 0
        if p.get('ActiveState') not in {'activating', 'active', 'deactivating'}:
            break
        if sample['available_kib'] < 300 * 1024 or bad >= 2:
            stopped = 'host memory floor / repeated unhealthy GPS'
            subprocess.run(['systemctl', 'stop', args.unit], check=True)
            break
        if len(samples) % 10 == 0:
            print(json.dumps({'elapsed': sample['seconds'], 'available_mib': round(sample['available_kib']/1024), 'job_mib': round(int(sample.get('memory.current', '0'))/1024**2), 'health_ms': sample['health_ms']}), flush=True)
        time.sleep(1)
    else:
        stopped = 'measurement timeout'
        subprocess.run(['systemctl', 'stop', args.unit], check=True)
    health_times = sorted(x['health_ms'] for x in samples)
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'unit': args.unit, 'guard_stopped': stopped, 'final': props(args.unit), 'baseline': before, 'duration_seconds': round(time.monotonic()-started, 2), 'sample_peak_cgroup_mib': round(max([int(x.get('memory.current', '0')) for x in samples] or [0])/1024**2, 2), 'minimum_available_mib': round(min(x['available_kib'] for x in samples)/1024, 2), 'health_failures': sum(not x['health_ok'] for x in samples), 'health_p95_ms': health_times[min(len(health_times)-1, int(len(health_times)*.95))], 'samples': samples}
    path = Path(args.output)
    path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k:v for k,v in report.items() if k not in {'samples','baseline'}}), flush=True)


if __name__ == '__main__':
    main()
