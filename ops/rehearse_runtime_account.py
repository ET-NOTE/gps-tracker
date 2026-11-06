"""Build-host rehearsal of ops/runtime_account.py. Never touches production.

    python3 rehearse_runtime_account.py <job-dir> <commit>

<job-dir>/source.tar.gz must be `git archive <commit>` of ops. The rehearsal host is a container
with a real systemd (ops/runtime-rehearsal.Dockerfile) laid out like the production host: the
deployment account with passwordless sudo and docker, the API and both cleanup workers running
as that account from the same paths, the binaries production runs today, two unrelated services
of the same account, and a throwaway database on an internal network.

Order: the previous layout works -> check changes nothing -> two forced failures put everything
back by themselves -> apply -> functional check as the runtime account -> rollback -> functional
check as the previous account -> apply again. <job-dir>/out is then what goes to production.
"""
import hashlib
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import sys
import tarfile
import time

NAME = 'runtime-account-20261106'
ACCOUNT, PREVIOUS = 'gps-api', 'mmm'
# What production runs today (round 16), as staged on this host.
RELEASE = pathlib.Path('/home/etcom-hub/build/gps-privacy-pdf-20261106-r1/out')
BINARIES = {'gps-tracker-api': 'b6ac9edb5bacae749db3c2561f95763860599abc7de7099dcf50bc63a427bba7',
            'gps-pdf-render': '3eaaf5535c01c58e1c4f3eae5e3a4799c59b916233960897581d5ee7707d4ffb'}
IMAGE = 'gps-runtime-rehearsal:20261106'
DB_IMAGE = 'timescale/timescaledb:2.19.3-pg14'
NETWORK = 'gps-runtime-rehearsal-20261106'
DB = 'gps-runtime-rehearsal-db-20261106'
HOST = 'gps-runtime-rehearsal-host-20261106'
STAGE = f'/home/mmm/gps-artifacts/{NAME}'
OPS = ['runtime_account.py', 'smoke_runtime_account.py']
WORKERS = ['privacy_account_closure.py', 'privacy_file_cleanup.py', 'privacy_scope_inventory.py']

