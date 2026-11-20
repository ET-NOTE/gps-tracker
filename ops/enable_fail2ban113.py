#!/usr/bin/env python3
"""Enable installed Fail2ban sshd jail after validated office-only SSH policy."""
import datetime, json, os, pathlib, subprocess, time

def run(*args, check=True):
    return subprocess.run(args,text=True,capture_output=True,check=check)

def main():
    assert os.geteuid()==0
    root=pathlib.Path('/var/lib/gps-security113-20261111')
    assert (root/'confirmed.json').exists(),'confirm firewall from fresh SSH first'
    jail=pathlib.Path('/etc/fail2ban/jail.d/99-gps-office-sshd.local')
    order=pathlib.Path('/etc/systemd/system/fail2ban.service.d/10-after-firewall.conf')
    assert not jail.exists() and not order.exists(),'review existing configuration'
    assert run('systemctl','is-active','fail2ban',check=False).returncode!=0
    assert run('systemctl','is-enabled','fail2ban',check=False).stdout.strip()=='disabled'
    office=json.loads((root/'plan.json').read_text())['office']
    jail.write_text('[sshd]\nenabled = true\nfilter = sshd[mode=normal, publickey=any]\nport = 22\nbackend = auto\nbanaction = iptables-multiport\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\nignoreip = 127.0.0.1/8 ::1 '+office+'/32\n')
    os.chmod(jail,0o644)
    order.parent.mkdir(parents=True,exist_ok=True)
    order.write_text('[Unit]\nAfter=ufw.service netfilter-persistent.service\n')
    os.chmod(order,0o644)
    try:
        run('fail2ban-client','-t')
        run('systemctl','daemon-reload')
        run('systemctl','enable','--now','fail2ban')
        # Type=simple returns before its control socket is ready.
        for _ in range(40):
            if run('fail2ban-client','ping',check=False).returncode==0:
                break
            time.sleep(0.5)
        run('fail2ban-client','ping')
    except BaseException:
        run('systemctl','disable','--now','fail2ban',check=False)
        jail.unlink(missing_ok=True);order.unlink(missing_ok=True)
        run('systemctl','daemon-reload');raise
    print('Fail2ban sshd enabled: 5 failures / 10 minutes, ban 1 hour; office and loopback exempt.')
    print('No password authentication was enabled. No real failed login was sent.')

if __name__=='__main__':main()
