#!/usr/bin/env python3
"""Reserved-IP action roundtrip plus synthetic SSH filter matching, no failed login."""
import datetime,json,pathlib,subprocess,tempfile

def run(*args):return subprocess.run(args,check=True,capture_output=True,text=True).stdout

root=pathlib.Path('/var/lib/gps-security113-20261111')
assert (root/'confirmed.json').exists()
reserved='192.0.2.123';result={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'test_address':reserved}
assert reserved not in run('fail2ban-client','get','sshd','banip')
try:
    result['ban_result']=run('fail2ban-client','set','sshd','banip',reserved).strip()
    rules=run('iptables','-S','f2b-sshd')
    assert '-s '+reserved+'/32' in rules and 'REJECT' in rules,rules
    result['banned_rule_observed']=True
    result['hook']=run('iptables','-S','INPUT').splitlines()[1]
    assert '-j f2b-sshd' in result['hook']
finally:
    result['unban_result']=run('fail2ban-client','set','sshd','unbanip',reserved).strip()
result['test_address_removed']=reserved not in run('fail2ban-client','get','sshd','banip')
assert result['test_address_removed']
result['ignoreip']=run('fail2ban-client','get','sshd','ignoreip')
assert '221.159.164.177' in result['ignoreip']
for item,expected in [('maxretry','5'),('findtime','600'),('bantime','3600')]:
    result[item]=run('fail2ban-client','get','sshd',item).strip();assert result[item]==expected
with tempfile.TemporaryDirectory(prefix='gps-security113-') as tmp:
    sample=pathlib.Path(tmp)/'synthetic-auth.log'
    stamp=datetime.datetime.now().strftime('%b %d %H:%M:%S')
    sample.write_text(''.join(f'{stamp} synthetic sshd[1000]: Failed publickey for invalid user security-check from {reserved} port {40000+i} ssh2: RSA SHA256:synthetic\n' for i in range(5)))
    result['filter_test']=run('fail2ban-regex',str(sample),'sshd[mode=normal, publickey=any]')
    assert '5 matched, 0 missed' in result['filter_test'],result['filter_test']
result['pass']=True
print(json.dumps(result,indent=2))