PROVISION = r'''#!/bin/bash
# The production layout, as read from the production host on 2026-11-06.
set -euo pipefail
groupadd -g 998 docker
useradd -m -u 1000 -s /bin/bash mmm
usermod -aG sudo,docker mmm
echo 'mmm ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/mmm && chmod 440 /etc/sudoers.d/mmm
chmod 755 /home/mmm
api=/home/mmm/projects/gps-tracker-api
install -d -o mmm -g mmm -m 755 /home/mmm/projects $api $api/bin /home/mmm/gps-artifacts /home/mmm/gps-artifacts/__NAME__ /home/mmm/backups
install -d -o mmm -g mmm -m 700 /home/mmm/.ssh && install -o mmm -g mmm -m 600 /dev/null /home/mmm/.ssh/authorized_keys
install -d -o mmm -g mmm -m 750 /home/mmm/uploads /home/mmm/uploads/device_documents /home/mmm/uploads/device_documents/1
install -d -o mmm -g mmm -m 700 /home/mmm/uploads/device_documents/1/1 /home/mmm/gps-private-uploads /home/mmm/gps-private-uploads/car-images
install -o root -g root -m 755 /root/in/gps-tracker-api /root/in/gps-pdf-render $api/bin/
install -d -o root -g root -m 755 /home/mmm/gps-ops /etc/gps-tracker
install -o root -g root -m 644 /root/in/privacy_account_closure.py /root/in/privacy_file_cleanup.py /root/in/privacy_scope_inventory.py /home/mmm/gps-ops/
# A key file of the right shape; the API reads it when it starts. No real project, no reachable endpoint.
openssl genrsa -out /root/in/fcm.pem 2048 2>/dev/null
python3 - <<'PY'
import json
json.dump({'project_id': 'rehearsal-only', 'private_key': open('/root/in/fcm.pem').read(),
           'client_email': 'rehearsal@example.invalid', 'token_uri': 'http://127.0.0.1:9/token'},
          open('/etc/gps-tracker/fcm-service-account.json', 'w'))
PY
chown mmm:mmm /etc/gps-tracker/fcm-service-account.json && chmod 600 /etc/gps-tracker/fcm-service-account.json
cat > $api/.env <<'EOF'
APP_ENV=test
BIND_ADDR=127.0.0.1:3040
DATABASE_URL=postgres://postgres:rehearsal-only@rehearsal-db:5432/gps_rehearsal
JWT_SECRET=rehearsal-only-jwt-key-32-characters
SMS_DEV_MODE=1
FCM_SERVICE_ACCOUNT_PATH=/etc/gps-tracker/fcm-service-account.json
PRIVATE_UPLOAD_DIR=/home/mmm/gps-private-uploads
EOF
chown mmm:mmm $api/.env && chmod 600 $api/.env
install -o mmm -g mmm -m 600 $api/.env $api/.env.bak_1784951479
cat > /etc/systemd/system/gps-tracker-api.service <<'EOF'
[Unit]
Description=GPS tracker API (Rust + axum)
After=network.target postgresql.service
Wants=postgresql.service
[Service]
Type=simple
User=mmm
Group=mmm
WorkingDirectory=/home/mmm/projects/gps-tracker-api
EnvironmentFile=/home/mmm/projects/gps-tracker-api/.env
ExecStart=/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gps-tracker-api
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/gps-privacy-accounts.service <<'EOF'
[Unit]
Description=GPS reviewed account closure personal scope
After=postgresql.service
[Service]
Type=oneshot
User=mmm
Group=mmm
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/usr/bin/python3 /home/mmm/gps-ops/privacy_account_closure.py --env-file /home/mmm/projects/gps-tracker-api/.env --pending --execute
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
CapabilityBoundingSet=
MemoryMax=192M
TimeoutStartSec=360
EOF
cat > /etc/systemd/system/gps-privacy-accounts.timer <<'EOF'
[Unit]
Description=Process GPS account closures authorized by administrators
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
Unit=gps-privacy-accounts.service
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/gps-privacy-files.service <<'EOF'
[Unit]
Description=GPS local private-file cleanup outbox
After=postgresql.service

[Service]
Type=oneshot
User=mmm
Group=mmm
ExecStart=/usr/bin/python3 /home/mmm/gps-ops/privacy_file_cleanup.py --env-file /home/mmm/projects/gps-tracker-api/.env --execute --limit 20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/mmm/uploads /home/mmm/gps-private-uploads
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
UMask=0077
MemoryMax=128M
TimeoutStartSec=90
EOF
cat > /etc/systemd/system/gps-privacy-files.timer <<'EOF'
[Unit]
Description=Retry GPS local private-file cleanup
[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
Unit=gps-privacy-files.service
[Install]
WantedBy=timers.target
EOF
# Two unrelated services of the deployment account. They must not notice anything.
for name in gps-tracker pm2-mmm; do cat > /etc/systemd/system/$name.service <<'EOF'
[Unit]
Description=Unrelated service of the deployment account
[Service]
User=mmm
Group=mmm
ExecStart=/usr/bin/sleep infinity
[Install]
WantedBy=multi-user.target
EOF
done
systemctl daemon-reload
systemctl enable --now gps-tracker pm2-mmm gps-tracker-api gps-privacy-accounts.timer gps-privacy-files.timer >/dev/null 2>&1
'''

