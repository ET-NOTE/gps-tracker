"""Remove only the shared VPS SSH source-IP allowlist on user request.

Keeps public-key authentication, Fail2ban, DB rules and other services unchanged.
Run as root: inspect | apply | verify | rollback. No service restart or rule flush.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path('/var/lib/gps-ssh-access-20261118-r2')
OFFICE = '221.159.164.177'
COMMENT = 'developer-ssh-anywhere-20261118'


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def normalized(text):
    return '\n'.join(re.sub(r'\[\d+:\d+\]', '[0:0]', s) for s in text.splitlines() if not s.startswith('#'))


def sshd():
    result = {}
    for addr in (OFFICE, '198.51.100.24'):
        text = run('/usr/sbin/sshd', '-T', '-C', f'user=gps-dev,host=external-office,addr={addr}')
        result[addr] = {s.split(' ', 1)[0]: s.split(' ', 1)[1] for s in text.splitlines()
                        if s.split(' ', 1)[0] in ('port', 'pubkeyauthentication', 'passwordauthentication',
                                                  'kbdinteractiveauthentication', 'permitrootlogin',
                                                  'authenticationmethods', 'allowusers', 'denyusers', 'allowgroups', 'denygroups')}
    return result


def protected():
    files = ['/etc/iptables/rules.v4', '/etc/iptables/rules.v6', '/etc/default/ufw', '/etc/ufw/ufw.conf',
             '/etc/systemd/system/ufw.service.d/10-after-netfilter-persistent.conf',
             '/home/gps-dev/.ssh/authorized_keys', '/home/mmm/projects/gps-tracker-api/.env',
             '/home/gps-dev/projects/gps-tracker-api/.env.dev']
    files += [str(p) for p in Path('/etc/ssh').rglob('*') if p.is_file() and
              (p.name == 'sshd_config' or p.parent.name == 'sshd_config.d')]
    filters = {}
    for tool in ('iptables', 'ip6tables'):
        # Ban lists may change independently; preserve the chain hookup and all non-SSH policy.
        rules = run(tool + '-save', '-t', 'filter')
        filters[tool] = hashlib.sha256(normalized('\n'.join(s for s in rules.splitlines()
            if '--dport 22 ' not in s and not s.startswith('-A f2b-sshd '))).encode()).hexdigest()
        for table in ('nat', 'raw', 'mangle'):
            filters[tool + ':' + table] = hashlib.sha256(normalized(run(tool + '-save', '-t', table)).encode()).hexdigest()
    return {'files': {p: digest(p) for p in files}, 'network': filters, 'sshd': sshd(),
            'services': run('systemctl', 'show', 'ssh', 'fail2ban', 'gps-tracker-api', 'gps-tracker-api-dev',
                            'shield-api', 'nginx', '-pId', '-pMainPID', '-pActiveEnterTimestamp'),
            'ban_policy': {k: run('fail2ban-client', 'get', 'sshd', k) for k in ('maxretry', 'findtime', 'bantime', 'ignoreip')}}


def state():
    rules = {}
    for tool, prefix in [('iptables', 'ufw'), ('ip6tables', 'ufw6')]:
        rules[tool] = [s for s in run(tool, '-S', prefix + '-user-input').splitlines() if '--dport 22 ' in s]
        incoming = run(tool, '-S', 'INPUT')
        assert incoming.startswith('-P INPUT DROP')
        assert len([s for s in incoming.splitlines() if '-j ' + prefix + '-' in s]) == 6
    keys = Path('/home/gps-dev/.ssh/authorized_keys').read_text().splitlines()
    keys = [s for s in keys if s.strip() and not s.lstrip().startswith('#')]
    key_source_restrictions = sum(bool(re.search(r'(?:^|,)from=', s.split(' ssh-', 1)[0])) for s in keys)
    return {'at': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).isoformat(),
            'rules': rules, 'ufw': run('ufw', 'status', 'verbose'), 'protected': protected(),
            'dev_authorized_keys': len(keys), 'dev_key_source_restrictions': key_source_restrictions,
            'fail2ban_active': run('systemctl', 'is-active', 'fail2ban') == 'active'}


def old_rules(s):
    assert s['rules']['iptables'] == [f'-A ufw-user-input -s {OFFICE}/32 -p tcp -m tcp --dport 22 -j ACCEPT']
    assert not s['rules']['ip6tables']


def open_rules(s):
    for tool, prefix in [('iptables', 'ufw'), ('ip6tables', 'ufw6')]:
        assert s['rules'][tool] == [f'-A {prefix}-user-input -p tcp -m tcp --dport 22 -j ACCEPT']
    for p, prefix in [('/etc/ufw/user.rules', 'ufw'), ('/etc/ufw/user6.rules', 'ufw6')]:
        text = Path(p).read_text()
        assert f'-A {prefix}-user-input -p tcp --dport 22 -j ACCEPT' in text
        assert not any(OFFICE in line and '--dport 22 ' in line for line in text.splitlines())


def save(name, value):
    path = ROOT / (name + '.json')
    path.write_text(json.dumps(value, indent=2) + '\n'); path.chmod(0o600)


def apply():
    assert not ROOT.exists(), 'already prepared; review before running again'
    before = state(); old_rules(before)
    assert before['dev_authorized_keys'] > 0 and before['dev_key_source_restrictions'] == 0
    for settings in before['protected']['sshd'].values():
        assert settings['pubkeyauthentication'] == 'yes' and settings['passwordauthentication'] == 'no'
        assert settings['kbdinteractiveauthentication'] == 'no'
    ROOT.mkdir(mode=0o700); save('before', before)
    for p in ('/etc/ufw/user.rules', '/etc/ufw/user6.rules'):
        shutil.copy2(p, ROOT / (Path(p).name + '.before'))
    try:
        # Add general SSH access first; the existing connection remains allowed throughout.
        run('ufw', 'allow', '22/tcp', 'comment', COMMENT)
        run('ufw', '--force', 'delete', 'allow', 'from', OFFICE, 'to', 'any', 'port', '22', 'proto', 'tcp')
        after = state(); open_rules(after)
        assert before['protected'] == after['protected'], 'unrelated settings changed'
        save('after', after)
        print(json.dumps({'applied': True, 'at': after['at'], 'ssh_ipv4': 'any source', 'ssh_ipv6': 'any source',
                          'keys_and_auth_unchanged': True, 'fail2ban_unchanged': True,
                          'other_rules_and_services_unchanged': True, 'backup': str(ROOT)}))
    except Exception:
        rollback()
        raise


def rollback():
    # Restore the office rule before removing the broader allow, without flushing any chain.
    assert (ROOT / 'before.json').exists()
    run('ufw', 'allow', 'from', OFFICE, 'to', 'any', 'port', '22', 'proto', 'tcp')
    run('ufw', '--force', 'delete', 'allow', '22/tcp')
    after = state(); old_rules(after)
    assert after['protected'] == json.loads((ROOT / 'before.json').read_text())['protected']
    save('rollback', after)


if __name__ == '__main__':
    assert os.geteuid() == 0
    action = sys.argv[1]
    if action == 'inspect': print(json.dumps(state(), indent=2))
    elif action == 'apply': apply()
    elif action == 'rollback': rollback()
    elif action == 'verify':
        current = state(); open_rules(current)
        assert current['protected'] == json.loads((ROOT / 'before.json').read_text())['protected']
        save('verified', current)
        print(json.dumps({'passed': True, 'at': current['at'], 'rules': current['rules'],
                          'dev_authorized_keys': current['dev_authorized_keys'],
                          'dev_key_source_restrictions': current['dev_key_source_restrictions'],
                          'sshd': current['protected']['sshd'], 'other_rules_and_services_unchanged': True}))
    else: raise ValueError('unknown action')
