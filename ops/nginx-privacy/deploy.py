#!/usr/bin/env python3
"""GPS vhost logging only. No firewall, application, database or host rsyslog changes.

check prints a source hash; apply requires that hash to avoid overwriting a concurrent edit.
Configuration and service files are backed up before use. On failure the vhost is restored
and reloaded before the separate logger is stopped. Existing logs are never removed.
"""
import argparse, fcntl, hashlib, json, os, pathlib, re, subprocess, tempfile, time

HERE = pathlib.Path(__file__).resolve().parent
SITE = pathlib.Path('/etc/nginx/sites-enabled/gps.serial.kr').resolve()
BACKUP = pathlib.Path('/home/mmm/backups/nginx-privacy-20261107-r2')
FILES = {
    'gps-private-log.conf': pathlib.Path('/etc/nginx/conf.d/00-gps-private-log.conf'),
    'rsyslog.conf': pathlib.Path('/etc/gps-nginx-log.conf'),
    'gps-nginx-log.service': pathlib.Path('/etc/systemd/system/gps-nginx-log.service'),
    'logrotate.conf': pathlib.Path('/etc/logrotate.d/gps-nginx-private'),
}
MARKER = '    # GPS private logging 20261107\n'
DIRECTIVES = (MARKER + '    access_log /var/log/nginx/gps_access.log gps_private;\n'
              '    error_log syslog:server=unix:/run/gps-nginx-log/errors.sock,tag=gps_nginx,nohostname error;\n')

def sha(data): return hashlib.sha256(data).hexdigest()
def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        # Never relay raw configuration/logs to chat or evidence.
        raise RuntimeError(f'{args[0]} {args[1]} failed (exit {result.returncode}); inspect locally')
    return result.stdout.strip()

def put(path, data, mode=0o644):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.gps-log-')
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data); out.flush(); os.fsync(out.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

def patched(source):
    if MARKER in source: raise RuntimeError('already configured; use verify')
    if re.search(r'^\s*(access_log|error_log)\s', source, re.M):
        raise RuntimeError('vhost has a logging override; review before applying')
    output, count = re.subn(r'(^\s*server_name gps\.serial\.kr;\s*\n)',
                           lambda m: m[1] + DIRECTIVES, source, flags=re.M)
    if count != 2: raise RuntimeError('expected exactly the GPS HTTP and HTTPS server blocks')
    return output

def verify():
    run('nginx', '-t')
    assert SITE.read_text().count(MARKER) == 2
    for src, dst in FILES.items(): assert dst.read_bytes() == (HERE/src).read_bytes(), str(dst)
    assert run('systemctl', 'is-active', 'gps-nginx-log') == 'active'
    assert run('systemctl', 'is-enabled', 'gps-nginx-log') == 'enabled'
    assert pathlib.Path('/run/gps-nginx-log/errors.sock').is_socket()
    return {'nginx_config':'passed', 'logger':'active', 'logger_boot':'enabled',
            'site_sha256':sha(SITE.read_bytes()), 'api_or_db_changed':False,
            'host_rsyslog_changed':False}

def rollback():
    state = json.loads((BACKUP/'manifest.json').read_text())
    if sha(SITE.read_bytes()) != state['new_site_sha256']:
        raise RuntimeError('vhost changed since apply; do not overwrite it')
    put(SITE, (BACKUP/'site.original').read_bytes())
    run('nginx', '-t'); run('systemctl', 'reload', 'nginx')
    run('systemctl', 'disable', '--now', 'gps-nginx-log')
    for src,dst in FILES.items():
        if sha(dst.read_bytes()) != state['files'][src]: raise RuntimeError('configuration changed')
        dst.unlink()
    run('systemctl', 'daemon-reload')

def main():
    p=argparse.ArgumentParser();p.add_argument('action', choices=['check','apply','verify','rollback'])
    p.add_argument('--expected-site-sha');a=p.parse_args()
    if os.geteuid()!=0: raise SystemExit('root required')
    lock=open('/run/lock/gps-nginx-privacy.lock','w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if a.action=='verify': print(json.dumps(verify()));return
    if a.action=='rollback': rollback();print('{"rolled_back":true,"logs_removed":false}');return
    source=SITE.read_bytes();new=patched(source.decode()).encode()
    run('nginx','-t')
    for dst in FILES.values():
        if dst.exists(): raise RuntimeError(f'pre-existing managed file: {dst}')
    if a.action=='check':
        print(json.dumps({'site_sha256':sha(source),'new_site_sha256':sha(new),'server_blocks':2,
            'scope':'gps.serial.kr only; separate error classifier; no application restart'}));return
    if a.expected_site_sha!=sha(source): raise RuntimeError('source hash changed or not supplied')
    BACKUP.mkdir(mode=0o700, parents=True, exist_ok=False)
    put(BACKUP/'site.original', source, 0o600)
    state={'site':str(SITE),'new_site_sha256':sha(new),'files':{s:sha((HERE/s).read_bytes()) for s in FILES}}
    put(BACKUP/'manifest.json',json.dumps(state,indent=2).encode(),0o600)
    installed=[]
    site_changed=False
    try:
        for src,dst in FILES.items(): put(dst,(HERE/src).read_bytes());installed.append(dst)
        run('rsyslogd','-N1','-f','/etc/gps-nginx-log.conf')
        run('systemctl','daemon-reload')
        run('systemctl','enable','--now','gps-nginx-log')
        for _ in range(50):
            if pathlib.Path('/run/gps-nginx-log/errors.sock').is_socket():break
            time.sleep(.1)
        else: raise RuntimeError('error classifier socket not ready')
        put(SITE,new);site_changed=True
        run('nginx','-t');run('systemctl','reload','nginx')
        print(json.dumps(verify()))
    except Exception:
        if site_changed:
            put(SITE,source);run('nginx','-t');run('systemctl','reload','nginx')
        subprocess.run(['systemctl','disable','--now','gps-nginx-log'],capture_output=True)
        for dst in installed: dst.unlink(missing_ok=True)
        subprocess.run(['systemctl','daemon-reload'],capture_output=True)
        raise

if __name__=='__main__': main()