BOOTSTRAP = r'''"""An administrator and the one-time synthetic credentials, made through the API itself."""
import json, pathlib, secrets, sys, urllib.request
import psycopg2
base, stage, copies = 'http://127.0.0.1:3040/gps-tracker/api/v1', pathlib.Path(sys.argv[1]), int(sys.argv[2])
def post(path, body):
    request = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)
def register(label, password):
    phone = '010' + ''.join(secrets.choice('0123456789') for _ in range(8))
    code = post('/auth/send-otp', {'phone': phone})['dev_code']
    return post('/auth/register', {'email': f'{label}-{secrets.token_hex(6)}@example.invalid', 'phone': phone, 'otp_code': code, 'password': password, 'display_name': label})
env = dict(line.split('=', 1) for line in pathlib.Path('/home/mmm/projects/gps-tracker-api/.env').read_text().splitlines() if '=' in line)
db = psycopg2.connect(env['DATABASE_URL']); db.autocommit = True
admin = register('rehearsal-admin', secrets.token_urlsafe(24))
password = secrets.token_urlsafe(24)
user = register('hash-only', password)
with db.cursor() as q:
    q.execute("UPDATE users SET role='admin' WHERE id=%s", (admin['user_id'],))
    q.execute('SELECT password_hash FROM users WHERE id=%s', (user['user_id'],))
    hashed = q.fetchone()[0]
assert hashed.startswith('$argon2')
for name in [f'smoke-private-{n}.json' for n in range(1, copies + 1)] + ['smoke-private.json']:
    target = stage / name
    target.touch(mode=0o600); target.chmod(0o600)
    target.write_text(json.dumps({'email': f'account-smoke-{secrets.token_hex(6)}@example.invalid', 'password': password, 'password_hash': hashed}))
print('ok')
'''

ENTRY = r'''"""Runs the staged scripts on the rehearsal host. Only addresses, neighbours and forced failures differ."""
import importlib.util, json, sys
sys.dont_write_bytecode = True
STAGE = '__STAGE__'
def load(name):
    spec = importlib.util.spec_from_file_location(name, f'{STAGE}/{name}.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
mode = sys.argv[1]
if mode == 'smoke':
    smoke = load('smoke_runtime_account')
    class Smoke(smoke.Site):
        environment, account, private = 'test', sys.argv[2], sys.argv[3]
        health_url = 'http://127.0.0.1:3040/gps-tracker/health'
        api_url = 'http://127.0.0.1:3040/gps-tracker/api/v1'
        ingest_url = 'http://127.0.0.1:3040/gps-tracker/ingest'
    print(json.dumps(smoke.main(Smoke)))
    sys.exit(0)
runtime = load('runtime_account')
class Rehearsal(runtime.Site):
    environment = 'test'
    health_urls = ('http://127.0.0.1:3040/gps-tracker/health',)
    neighbors = ('gps-tracker.service', 'pm2-mmm.service')
if mode == 'unstartable':
    # The API unit cannot start under the new settings: a writable path that does not exist.
    text = runtime.dropin_text
    runtime.dropin_text = lambda site, unit, uploads, private: text(site, unit, uploads, private) + ('ReadWritePaths=/nonexistent/rehearsal\n' if unit == runtime.API_UNIT else '')
    mode = 'apply'
elif mode == 'unproven':
    # Everything starts, but the PDF processor cannot be proven inside the unit's confinement.
    proof = runtime.selftest
    def unproven(command):
        if command[0] == 'systemd-run':
            raise runtime.Stop('forced failure: the PDF processor was not proven inside the unit')
        return proof(command)
    runtime.selftest = unproven
    mode = 'apply'
try:
    print(json.dumps(getattr(runtime, mode)(Rehearsal()), default=str))
except runtime.Stop as stop:
    print(json.dumps({'stopped': str(stop)}))
    sys.exit(3)
'''

