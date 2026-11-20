"""Read-only postdeployment status; aggregate logs without client IPs or payloads."""
import collections
import datetime
import json
import pathlib
import shutil
import subprocess

import review146_deploy as r


def main():
    r.require(r.run(['hostname']).strip() == 'seriallog.cafe24.com', 'wrong host')
    r.checks(r.b.url(), 115)
    staged = json.loads((r.STAGE / 'staged.json').read_text())
    deployed = json.loads((r.STAGE / 'deployment.json').read_text())
    now = datetime.datetime.now(datetime.timezone.utc).astimezone()
    ready = datetime.datetime.strptime(deployed['at'], '%Y-%m-%dT%H:%M:%S%z')
    start = datetime.datetime.strptime(staged['at'], '%Y-%m-%dT%H:%M:%S%z')
    counts = {name: collections.Counter() for name in ('during_preparation', 'after_ready')}
    exceptional = {name: collections.Counter() for name in counts}
    ingest = {name: collections.Counter() for name in counts}
    exceptions = []
    # The installed gps_private log already replaces identifiers and omits query strings.
    for line in pathlib.Path('/var/log/nginx/gps_access.log').read_text().splitlines():
        try:
            item = json.loads(line)
            at = datetime.datetime.fromisoformat(item['time'])
        except (ValueError, KeyError):
            continue
        if not start <= at <= now:
            continue
        group = 'after_ready' if at >= ready else 'during_preparation'
        status = int(item['status'])
        counts[group][str(status)] += 1
        route = item.get('route', '')
        if 'ingest' in route or 'report' in route:
            ingest[group][str(status)] += 1
        if status >= 500 or status == 429:
            # Publish only installed route templates, never client IPs or request contents.
            safe_route = route if ':resource' in route or route in ('/health', '/ingest', '/api/v1/devices') else '[other route]'
            exceptional[group][str(status) + ' ' + safe_route] += 1
            exceptions.append({'at': item['time'], 'status': status, 'route': safe_route})
    service = r.run(['systemctl', 'show', 'gps-tracker-api', '-pActiveState', '-pMainPID', '-pNRestarts', '-pExecMainStartTimestamp'])
    journal = subprocess.run(['journalctl', '-u', 'gps-tracker-api', '--since', ready.strftime('%Y-%m-%d %H:%M:%S'), '-p', 'err', '-o', 'json', '--no-pager'], capture_output=True, check=True)
    errors = sum(1 for line in journal.stdout.splitlines() if line.startswith(b'{'))
    neighbors_equal = r.b.neighbors() == staged['baseline']['neighbors']
    env_equal = r.sha(r.b.ENV) == r.OLD_ENV
    account_audit = json.loads(r.run(['python3', str(r.STAGE / 'check-accounts.py')]))
    dev_head = r.run(['runuser', '-u', 'gps-dev', '--', 'git', '-C', '/home/gps-dev/workspace/gps-tracker', 'rev-parse', 'HEAD']).strip()
    dev_status = r.run(['runuser', '-u', 'gps-dev', '--', 'git', '-C', '/home/gps-dev/workspace/gps-tracker', 'status', '--porcelain']).strip()
    r.require(neighbors_equal and env_equal and errors == 0, 'postdeployment invariant failed')
    r.record('postcheck', {
        'passed': True, 'observed_until': now.isoformat(), 'ready_at': deployed['at'],
        'health': r.b.health(3040, r.API_RELEASE), 'state': r.b.state(),
        'service': service, 'api_error_priority_journal_entries_after_ready': errors,
        'http_status_counts': {k: dict(v) for k, v in counts.items()},
        'exception_counts': {k: dict(v) for k, v in exceptional.items()},
        'exception_times': exceptions,
        'ingest_or_report_route_status_counts': {k: dict(v) for k, v in ingest.items()},
        'log_interval_start': start.isoformat(),
        'account_entitlements': account_audit,
        'neighbors_unchanged': neighbors_equal, 'environment_unchanged': env_equal,
        'dev_checkout_head': dev_head, 'dev_checkout_clean': not dev_status,
        'disk_available_bytes': shutil.disk_usage('/').free,
        'note': 'Read-only checks. Normal application/browser traffic, not a load test. No new device telemetry claim without observed reports.'
    })


if __name__ == '__main__':
    main()
