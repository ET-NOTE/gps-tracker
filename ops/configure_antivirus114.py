#!/usr/bin/env python3
"""Install GPS-only read-only scanner units. Timers remain disabled until measured."""
import os
from pathlib import Path
import shutil
import subprocess

BASE = Path('/etc/gps-antivirus')
COMMON = '''Nice=15
Slice=gps-antivirus.slice
CPUQuota=50%
CPUAccounting=yes
MemoryAccounting=yes
MemoryHigh=625M
MemoryMax=675M
MemorySwapMax=768M
IOAccounting=yes
IOWeight=10
IOSchedulingClass=idle
TasksMax=24
OOMScoreAdjust=500
OOMPolicy=stop
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=tmpfs
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
UMask=0077
Restart=no
'''


def save(path, text, mode=0o644):
    assert not path.exists(), str(path)
    path.write_text(text)
    path.chmod(mode)


def main():
    assert os.geteuid() == 0
    assert not BASE.exists() or not any(BASE.iterdir()), 'Existing configuration requires review'
    BASE.mkdir(mode=0o755, exist_ok=True)
    executable = Path('/usr/local/libexec/gps-antivirus114.py')
    executable.parent.mkdir(mode=0o755, exist_ok=True)
    assert not executable.exists()
    shutil.copyfile(Path(__file__).with_name('gps_antivirus114.py'), executable)
    executable.chmod(0o755)
    config_path = Path('/etc/clamav/freshclam.conf')
    shutil.copyfile(config_path, Path('/var/lib/gps-antivirus-install114/freshclam.conf.before'))
    config_path.write_text('''DatabaseDirectory /var/lib/clamav
DatabaseOwner clamav
DatabaseMirror database.clamav.net
DNSDatabaseInfo current.cvd.clamav.net
TestDatabases yes
LogTime yes
Bytecode yes
ConnectTimeout 20
ReceiveTimeout 60
''')
    config_path.chmod(0o644)
    root = Path('/etc/systemd/system')
    save(root / 'gps-antivirus.slice', '''[Unit]
Description=Aggregate resource cap for GPS antivirus jobs
[Slice]
CPUQuota=50%
MemoryHigh=625M
MemoryMax=675M
MemorySwapMax=768M
IOWeight=10
''')
    save(root / 'gps-antivirus-update.service', '''[Unit]
Description=GPS antivirus official signature update (bounded, nonresident)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=clamav
Group=clamav
TimeoutStartSec=15min
RemainAfterExit=no
LogsDirectory=gps-antivirus-update
LogsDirectoryMode=0700
ReadWritePaths=/var/lib/clamav
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ExecStartPre=/usr/bin/python3 /usr/local/libexec/gps-antivirus114.py preflight
ExecStart=/usr/bin/flock -n /var/lib/clamav/gps-update.lock /usr/bin/time -v -o /var/log/gps-antivirus-update/last-resource.txt /usr/bin/freshclam --config-file=/etc/clamav/freshclam.conf --stdout
ExecStartPost=/usr/bin/touch /var/lib/clamav/gps-last-update-ok
''' + COMMON.replace('UMask=0077', 'UMask=0022'))
    mounts = {
        'api': '/home/mmm/projects/gps-tracker-api/bin',
        'web': '/home/mmm/gps-tracker-web/dist-root',
        'uploads': '/home/mmm/uploads',
        'private-uploads': '/home/mmm/gps-private-uploads',
        'downloads': '/home/mmm/gps-downloads',
    }
    for path in mounts.values():
        assert Path(path).is_dir(), path
    bind = ''.join(f'BindReadOnlyPaths={path}:/run/gps-antivirus-scan/inputs/{name}\n' for name, path in mounts.items())
    save(root / 'gps-antivirus-scan@.service', '''[Unit]
Description=GPS-only antivirus scan (%i; report only)
After=gps-antivirus-update.service
ConditionPathExistsGlob=/var/lib/clamav/daily.c[vl]d

[Service]
Type=oneshot
User=gps-api
Group=gps-api
TimeoutStartSec=15min
TimeoutStopSec=10s
RuntimeDirectory=gps-antivirus-scan
RuntimeDirectoryMode=0700
StateDirectory=gps-antivirus
StateDirectoryMode=0700
LogsDirectory=gps-antivirus
LogsDirectoryMode=0700
PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX
PrivateTmp=yes
ExecStartPre=/usr/bin/python3 /usr/local/libexec/gps-antivirus114.py preflight
ExecStart=/usr/bin/flock -n /var/lib/gps-antivirus/scan.lock /usr/bin/python3 /usr/local/libexec/gps-antivirus114.py %i
''' + bind + COMMON)
    save(root / 'gps-antivirus-update.timer', '''[Unit]
Description=Refresh GPS antivirus signatures twice daily
[Timer]
OnCalendar=*-*-* 03:17:00 Asia/Seoul
OnCalendar=*-*-* 15:17:00 Asia/Seoul
RandomizedDelaySec=10min
Persistent=true
Unit=gps-antivirus-update.service
[Install]
WantedBy=timers.target
''')
    save(root / 'gps-antivirus-scan.timer', '''[Unit]
Description=Daily bounded GPS-only malware scan
[Timer]
OnCalendar=*-*-* 04:17:00 Asia/Seoul
RandomizedDelaySec=10min
Persistent=false
Unit=gps-antivirus-scan@daily.service
[Install]
WantedBy=timers.target
''')
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    print('GPS scanner units installed; timers NOT enabled.')


if __name__ == '__main__':
    main()
