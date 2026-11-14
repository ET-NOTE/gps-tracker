#!/usr/bin/env python3
"""Install only the nonresident scanner; never restart application services."""
import datetime
import json
import os
from pathlib import Path
import subprocess

ROOT = Path('/var/lib/gps-antivirus-install114')
PACKAGES = {'clamav', 'clamav-base', 'clamav-freshclam', 'libclamav12', 'libmspack0'}
SERVICES = ['gps-tracker-api', 'shield-api', 'nginx', 'postgresql', 'docker', 'mosquitto']


def run(args, **kwargs):
    return subprocess.run(args, text=True, check=True, **kwargs)


def main():
    assert os.geteuid() == 0
    assert not ROOT.exists(), 'This installation has already been prepared; inspect before resuming.'
    plan = run(['apt-get', '-s', '--no-install-recommends', 'install', 'clamav', 'clamav-freshclam'], capture_output=True).stdout
    changes = [line.split()[1] for line in plan.splitlines() if line.startswith('Inst ')]
    assert set(changes).issubset(PACKAGES), changes
    assert not any(line.startswith('Remv ') for line in plan.splitlines())
    assert '0 upgraded' in plan
    ROOT.mkdir(mode=0o700)
    before = run(['systemctl', 'show', *SERVICES, '-p', 'Id', '-p', 'MainPID', '-p', 'ActiveEnterTimestamp', '-p', 'NRestarts'], capture_output=True).stdout
    (ROOT / 'services-before.txt').write_text(before)
    (ROOT / 'install-plan.txt').write_text(plan)
    mask = Path('/etc/systemd/system/clamav-freshclam.service')
    assert not mask.exists() and not mask.is_symlink(), 'Unexpected existing updater override'
    # The package must not start an unbounded resident updater during installation.
    run(['systemctl', 'mask', 'clamav-freshclam.service'])
    env = dict(os.environ, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l')
    with (ROOT / 'apt-install.txt').open('w') as log:
        result = subprocess.run(['apt-get', '-y', '--no-install-recommends', 'install', 'clamav', 'clamav-freshclam'], env=env, stdout=log, stderr=subprocess.STDOUT)
    after = run(['systemctl', 'show', *SERVICES, '-p', 'Id', '-p', 'MainPID', '-p', 'ActiveEnterTimestamp', '-p', 'NRestarts'], capture_output=True).stdout
    (ROOT / 'services-after.txt').write_text(after)
    summary = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'install_exit': result.returncode, 'packages': changes, 'application_services_unchanged': before == after, 'resident_updater': 'masked; separate bounded oneshot will be used'}
    (ROOT / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))
    assert result.returncode == 0
    assert before == after, 'Application service state changed during install; investigate.'


if __name__ == '__main__':
    main()
