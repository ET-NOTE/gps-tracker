#!/usr/bin/env python3
"""Display fresh server results and externally verified TLS in a real terminal."""
import argparse
import datetime
import json
from pathlib import Path
import socket
import ssl
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', 'seriallog', 'sudo -n python3 /home/mmm/gps-artifacts/collect_security114.py'], check=True, capture_output=True, timeout=90)
    data = json.loads(result.stdout)
    (out / 'live-status.json').write_bytes(result.stdout)
    c = data['commands']
    def text(k): return c[k]['stdout'].strip()
    services = {}
    for block in text('services').split('\n\n'):
        values = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
        if 'Id' in values:
            services[values['Id']] = values
    def state(unit):
        s = services.get(unit, {})
        return f"{s.get('ActiveState', 'unknown')} / {s.get('SubState', 'unknown')} / {s.get('UnitFileState', '-') }"
    handshakes = []
    cert = None
    for forced in (False, True):
        ctx = ssl.create_default_context()
        if forced:
            ctx.minimum_version = ctx.maximum_version = ssl.TLSVersion.TLSv1_2
        with socket.create_connection(('gps.serial.kr', 443), timeout=10) as raw:
            with ctx.wrap_socket(raw, server_hostname='gps.serial.kr') as secure:
                cert = secure.getpeercert()
                handshakes.append({'mode': 'TLS 1.2 only' if forced else 'Default', 'version': secure.version(), 'cipher': secure.cipher()[0], 'verified': True})
    tls = {'checked_at': datetime.datetime.now().astimezone().isoformat(), 'certificate': cert, 'handshakes': handshakes}
    (out / 'live-tls.json').write_text(json.dumps(tls, indent=2), encoding='utf-8')
    issuer = dict(pair for rdn in cert['issuer'] for pair in rdn)
    subject = dict(pair for rdn in cert['subject'] for pair in rdn)
    selftest = data['checks']['selftest'] or {}
    daily = data['checks']['daily'] or {}
    lines = [
        'GPS VPS SECURITY - ACTUAL SERVER OUTPUT', '=' * 110,
        'Checked (KST): ' + data['checked_at'],
        'Server: 210.114.18.16 | gps.serial.kr | Read-only live SSH / TLS checks', '',
        '[ FIREWALL ]  sudo ufw status verbose (selected GPS / management rules)',
        *text('ufw').splitlines()[:3],
        *[s.split('#')[0].rstrip() for s in text('ufw').splitlines() if s.split() and s.split()[0] in {'22/tcp', '80/tcp', '443/tcp', '5432/tcp'} and '(v6)' not in s],
        'Other project rules are retained; this is not the full firewall rule list.', '',
        '[ SECURITY SERVICES ]  systemctl show / fail2ban-client / nginx -t',
        'UFW                      : ' + state('ufw.service'),
        'Fail2ban                 : ' + state('fail2ban.service'),
        'ModSecurity (GPS API)     : ' + state('gps-modsecurity.service'),
        'WAF engine               : ' + ', '.join(data['waf_engine']),
        'WAF configuration test   : ' + ('PASS' if c['waf_config']['exit_code'] == 0 else 'FAIL'),
        *[s.strip() for s in c['waf_config']['stderr'].splitlines() if 'ModSecurity' in s],
        'WAF resources            : ' + text('waf_resource'),
        'Blocking activation pending large-photo JSON compatibility verification.', '',
        '[ ANTIVIRUS ]  clamscan --version / systemctl show / saved test result',
        text('clamav'),
        'Signature update timer   : ' + state('gps-antivirus-update.timer'),
        'Daily scan timer         : ' + state('gps-antivirus-scan.timer'),
        'Harmless EICAR test      : ' + ('DETECTED / PASS' if selftest.get('passed') else 'NOT PASSED'),
        'EICAR completed (KST)    : ' + str(selftest.get('finished_at', 'unknown')),
        'GPS scope scan           : ' + str(daily.get('status', 'unknown')) + ' (practical validation deferred)',
        'Mode: on-demand scanning; no resident clamav-daemon / no real-time blocking.', '',
        '[ PUBLIC CERTIFICATE / TRANSPORT ]  fresh verified TLS connections',
        f"Issuer: {issuer.get('organizationName')} / {issuer.get('commonName')} | Subject: {subject.get('commonName')}",
        f"Certificate validity: {cert.get('notBefore')} -> {cert.get('notAfter')}",
        *[f"{v['mode']:<13}: {v['version']} | {v['cipher']} | chain / hostname verified" for v in handshakes],
        '', '[ LIVE SERVICE ]  loopback WAF -> GPS API',
        'GPS health: ' + text('health'),
        '', 'Scope: Cafe24 firewall / administrator PC antivirus not checked here.',
        'Legacy HTTP ingest remains; TLS checks above cover the public HTTPS endpoint.',
        '=' * 110,
        'Saved: live-status.json / live-tls.json / terminal-output.txt',
    ]
    report = '\n'.join(lines) + '\n'
    (out / 'terminal-output.txt').write_text(report, encoding='utf-8')
    print(report)


if __name__ == '__main__':
    main()
