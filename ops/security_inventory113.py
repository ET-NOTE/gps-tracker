#!/usr/bin/env python3
"""Read-only, allowlisted evidence. Never emits credentials or request/log bodies."""
import datetime, hashlib, json, re, subprocess

def command(args):
    p=subprocess.run(args,text=True,capture_output=True,timeout=30)
    return {'command':' '.join(args),'exit_code':p.returncode,'stdout':p.stdout,'stderr':p.stderr}

def main():
    entries={}
    commands={
      'os':['lsb_release','-ds'], 'cpu':['nproc'], 'memory':['free','-m'],
      'disk':['df','-h','/'], 'ufw':['ufw','status','verbose'],
      'ufw_order':['systemctl','show','ufw','-p','After','-p','Result'],
      'firewall_services':['systemctl','show','ufw','netfilter-persistent','fail2ban','clamav-daemon','clamav-freshclam','-p','Id','-p','LoadState','-p','ActiveState','-p','UnitFileState','-p','ActiveEnterTimestamp'],
      'app_services':['systemctl','show','gps-tracker-api','shield-api','nginx','postgresql','docker','mosquitto','-p','Id','-p','ActiveState','-p','ExecMainPID','-p','ActiveEnterTimestamp','-p','NRestarts'],
      'listeners':['ss','-lntup'], 'ipv4_input':['iptables','-S','INPUT'],
      'ipv6_input':['ip6tables','-S','INPUT'],
      'ipv4_user':['iptables','-S','ufw-user-input'], 'ipv6_user':['ip6tables','-S','ufw6-user-input'],
      'packages':['dpkg-query','-W','ufw','fail2ban','clamav','clamav-daemon','clamav-freshclam','libnginx-mod-http-modsecurity','modsecurity-crs','nginx'],
      'fail2ban':['fail2ban-client','status','sshd'], 'sshd':['/usr/sbin/sshd','-T'],
      'fail2ban_maxretry':['fail2ban-client','get','sshd','maxretry'],
      'fail2ban_findtime':['fail2ban-client','get','sshd','findtime'],
      'fail2ban_bantime':['fail2ban-client','get','sshd','bantime'],
      'fail2ban_ignoreip':['fail2ban-client','get','sshd','ignoreip'],
      'nginx_modules':['find','/etc/nginx/modules-enabled','-maxdepth','1','-type','l','-printf','%f\n'],
      'health':['curl','-fsS','--max-time','10','http://127.0.0.1:3040/health']}
    for key,args in commands.items():
        entries[key]=command(args)
        if key=='sshd':
            entries[key]['stdout']='\n'.join(x for x in entries[key]['stdout'].splitlines() if x.split(' ')[0] in {'port','permitrootlogin','pubkeyauthentication','passwordauthentication','kbdinteractiveauthentication','maxauthtries'})+'\n'
    # Capture only loaded WAF directives, not unrelated secret nginx upstream headers.
    config=command(['nginx','-T'])
    entries['waf_directives']={'command':'nginx -T | select ModSecurity directives','exit_code':config['exit_code'],'stdout':'\n'.join(x for x in config['stdout'].splitlines() if re.match(r'\s*(load_module.*modsecurity|modsecurity\s|modsecurity_rules)',x)),'stderr':''}
    hashes={}
    for tool in ('iptables-save','ip6tables-save'):
        for table in ('nat','raw'):
            r=command([tool,'-t',table]); normalized='\n'.join(re.sub(r'\[\d+:\d+\]','[0:0]',x) for x in r['stdout'].splitlines() if not x.startswith('#'))
            hashes[tool+':'+table]={'exit_code':r['exit_code'],'sha256':hashlib.sha256(normalized.encode()).hexdigest()}
    print(json.dumps({'checked_at':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).isoformat(),'scope':'live host read-only; no account, password, token or location values','commands':entries,'unchanged_table_hashes':hashes},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
