#!/usr/bin/env python3
"""Bounded, nonresident ClamAV jobs. Never uploads, removes, or repairs a file."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import resource
import re
import signal
import subprocess
import sys
import time

SCOPES = ['api', 'web', 'uploads', 'private-uploads', 'downloads']
INPUT = Path('/run/gps-antivirus-scan/inputs')
LOG = Path('/var/log/gps-antivirus')
STATE = Path('/var/lib/gps-antivirus')
INTERRUPTED = False


def terminate(signum, frame):
    global INTERRUPTED
    INTERRUPTED = True


def now():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).isoformat()


def write(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)


def available_kib():
    return next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))


def bounded_scan(command, output):
    process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT)
    try:
        while process.poll() is None:
            if INTERRUPTED or available_kib() < 300 * 1024:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                return 75, 'interrupted / host available memory below 300MiB'
            time.sleep(1)
        return process.returncode, None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def run_scan(mode):
    os.umask(0o077)
    started = time.monotonic()
    # Bounded diagnostic retention, not a location-use/access evidence ledger.
    for old in LOG.iterdir():
        if re.fullmatch(r'\d{8}T\d{6}Z-(daily|selftest)\.(json|log)', old.name) and old.is_file() and not old.is_symlink() and time.time() - old.stat().st_mtime > 7 * 86400:
            old.unlink()
    report = {'started_at': now(), 'mode': mode, 'scope': SCOPES if mode == 'daily' else ['local harmless EICAR fixture'], 'network': 'disabled by service', 'action': 'report only; no deletion/quarantine', 'skipped': {}, 'scope_files': {}}
    targets = []
    total_bytes = 0
    errors = []
    if mode == 'selftest':
        fixture = STATE / 'selftest-eicar.txt'
        # Standard harmless test string, confined to the scanner's private directory.
        fixture.write_bytes(b'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
        targets = [str(fixture)]
    else:
        for label in SCOPES:
            root = INPUT / label
            if not root.is_dir():
                errors.append('missing scope: ' + label)
                continue
            count = 0
            for directory, dirs, files in os.walk(root, followlinks=False, onerror=lambda error: errors.append(type(error).__name__)):
                for name in list(dirs):
                    if (Path(directory) / name).is_symlink():
                        dirs.remove(name)
                        report['skipped']['symlink'] = report['skipped'].get('symlink', 0) + 1
                for name in files:
                    path = Path(directory) / name
                    try:
                        if path.is_symlink() or not path.is_file():
                            reason = 'nonregular'
                        elif '\n' in str(path) or '\r' in str(path):
                            reason = 'unsupported filename'
                        elif not os.access(path, os.R_OK):
                            reason = 'unreadable'
                        elif path.stat().st_size > 128 * 1024 ** 2:
                            reason = 'over 128MiB'
                        else:
                            targets.append(str(path))
                            total_bytes += path.stat().st_size
                            count += 1
                            continue
                    except OSError:
                        reason = 'changed during enumeration'
                    report['skipped'][reason] = report['skipped'].get(reason, 0) + 1
            report['scope_files'][label] = count
    filelist = STATE / 'files.txt'
    filelist.write_text('\n'.join(targets) + '\n')
    report.update(files_selected=len(targets), bytes_selected=total_bytes, enumeration_errors=errors)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    logfile = LOG / f'{stamp}-{mode}.log'
    command = ['/usr/bin/clamscan', '--infected', '--stdout', '--file-list=' + str(filelist), '--follow-dir-symlinks=0', '--follow-file-symlinks=0', '--cross-fs=no', '--max-filesize=128M', '--max-scansize=256M', '--max-recursion=4', '--max-files=5000', '--max-scantime=60000', '--alert-exceeds-max=yes', '--alert-encrypted=yes', '--tempdir=/tmp']
    marker = Path('/var/lib/clamav/gps-last-update-ok')
    if mode == 'daily' and (not marker.is_file() or time.time() - marker.stat().st_mtime > 72 * 3600):
        errors.append('official signature update not successful within 72 hours')
    if not targets or errors:
        rc = 2
        logfile.write_text('No scan: enumeration incomplete or empty.\n')
    else:
        with logfile.open('w') as output:
            rc, report['guard_stopped'] = bounded_scan(command, output)
    raw = logfile.read_text(errors='replace')
    report['findings'] = []
    for line in raw.splitlines():
        if line.endswith(' FOUND'):
            name, _, signature = line.rpartition(': ')
            report['findings'].append({'file_path_sha256': hashlib.sha256(name.encode()).hexdigest(), 'signature': signature.removesuffix(' FOUND')})
    report['scanner_summary'] = raw.split('----------- SCAN SUMMARY -----------')[-1].strip() if 'SCAN SUMMARY' in raw else ''
    report['scanner_warnings'] = sum(bool(re.search(r'\b(?:warning|error):', line, re.I)) for line in raw.splitlines())
    report.update(finished_at=now(), elapsed_seconds=round(time.monotonic() - started, 3), scanner_exit=rc, scanner_peak_rss_kib=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss, scanner_cpu_seconds=round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_utime + resource.getrusage(resource.RUSAGE_CHILDREN).ru_stime, 3))
    if mode == 'selftest':
        report['passed'] = rc == 1 and any('Eicar' in f['signature'] or 'EICAR' in f['signature'] for f in report['findings'])
        (STATE / 'selftest-eicar.txt').unlink(missing_ok=True)
        result = 0 if report['passed'] else 2
    else:
        report['status'] = 'clear_within_scope' if rc == 0 and not report['skipped'] and not errors and not report['scanner_warnings'] else 'review_required' if rc == 1 else 'incomplete'
        result = 0 if report['status'] == 'clear_within_scope' else 1 if rc == 1 else 2
    filelist.unlink(missing_ok=True)
    write(LOG / f'{stamp}-{mode}.json', report)
    write(LOG / f'latest-{mode}.json', report)
    # Journal contains aggregate status only, never uploaded document names or contents.
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return result


def main():
    signal.signal(signal.SIGTERM, terminate)
    mode = sys.argv[1]
    if mode == 'preflight':
        value = available_kib()
        print(json.dumps({'available_mib': round(value/1024), 'required_start_mib': 850}))
        sys.exit(0 if value >= 850 * 1024 else 75)
    assert mode in {'daily', 'selftest'}
    sys.exit(run_scan(mode))


if __name__ == '__main__':
    main()
