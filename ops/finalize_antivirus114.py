#!/usr/bin/env python3
"""Apply measured limits; enabling timers requires successful real scope scan."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess


def run(*args):
    subprocess.run(args, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['limits', 'enable'])
    args = parser.parse_args()
    if args.action == 'limits':
        for name in ['gps-antivirus-update.service', 'gps-antivirus-scan@.service', 'gps-antivirus.slice']:
            p = Path('/etc/systemd/system') / name
            import re
            text = re.sub(r'MemoryHigh=\d+M', 'MemoryHigh=625M', p.read_text())
            text = re.sub(r'MemoryMax=\d+M', 'MemoryMax=675M', text)
            text = text.replace('TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=128M', 'PrivateTmp=yes')
            p.write_text(text)
        shutil.copyfile(Path(__file__).with_name('gps_antivirus114.py'), '/usr/local/libexec/gps-antivirus114.py')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'set-property', 'gps-antivirus.slice', 'MemoryHigh=625M', 'MemoryMax=675M', 'MemorySwapMax=768M')
    else:
        selftest = json.loads(Path('/var/log/gps-antivirus/latest-selftest.json').read_text())
        scan = json.loads(Path('/var/log/gps-antivirus/latest-daily.json').read_text())
        assert selftest['passed']
        assert scan['status'] == 'clear_within_scope', 'Review findings/incomplete coverage before enablement'
        run('systemctl', 'enable', '--now', 'gps-antivirus-update.timer', 'gps-antivirus-scan.timer')
        run('systemctl', 'list-timers', 'gps-antivirus-*', '--no-pager')


if __name__ == '__main__':
    main()
