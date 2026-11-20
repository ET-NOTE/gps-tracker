#!/usr/bin/env python3
"""Narrow SSH/UFW repair. No flush, service restart, NAT or DB policy changes.

prepare -> isolated network namespace rehearsal -> apply with rollback timer ->
NEW SSH connection from the allowed office -> confirm. Run as root on seriallog.
The existing /etc/iptables restore files are unchanged; UFW runs after them.
"""
import argparse, hashlib, ipaddress, json, os, pathlib, re, shutil, subprocess, sys

ROOT=pathlib.Path('/var/lib/gps-security113-20261111')
UNIT='gps-security113-rollback'
ORDER=pathlib.Path('/etc/systemd/system/ufw.service.d/10-after-netfilter-persistent.conf')

def run(*args,check=True):
    return subprocess.run(args,check=check,text=True,capture_output=True)

def transform_kernel(text,office,v6=False):
    prefix='ufw6' if v6 else 'ufw'
    assert '*filter\n' in text and ':INPUT DROP ' in text
    original=text.splitlines(); result=[]; injected=False
    for suffix in ('before-logging','before','after','after-logging'):
        assert any(x.startswith(':'+prefix+'-'+suffix+'-input ') for x in original)
    # The interrupted IPv4 UFW setup did not create these two empty chains.
    # With default INPUT DROP, UFW leaves both empty (as verified in IPv6).
    for suffix in ('reject','track'):
        chain=prefix+'-'+suffix+'-input'
        if not any(x.startswith(':'+chain+' ') for x in original):
            original.insert(original.index(next(x for x in original if x.startswith('-A '))), ':'+chain+' - [0:0]')
    ssh=f'-A {prefix}-user-input -p tcp -m tcp --dport 22 -j ACCEPT'
    assert original.count(ssh)==1, 'unreviewed SSH user rule'
    assert all(x in (ssh,'-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT') for x in original if '--dport 22 ' in x), 'additional SSH rule needs review'
    for line in original:
        if line==ssh:
            if not v6: result.append(f'-A ufw-user-input -s {office}/32 -p tcp -m tcp --dport 22 -j ACCEPT')
            continue
        if line.startswith('-A INPUT '):
            if not injected:
                # Existing early DB allow/drop rules retain their order and meaning.
                result.extend(x for x in original if x.startswith('-A INPUT ') and '-j '+prefix+'-' not in x and '--dport 22 ' not in x)
                result.extend(f'-A INPUT -j {prefix}-{suffix}-input' for suffix in ('before-logging','before','after','after-logging','reject','track'))
                injected=True
            continue
        result.append(line)
    assert injected
    return '\n'.join(result)+'\n'

def transform_user(text,office,v6=False):
    ip='::/0' if v6 else '0.0.0.0/0';prefix='ufw6' if v6 else 'ufw'
    old=f'### tuple ### allow tcp 22 {ip} any {ip} in\n-A {prefix}-user-input -p tcp --dport 22 -j ACCEPT'
    assert text.count(old)==1,'unreviewed persistent SSH rule'
    new='' if v6 else f'### tuple ### allow tcp 22 0.0.0.0/0 any {office} in\n-A ufw-user-input -s {office}/32 -p tcp --dport 22 -j ACCEPT'
    return text.replace(old,new)

def write(path,text):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.new113');temp.write_text(text);os.chmod(temp,0o600);os.replace(temp,path)