SNAPSHOT = r'''"""What the change is allowed to touch, and what it must leave alone."""
import grp, json, os, pathlib, pwd, subprocess
def owner(path):
    info = os.lstat(path)
    return [pwd.getpwuid(info.st_uid).pw_name, grp.getgrgid(info.st_gid).gr_name, oct(info.st_mode & 0o7777)]
def show(unit, name):
    return subprocess.run(['systemctl', 'show', unit, f'-p{name}', '--value'], capture_output=True, text=True).stdout.strip()
def exists(name):
    try: pwd.getpwnam(name); return True
    except KeyError: return False
api = '/home/mmm/projects/gps-tracker-api'
trees = {}
for root in ('/home/mmm/uploads', '/home/mmm/gps-private-uploads'):
    trees[root] = {os.path.relpath(os.path.join(d, n), root): owner(os.path.join(d, n)) for d, ns, fs in os.walk(root) for n in ns + fs}
    trees[root]['.'] = owner(root)
units = ('gps-tracker-api.service', 'gps-privacy-accounts.service', 'gps-privacy-files.service')
pid = show('gps-tracker-api.service', 'MainPID')
status = dict(l.split(':', 1) for l in open(f'/proc/{pid}/status').read().splitlines() if ':' in l)
print(json.dumps({
    'account_exists': exists('gps-api'), 'group_exists': any(g.gr_name == 'gps-api' for g in grp.getgrall()),
    'units_run_as': {u: show(u, 'User') for u in units},
    'drop_ins': sorted(str(p) for p in pathlib.Path('/etc/systemd/system').glob('*.d/10-runtime-account.conf')),
    'drop_in_directories': {str(p): oct(p.stat().st_mode & 0o7777) for p in sorted(pathlib.Path('/etc/systemd/system').glob('gps-*.d'))},
    'files': {p: owner(p) for p in (f'{api}/.env', '/etc/gps-tracker/fcm-service-account.json', f'{api}/bin/gps-tracker-api', f'{api}/bin/gps-pdf-render')},
    'trees': trees,
    'api_process_user': pwd.getpwuid(int(status['Uid'].split()[0])).pw_name,
    'api_process': {k: status[k].strip() for k in ('NoNewPrivs', 'Seccomp', 'CapEff', 'CapBnd')},
    'neighbor_pids': {u: show(u, 'MainPID') for u in ('gps-tracker.service', 'pm2-mmm.service')},
    'state_directories': sorted(p.name for p in pathlib.Path('/home/mmm/backups').iterdir()),
    'timers_active': [show(t, 'ActiveState') for t in ('gps-privacy-accounts.timer', 'gps-privacy-files.timer')],
}))
'''


def require(condition, message):
    if not condition:
        sys.exit(f'STOPPED: {message}')


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def docker(*args, check=True):
    done = subprocess.run(['docker', *args], capture_output=True, text=True)
    require(not check or done.returncode == 0, f"docker {' '.join(args[:4])}...: {done.stderr.strip()[:400]}")
    return done.stdout.strip()


def inside(*command, check=True):
    """Run on the rehearsal host as root; returns (exit status, last line of output)."""
    done = subprocess.run(['docker', 'exec', HOST, *command], capture_output=True, text=True)
    require(not check or done.returncode == 0, f"{' '.join(command[:4])} failed ({done.returncode}): {(done.stdout + done.stderr).strip()[-900:]}")
    lines = done.stdout.strip().splitlines()
    return done.returncode, (lines[-1] if lines else '')


def down():
    docker('rm', '-f', HOST, DB, check=False)
    docker('network', 'rm', NETWORK, check=False)


