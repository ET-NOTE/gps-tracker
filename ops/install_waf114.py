#!/usr/bin/env python3
"""GPS-only loopback WAF, pinned upstream image, guarded activation/rollback."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

IMAGE = 'owasp/modsecurity-crs@sha256:b8d5bbf88c643800e31b248993858c335e4907ba0ee473d0c81c5726fb2c1bdc'
STATE = Path('/var/lib/gps-waf-install114')
CONFIG = Path('/etc/gps-waf114')
SERVICE = Path('/etc/systemd/system/gps-modsecurity.service')


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def health(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/gps-tracker/health', timeout=5) as r:
        assert r.status == 200
        return r.read()


def stage():
    assert not STATE.exists() and not CONFIG.exists() and not SERVICE.exists(), 'Already staged; inspect before rerun'
    assert health(3040)
    assert ':3045 ' not in run('ss', '-lntH'), 'Port in use'
    run('docker', 'image', 'inspect', IMAGE)
    STATE.mkdir(mode=0o700)
    (STATE / 'services-before.txt').write_text(run('systemctl', 'show', 'gps-tracker-api', 'shield-api', 'nginx', 'postgresql', 'docker', 'mosquitto', '-p', 'Id', '-p', 'MainPID', '-p', 'ActiveEnterTimestamp', '-p', 'NRestarts'))
    source = Path(__file__).with_name('gps-waf114')
    shutil.copytree(source, CONFIG)
    CONFIG.chmod(0o755)
    for file in CONFIG.iterdir():
        file.chmod(0o644)
    shutil.copyfile(Path(__file__).with_name('gps_waf_runner114.py'), '/usr/local/libexec/gps_waf_runner114.py')
    logs = Path('/var/log/gps-waf')
    assert not logs.exists()
    logs.mkdir(mode=0o750)
    os.chown(logs, 101, 101)
    SERVICE.write_text(f'''[Unit]
Description=GPS ModSecurity + OWASP CRS (loopback API WAF)
After=docker.service gps-nginx-log.service gps-tracker-api.service
Requires=docker.service
Wants=gps-nginx-log.service
StartLimitIntervalSec=60
StartLimitBurst=3
[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/libexec/gps_waf_runner114.py /usr/bin/docker run --rm --name gps-modsecurity114 --network host --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777 --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64 --log-driver none --stop-timeout 15 --mount type=bind,src=/etc/gps-waf114,dst=/etc/gps-waf,readonly --mount type=bind,src=/var/log/gps-waf,dst=/logs --mount type=bind,src=/run/gps-nginx-log,dst=/run/gps-errors,readonly --entrypoint /usr/sbin/nginx {IMAGE} -c /etc/gps-waf/nginx.conf -g "daemon off;"
ExecStop=/usr/bin/docker stop -t 15 gps-modsecurity114
Restart=on-failure
RestartSec=3
TimeoutStartSec=30
TimeoutStopSec=25
[Install]
WantedBy=multi-user.target
''')
    SERVICE.chmod(0o644)
    Path('/etc/logrotate.d/gps-waf').write_text('''/var/log/gps-waf/*.log {
    daily
    maxsize 1M
    rotate 7
    missingok
    notifempty
    compress
    copytruncate
    su 101 101
}
''')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'gps-modsecurity.service')
    for _ in range(20):
        try:
            assert health(3045) == health(3040)
            print('WAF started on loopback; production proxy still unchanged.')
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError('WAF health failed; production routes unchanged')


def restore():
    manifest = json.loads((STATE / 'routes.json').read_text())
    for item in manifest:
        path = Path(item['path'])
        assert sha(path) == item['after'], 'Concurrent edit; do not overwrite: ' + str(path)
    for item in manifest:
        shutil.copyfile(STATE / item['backup'], item['path'])
    run('nginx', '-t')
    run('systemctl', 'reload', 'nginx')
    print('Only GPS API upstreams restored; WAF remains available on loopback.')


def activate():
    assert not (STATE / 'routes.json').exists(), 'Already activated or attempted; inspect state'
    assert health(3045) == health(3040)
    manifest = []
    for link in sorted(Path('/etc/nginx/sites-enabled').iterdir()):
        path = link.resolve()
        text = path.read_text()
        # Restrict to proxy_pass statements targeting the GPS API, including legacy aliases.
        old = 'proxy_pass http://127.0.0.1:3040'
        count = text.count(old)
        if not count:
            continue
        backup = f'route-{len(manifest)}.conf'
        shutil.copyfile(path, STATE / backup)
        updated = text.replace(old, 'proxy_pass http://127.0.0.1:3045')
        manifest.append({'path': str(path), 'backup': backup, 'before': sha(path), 'after': hashlib.sha256(updated.encode()).hexdigest(), 'proxy_count': count})
    assert len(manifest) == 2 and sum(i['proxy_count'] for i in manifest) == 14, manifest
    (STATE / 'routes.json').write_text(json.dumps(manifest, indent=2))
    for item in manifest:
        path = Path(item['path'])
        assert sha(path) == item['before']
        path.write_text(path.read_text().replace('proxy_pass http://127.0.0.1:3040', 'proxy_pass http://127.0.0.1:3045'))
    try:
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        for _ in range(3):
            with urllib.request.urlopen('https://gps.serial.kr/health', timeout=10) as response:
                assert response.status == 200
            time.sleep(1)
    except Exception:
        restore()
        raise
    (STATE / 'activated-at.txt').write_text(datetime.datetime.now(datetime.timezone.utc).isoformat())
    print(json.dumps({'activated': True, 'proxy_routes': manifest}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['stage', 'activate', 'rollback'])
    args = parser.parse_args()
    assert os.geteuid() == 0
    {'stage': stage, 'activate': activate, 'rollback': restore}[args.action]()
