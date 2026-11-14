#!/usr/bin/env python3
"""Fresh SSH evidence plus externally verified TLS, displayed in a real terminal."""
import argparse, datetime, json, pathlib, socket, ssl, subprocess

def fields(text):return dict(x.split('=',1) for x in text.splitlines() if '=' in x)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args()
    out=pathlib.Path(args.output);out.mkdir(parents=True,exist_ok=True)
    p=subprocess.run(['ssh','-o','ControlMaster=no','-o','ControlPath=none','seriallog','sudo -n python3 /home/mmm/gps-artifacts/security_inventory113.py'],capture_output=True,check=True)
    data=json.loads(p.stdout);(out/'live-inventory.json').write_bytes(p.stdout)
    c=data['commands'];text=lambda key:c[key]['stdout'].strip()
    context=ssl.create_default_context();tls=[];cert=None
    for forced in (False,True):
        if forced:context.minimum_version=context.maximum_version=ssl.TLSVersion.TLSv1_2
        with socket.create_connection(('gps.serial.kr',443),timeout=10) as raw:
            with context.wrap_socket(raw,server_hostname='gps.serial.kr') as sock:
                cert=sock.getpeercert();tls.append({'mode':'TLS1.2 only' if forced else 'default','version':sock.version(),'cipher':sock.cipher()[0],'peer':sock.getpeername(),'verified':True})
    tls_result={'checked_at':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).isoformat(),'certificate':cert,'handshakes':tls}
    (out/'live-tls.json').write_text(json.dumps(tls_result,indent=2))
    issuer=dict(pair for rdn in cert['issuer'] for pair in rdn)
    lines=['GPS VPS SECURITY / LIVE READ-ONLY VERIFICATION','='*105,
      'Checked at (KST): '+data['checked_at'],'Target: 210.114.18.16  |  Fresh SSH connection from the office',
      '', '[ OS FIREWALL ]  sudo ufw status verbose']
    lines+=text('ufw').splitlines()[:3]
    lines+=[line for line in text('ufw').splitlines() if line.startswith('22/tcp')]
    lines+=['IPv6 SSH allow rule: '+('PRESENT' if '--dport 22 ' in text('ipv6_user') else 'NONE'),
      'UFW after netfilter-persistent: '+str('netfilter-persistent.service' in text('ufw_order')),
      'Boot ordering configured; a real VPS reboot has NOT been tested.',
      '', '[ SSH AUTHENTICATION ]  sudo sshd -T (selected settings)']
    lines+=text('sshd').splitlines()
    lines+=['','[ SECURITY SERVICES ]  systemctl show / dpkg-query / nginx -T']
    blocks=[fields(b) for b in text('firewall_services').split('\n\n')]
    for b in blocks:
        if b.get('Id') in {'fail2ban.service','clamav-daemon.service','clamav-freshclam.service'}:
            lines.append(f"{b['Id']:<26} {b.get('LoadState'):<10} {b.get('ActiveState'):<10} {b.get('UnitFileState') or '-'}")
    lines+=['Host Nginx ModSecurity directives (separate WAF proxy not included): '+(text('waf_directives') or 'NONE'),
      f"Fail2ban sshd: {text('fail2ban_maxretry')} failures / {text('fail2ban_findtime')} seconds; ban {text('fail2ban_bantime')} seconds.",
      'Office exemption configured: '+str('221.159.164.177' in text('fail2ban_ignoreip')),
      '', '[ PUBLIC TLS ]  verified Python/OpenSSL connections to gps.serial.kr:443',
      f"Issuer: {issuer.get('organizationName')} / {issuer.get('commonName')}"]
    lines += [f"{x['mode']:<12}: {x['version']} | {x['cipher']} | certificate verified" for x in tls]
    lines+=['','[ SERVICE / RESOURCE CHECK ]',text('health'),text('memory').splitlines()[1],text('disk').splitlines()[-1],
      '', 'Scope limits: Cafe24 panel not changed. For antivirus / WAF use show_security_terminal114.ps1.',
      'Legacy HTTP ingest on port 80 and office-only DB access on 5432 still exist.',
      'Other project ports remain open. This is NOT an all-requirements-passed report.',
      '='*105,'Saved: live-inventory.json / live-tls.json / terminal-output.txt']
    report='\n'.join(lines)+'\n';(out/'terminal-output.txt').write_text(report,encoding='utf-8');print(report)

if __name__=='__main__':main()