def up(job, box):
    down()
    docker('build', '-q', '-t', IMAGE, '-f', str(job / 'src/ops/runtime-rehearsal.Dockerfile'), str(job / 'src/ops'))
    docker('network', 'create', '--internal', NETWORK)
    docker('run', '-d', '--name', DB, '--network', NETWORK, '--network-alias', 'rehearsal-db', '--memory=700m',
           '--tmpfs', '/var/lib/postgresql/data:rw,size=400m', '-e', 'POSTGRES_PASSWORD=rehearsal-only', '-e', 'POSTGRES_DB=gps_rehearsal', DB_IMAGE)
    # A real systemd as PID 1 in its own cgroup namespace. /proc/sys stays read-only and no host device is passed in.
    docker('run', '-d', '--name', HOST, '--network', NETWORK, '--cgroupns=private', '--cap-add', 'SYS_ADMIN',
           '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined', '--tmpfs', '/run', '--tmpfs', '/run/lock',
           '--tmpfs', '/tmp', '-e', 'container=docker', '--memory=1500m', IMAGE, 'sh', '-c', 'mount -o remount,rw /sys/fs/cgroup; exec /sbin/init')
    ready = 0
    for _ in range(90):
        ok = subprocess.run(['docker', 'exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_rehearsal', '-Atc', 'select 1'], capture_output=True).returncode == 0
        ready = ready + 1 if ok else 0
        if ready >= 3 and inside('systemctl', 'is-system-running', check=False)[1] in ('running', 'degraded'):
            break
        time.sleep(1)
    else:
        require(False, 'the rehearsal host or its database did not come up')
    staging = box / 'in'
    staging.mkdir(parents=True)
    for name, digest in BINARIES.items():
        shutil.copy2(RELEASE / name, staging / name)
        require(sha(staging / name) == digest, f'{name} is not the binary production runs')
    for name in WORKERS:
        shutil.copy2(job / 'src/ops' / name, staging / name)
    (staging / 'provision.sh').write_text(PROVISION.replace('__NAME__', NAME))
    (staging / 'bootstrap.py').write_text(BOOTSTRAP)
    (staging / 'entry.py').write_text(ENTRY.replace('__STAGE__', STAGE))
    (staging / 'snapshot.py').write_text(SNAPSHOT)
    docker('cp', str(staging), f'{HOST}:/root/in')
    inside('bash', '/root/in/provision.sh')
    for name in OPS:
        docker('cp', str(job / 'src/ops' / name), f'{HOST}:{STAGE}/{name}')
    for _ in range(90):
        if inside('curl', '-fsS', '-m', '2', 'http://127.0.0.1:3040/gps-tracker/health', check=False)[0] == 0:
            return
        time.sleep(1)
    require(False, 'the API did not start in the previous layout: ' + docker('exec', HOST, 'journalctl', '-u', 'gps-tracker-api', '-n', '15', '--no-pager', check=False)[-900:])


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    job, commit = pathlib.Path(sys.argv[1]).resolve(), sys.argv[2]
    with tarfile.open(job / 'source.tar.gz') as archive:
        require(len(commit) == 40 and archive.pax_headers.get('comment') == commit, f'source.tar.gz is not git archive of {commit}')
        shutil.rmtree(job / 'src', ignore_errors=True)
        (job / 'src').mkdir()
        archive.extractall(job / 'src', filter='data')
    require(sha(__file__) == sha(job / 'src/ops/rehearse_runtime_account.py'), 'this rehearsal script is not the one in the source archive')
    out, box = job / 'out', job / 'rehearsal'
    for path in (out, box):
        shutil.rmtree(path, ignore_errors=True)
    out.mkdir()
    record = {'passed': False, 'name': NAME, 'commit': commit, 'script_sha256': sha(job / 'src/ops/runtime_account.py'),
              'smoke_sha256': sha(job / 'src/ops/smoke_runtime_account.py'), 'binaries': BINARIES,
              'host': {'image': 'ubuntu:22.04 with systemd as PID 1', 'kernel': os.uname().release}, 'steps': []}

    def done(name, **detail):
        record['steps'].append({'step': name, **detail})
        print(f'ok   {name}', flush=True)

    def snapshot():
        return json.loads(inside('python3', '/root/in/snapshot.py')[1])

    def entry(mode, *args, expect=0):
        if mode == 'smoke':
            # Each run here repeats the same administrator's reads within minutes; production runs once
            # from an idle request allowance.
            docker('exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_rehearsal', '-qc', 'DELETE FROM privacy_result_limits')
        done = subprocess.run(['docker', 'exec', HOST, 'python3', '/root/in/entry.py', mode, *args], capture_output=True, text=True)
        lines = done.stdout.strip().splitlines()
        require(done.returncode == expect, f'{mode}: exit {done.returncode}, expected {expect}: {(done.stdout + done.stderr).strip()[-1500:]}')
        return json.loads(lines[-1])

    def comparable(state):
        # Identity of the processes changes with every restart; everything else must be equal.
        return {k: v for k, v in state.items() if k not in ('state_directories',)}

    up(job, box)
    try:
        inside('python3', '/root/in/bootstrap.py', STAGE, '4')
        systemd = docker('exec', HOST, 'systemctl', '--version').splitlines()[0]
        record['host']['systemd'] = systemd
        before = snapshot()
        require(before['units_run_as'] == {u: PREVIOUS for u in before['units_run_as']} and before['api_process_user'] == PREVIOUS and not before['account_exists'], f'unexpected start: {before}')
        require(inside('sudo', '-u', PREVIOUS, 'sudo', '-n', 'true', check=False)[0] == 0 and 'docker' in inside('id', '-Gn', PREVIOUS)[1], 'the deployment account lacks sudo or docker in the rehearsal')
        result = entry('smoke', PREVIOUS, 'smoke-private-1.json')
        require(result['api_runs_as'] == PREVIOUS and result['api_capabilities'] == 0 and not result['api_no_new_privileges'], f'unexpected baseline: {result}')
        done('previous layout: API and workers run as the deployment account (sudo, docker); ingest, sign-in, file, PDF and both timer workers work',
             file_mode=result['file_mode'])
        before = snapshot()

        report = entry('check')
        require(report['ready'] and report['changes_made'] is False and comparable(snapshot()) == comparable(before), 'check changed something')
        done('check passes and changes nothing', would_change=report['would_change'])

        for mode, phrase in (('unstartable', 'did not become healthy'), ('unproven', 'not proven inside the unit')):
            stopped = entry(mode, expect=3)['stopped']
            require('put back as recorded' in stopped and phrase in stopped, f'unexpected failure handling: {stopped}')
            after = snapshot()
            require(comparable(after) == comparable(before) and len(after['state_directories']) == len(before['state_directories']) + 1,
                    f'automatic return left a different state: {after}')
            require(entry('check')['ready'], 'state after the automatic return is not a clean previous layout')
            before = after
            done({'unstartable': 'API unit cannot start under the new settings -> everything put back by itself',
                  'unproven': 'PDF processor cannot be proven inside the unit -> everything put back by itself'}[mode])

        def applied(label, credential):
            report = entry('apply')
            now = snapshot()
            require(now['units_run_as'] == {u: ACCOUNT for u in now['units_run_as']} and now['api_process_user'] == ACCOUNT and now['account_exists'], f'not applied: {now}')
            require(now['api_process'] == {'NoNewPrivs': '1', 'Seccomp': '0', 'CapEff': '0000000000000000', 'CapBnd': '0000000000000000'}, f"API process: {now['api_process']}")
            require(now['files'][f'/home/{PREVIOUS}/projects/gps-tracker-api/.env'] == ['root', ACCOUNT, '0o640'] and now['files']['/etc/gps-tracker/fcm-service-account.json'] == ['root', ACCOUNT, '0o640'], f"files: {now['files']}")
            require(all(entry_[:2] == [ACCOUNT, ACCOUNT] for t in now['trees'].values() for entry_ in t.values()), 'upload trees not handed over')
            require(all(now['trees'][root][name][2] == value[2] for root, entries in before['trees'].items() for name, value in entries.items()), 'upload modes changed')
            require(now['neighbor_pids'] == before['neighbor_pids'] and now['timers_active'] == ['active', 'active'], 'another service was disturbed')
            # The drop-ins must be visible to `systemctl cat` run by another account, like every other drop-in.
            require(len(now['drop_in_directories']) == 3 and set(now['drop_in_directories'].values()) == {'0o755'}, f"drop-in directories: {now['drop_in_directories']}")
            require('ReadWritePaths=' in docker('exec', HOST, 'runuser', '-u', PREVIOUS, '--', 'systemctl', 'cat', 'gps-tracker-api.service', check=False),
                    'the deployment account cannot see the drop-in')
            # Independent of the script's own checks: the account has nothing the deployment account had.
            require(inside('runuser', '-u', ACCOUNT, '--', 'sudo', '-n', 'true', check=False)[0] != 0, 'runtime account can sudo')
            require(inside('id', '-Gn', ACCOUNT)[1] == ACCOUNT, 'runtime account has extra groups')
            require(inside('runuser', '-u', ACCOUNT, '--', 'cat', f'/home/{PREVIOUS}/projects/gps-tracker-api/.env.bak_1784951479', check=False)[0] != 0, 'runtime account reads the old environment copy')
            require(inside('runuser', '-u', ACCOUNT, '--', 'touch', f'/home/{PREVIOUS}/projects/gps-tracker-api/bin/x', check=False)[0] != 0, 'runtime account can write next to the binaries')
            result = entry('smoke', ACCOUNT, credential)
            require(result['api_runs_as'] == ACCOUNT and result['workers_run_as'] == {u: ACCOUNT for u in result['workers_run_as']} and result['file_mode'] == '600'
                    and result['ingest'] == {'synthetic_signed_report_stored': True} and result['account_closures_processed_by_timer_worker'] == 3, f'smoke: {result}')
            done(label, api_process=report['api_process'], pdf_processor_self_test=report['pdf_processor_self_test'], refused=report['refused'],
                 smoke={k: result[k] for k in ('ingest', 'file_mode', 'pdf_pages_rendered_by_installed_processor', 'orphaned_file_removed_by_timer_worker', 'account_closures_processed_by_timer_worker')})
            return now

        applied('apply: API and workers run as gps-api without sudo, docker, capabilities or new privileges; ingest, sign-in, file, PDF and both timer workers work',
                'smoke-private-2.json')

        report = entry('rollback')
        after = snapshot()
        require(report['account_removed'] and comparable(after) == comparable(before), f'rollback did not restore the previous layout: {after}')
        require(entry('check')['ready'], 'state after rollback is not a clean previous layout')
        result = entry('smoke', PREVIOUS, 'smoke-private-3.json')
        require(result['api_runs_as'] == PREVIOUS, f'smoke after rollback: {result}')
        done('rollback: ownership, modes and units as recorded, account removed; everything works as the deployment account again')
        before = snapshot()

        applied('apply again after rollback', 'smoke-private-4.json')
        record['passed'] = True
        shutil.copy2(job / 'src/ops/runtime_account.py', out / 'runtime_account.py')
        shutil.copy2(job / 'src/ops/smoke_runtime_account.py', out / 'smoke_runtime_account.py')
        credential = out / 'smoke-private.json'
        credential.touch(mode=0o600)
        credential.chmod(0o600)
        credential.write_text(docker('exec', HOST, 'cat', f'{STAGE}/smoke-private.json'))
    finally:
        down()
        shutil.rmtree(box, ignore_errors=True)
    (out / 'rehearsal.json').write_text(json.dumps(record, indent=2))
    (out / 'manifest.json').write_text(json.dumps({'name': NAME, 'commit': commit, 'files': {name: sha(out / name) for name in OPS}}, indent=2))
    # The production entry point must accept exactly this record and reject one for another script.
    sys.dont_write_bytecode = True
    import importlib.util
    spec = importlib.util.spec_from_file_location('runtime_account', out / 'runtime_account.py')
    gate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gate)
    staged = type('Staged', (), {'stage': out})
    (out / 'rehearsal.json').write_text(json.dumps({**record, 'script_sha256': '0' * 64}, indent=2))
    try:
        gate.rehearsed(staged)
        require(False, 'a rehearsal record for another script was accepted')
    except gate.Stop:
        pass
    (out / 'rehearsal.json').write_text(json.dumps(record, indent=2))
    gate.rehearsed(staged)
    print('ok   production entry accepts this rehearsal record only', flush=True)
    require(all(p.is_file() for p in out.iterdir()), 'the staged directory holds something other than files')
    print(json.dumps({'stage': str(out), 'files': {p.name: sha(p) for p in sorted(out.iterdir()) if p.name != 'smoke-private.json'}}, indent=2))


if __name__ == '__main__':
    main()
