#!/usr/bin/env python3
"""Read-only, allowlisted live security status; no credentials or request data."""
import datetime
import json
from pathlib import Path
import subprocess


def command(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=30)
    return {'command': args, 'exit_code': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}


def main():
    commands = {
        'ufw': ['ufw', 'status', 'verbose'],
        'services': ['systemctl', 'show', 'ufw', 'fail2ban', 'gps-modsecurity', 'gps-antivirus-update.timer', 'gps-antivirus-scan.timer', 'gps-antivirus-scan@daily', '-p', 'Id', '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState'],
        'sshd': ['/usr/sbin/sshd', '-T'],
        'fail2ban': ['fail2ban-client', 'status', 'sshd'],
        'clamav': ['clamscan', '--version'],
        'waf_config': ['docker', 'exec', 'gps-modsecurity114', 'nginx', '-t'],
        'waf_resource': ['docker', 'stats', '--no-stream', '--format', '{{.Name}} | RAM {{.MemUsage}} | CPU {{.CPUPerc}}', 'gps-modsecurity114'],
        'memory': ['free', '-m'],
        'disk': ['df', '-h', '/'],
        'health': ['curl', '-fsS', '--max-time', '10', 'http://127.0.0.1:3045/health'],
    }
    results = {k: command(v) for k, v in commands.items()}
    results['sshd']['stdout'] = '\n'.join(line for line in results['sshd']['stdout'].splitlines() if line.split(' ')[0] in {'passwordauthentication', 'pubkeyauthentication', 'kbdinteractiveauthentication'})
    metadata = {}
    for key, path in {
        'selftest': '/var/log/gps-antivirus/latest-selftest.json',
        'daily': '/var/log/gps-antivirus/latest-daily.json',
        'selftest_resources': '/var/lib/gps-antivirus-install114/selftest-measurement.json',
        'deferred': '/var/lib/gps-antivirus-install114/validation-deferred.json',
    }.items():
        p = Path(path)
        metadata[key] = json.loads(p.read_text()) if p.exists() else None
        if key == 'selftest_resources' and metadata[key]:
            metadata[key].pop('samples', None)
            metadata[key].pop('baseline', None)
    engine = [s for s in Path('/etc/gps-waf114/modsecurity.conf').read_text().splitlines() if s.startswith('SecRuleEngine ')]
    print(json.dumps({'checked_at': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).isoformat(), 'commands': results, 'waf_engine': engine, 'checks': metadata}, indent=2))


if __name__ == '__main__':
    main()