def verify(office):
    for v6 in (False,True):
        tool='ip6tables' if v6 else 'iptables';prefix='ufw6' if v6 else 'ufw'
        lines=run(tool,'-S','INPUT').stdout.splitlines()
        assert lines[0]=='-P INPUT DROP'
        assert len([x for x in lines if '-j '+prefix+'-' in x])==6
        assert not any('--dport 22 ' in x for x in lines)
        rules=run(tool,'-S',prefix+'-user-input').stdout.splitlines()
        ssh=[x for x in rules if '--dport 22 ' in x]
        assert ssh==([] if v6 else [f'-A ufw-user-input -s {office}/32 -p tcp -m tcp --dport 22 -j ACCEPT']),ssh

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','rehearse','apply','confirm','rollback']);p.add_argument('--office');args=p.parse_args()
    assert os.geteuid()==0,'root required'
    if args.action=='prepare':
        office=str(ipaddress.IPv4Address(args.office));assert not ROOT.exists(),'existing backup; review first'
        ROOT.mkdir(mode=0o700)
        meta={'office':office,'netns':os.readlink('/proc/self/ns/net'),'changes':['SSH allow office IPv4 only','restore six UFW INPUT jumps','order UFW after netfilter-persistent'],'production_api_modified':False,'nat_modified':False,'db_access_modified':False}
        for v6 in (False,True):
            name='6' if v6 else '4';tool='ip6tables-save' if v6 else 'iptables-save';path=pathlib.Path('/etc/ufw/user6.rules' if v6 else '/etc/ufw/user.rules')
            kernel=run(tool,'-t','filter').stdout;user=path.read_text()
            write(ROOT/f'kernel{name}.before',kernel);write(ROOT/f'user{name}.before',user)
            write(ROOT/f'kernel{name}.after',transform_kernel(kernel,office,v6));write(ROOT/f'user{name}.after',transform_user(user,office,v6))
        assert not ORDER.exists(),'ordering file already exists; review before replacing'
        write(ROOT/'plan.json',json.dumps(meta,indent=2)+'\n');print(json.dumps(meta,indent=2));return
    meta=json.loads((ROOT/'plan.json').read_text());office=meta['office']
    if args.action=='rehearse':
        assert os.readlink('/proc/self/ns/net')!=meta['netns'],'must run under unshare -n'
        for v6 in (False,True):
            name='6' if v6 else '4';tool='ip6tables-restore' if v6 else 'iptables-restore'
            for phase in ('before','after'):
                subprocess.run([tool,'--wait','5'],input=(ROOT/f'kernel{name}.{phase}').read_text(),text=True,check=True)
        verify(office)
        for v6 in (False,True):
            # Rollback is executable too, without leaving this network namespace.
            name='6' if v6 else '4';tool='ip6tables-restore' if v6 else 'iptables-restore'
            subprocess.run([tool,'--wait','5'],input=(ROOT/f'kernel{name}.before').read_text(),text=True,check=True)
        write(ROOT/'rehearsal.json',json.dumps({'separate_network_namespace':True,'apply_and_rollback_pass':True,'office':office},indent=2)+'\n');print('ISOLATED APPLY / VERIFY / ROLLBACK PASSED');return
    assert os.readlink('/proc/self/ns/net')==meta['netns'],'wrong network namespace'
    if args.action=='apply':
        assert (ROOT/'rehearsal.json').exists() and not (ROOT/'applied.json').exists()
        # Ensure configuration has not changed after review (counters are irrelevant).
        for v6 in (False,True):
            name='6' if v6 else '4';tool='ip6tables-save' if v6 else 'iptables-save'
            normalize=lambda x:re.sub(r'\[\d+:\d+\]','[0:0]','\n'.join(l for l in x.splitlines() if not l.startswith('#')))
            assert normalize(run(tool,'-t','filter').stdout)==normalize((ROOT/f'kernel{name}.before').read_text())
            userpath=pathlib.Path('/etc/ufw/user6.rules' if v6 else '/etc/ufw/user.rules')
            assert userpath.read_text()==(ROOT/f'user{name}.before').read_text(),'persistent rules changed after prepare'
        shutil.copy2(__file__,ROOT/'runner.py')
        run('systemd-run','--unit='+UNIT,'--on-active=180s','/usr/bin/python3',str(ROOT/'runner.py'),'rollback')
        for v6 in (False,True):
            name='6' if v6 else '4';tool='ip6tables-restore' if v6 else 'iptables-restore'
            path=pathlib.Path('/etc/ufw/user6.rules' if v6 else '/etc/ufw/user.rules')
            subprocess.run([tool,'--wait','5','--test'],input=(ROOT/f'kernel{name}.after').read_text(),text=True,check=True)
            write(path,(ROOT/f'user{name}.after').read_text())
            subprocess.run([tool,'--wait','5'],input=(ROOT/f'kernel{name}.after').read_text(),text=True,check=True)
        write(ORDER,'# Security113: build UFW chains after persistent legacy rules restore.\n[Unit]\nAfter=netfilter-persistent.service\n')
        os.chmod(ORDER,0o644);run('systemctl','daemon-reload');verify(office)
        assert 'netfilter-persistent.service' in run('systemctl','show','ufw','-p','After','--value').stdout
        write(ROOT/'applied.json',json.dumps({'ssh_office':office,'ipv6_ssh_allowed':False,'live_filter_repaired':True,'boot_order_configured':True,'boot_retest_done':False,'automatic_rollback_seconds':180},indent=2)+'\n')
        print('APPLIED. Reconnect using a NEW SSH connection and confirm within180seconds.');return
    if args.action=='confirm':
        verify(office);assert (ROOT/'applied.json').exists()
        run('systemctl','stop',UNIT+'.timer')
        assert run('systemctl','is-active',UNIT+'.timer',check=False).returncode!=0
        write(ROOT/'confirmed.json',json.dumps({'rules_verified':True,'automatic_rollback_cancelled':True},indent=2)+'\n');print('CONFIRMED; ROLLBACK TIMER STOPPED');return
    if args.action=='rollback':
        for v6 in (False,True):
            name='6' if v6 else '4';tool='ip6tables-restore' if v6 else 'iptables-restore'
            write(pathlib.Path('/etc/ufw/user6.rules' if v6 else '/etc/ufw/user.rules'),(ROOT/f'user{name}.before').read_text())
            subprocess.run([tool,'--wait','5'],input=(ROOT/f'kernel{name}.before').read_text(),text=True,check=True)
        ORDER.unlink(missing_ok=True);run('systemctl','daemon-reload');print('RESTORED PREVIOUS FILTER AND UFW FILES')

if __name__=='__main__':main()
