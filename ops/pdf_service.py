"""GPS PDF processor as its own service (infrastructure round 1, stage 2).

Run as root on the GPS production host, from the staged directory:

    python3 pdf_service.py check      # read-only: what would change and whether it can
    python3 pdf_service.py apply      # create the account and the units, switch the API to them, verify
    python3 pdf_service.py rollback   # remove them again; the API starts the processor itself as before

Until now the API started the PDF processor as its own child, so the processor ran as the API's
account and could see what the API can see. After `apply` the API only sends the page request
to a socket. systemd starts one processor per request as `gps-pdf`, an account with no login and
no group, in an environment that holds nothing but the processor file: no network, no home, no
upload directory, no configuration, a memory limit of its own and a time limit. The processor's
own restrictions (system call allowlist, memory, CPU, page count) stay as they are inside it.

The socket exists only after the processor's self-test has passed in that same environment, and
only the API's account may connect to it. The API does not wait for that proof: after a reboot
it serves everything else at once, and PDF pages a few seconds later. If the proof ever fails,
PDF pages are answered as unavailable and nothing else is affected.

What is changed: one system account, three unit files, one drop-in for the API unit, one API
restart. Not changed: binaries, the database, the firewall, other accounts and services.
`apply` goes back by itself if anything fails after its first change.
"""
import grp
import hashlib
import json
import os
import pathlib
import pwd
import subprocess
import sys
import time
import urllib.request

NAME = 'pdf-service-20261106'
ACCOUNT = 'gps-pdf'
API_ACCOUNT = 'gps-api'
API_UNIT = 'gps-tracker-api.service'
SOCKET_UNIT = 'gps-pdf-render.socket'
RENDER_UNIT = 'gps-pdf-render@.service'
PROOF_UNIT = 'gps-pdf-render-selftest.service'
DROPIN = '20-pdf-socket.conf'
SOCKET = '/run/gps-pdf-render/render.sock'
MEMORY_MAX = 832 * 1024 * 1024  # above the processor's own 768 MiB ceiling, so its own limit answers first
PROBES = ('open_file', 'open_socket', 'start_program', 'start_process', 'too_much_memory', 'too_much_cpu')
# What every processor started by systemd runs in. `seccomp` is named because this systemd's
# @system-service group does not include the call the processor uses to install its own filter.
CONFINEMENT = '''User={account}
Group={account}
SupplementaryGroups=
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
PrivateNetwork=yes
IPAddressDeny=any
RestrictAddressFamilies=none
PrivateDevices=yes
TemporaryFileSystem=/:ro
BindReadOnlyPaths={renderer}
ProtectProc=invisible
ProcSubset=pid
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service seccomp
MemoryMax={memory}
MemorySwapMax=0
TasksMax=16
LimitCORE=0
'''
# A page request as the API sends it, for a two-page document with known pixels.
CLIENT = r'''
import socket, struct, sys, time
def pdf(objects):
    data, offsets = b'%PDF-1.5\n', []
    for number, body in enumerate(objects, 1):
        offsets.append(len(data)); data += f'{number} 0 obj\n'.encode() + body.encode() + b'\nendobj\n'
    xref = len(data)
    data += f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode() + b''.join(f'{o:010} 00000 n \n'.encode() for o in offsets)
    return data + f'trailer\n<</Size {len(objects)+1}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n'.encode()
def stream(c): return f'<</Length {len(c)}>>\nstream\n{c}\nendstream'
document = pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>',
                '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>', stream('1 0 0 rg 0 0 100 100 re f'),
                '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 6 0 R>>', stream('0 0 1 rg 60 60 90 90 re f')])
address, mode = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(30)
try:
    s.connect(address)
except OSError as error:
    print('refused ' + type(error).__name__); sys.exit(0)
if mode == 'hold':
    time.sleep(float(sys.argv[3])); sys.exit(0)
body = document if mode == 'page' else b'%PDF-1.7\n%%EOF\n'
s.sendall(b'GPSPDF1\n' + struct.pack('>II', 1, len(body)) + body); s.shutdown(socket.SHUT_WR)
reply = b''
while True:
    part = s.recv(1 << 16)
    if not part: break
    reply += part
head = reply[8:32] if len(reply) >= 32 else reply[8:12]
print('reply', int(reply[:8] == b'GPSPDF1\n'), len(reply), *struct.unpack('>' + 'I' * (len(head) // 4), head), *reply[32:35])
'''


class Stop(Exception):
    """A precondition or verification did not hold."""


def require(condition, message):
    if not condition:
        raise Stop(message)


def run(args, check=True):
    done = subprocess.run(args, capture_output=True, text=True)
    if check and done.returncode:
        raise Stop(f"{' '.join(map(str, args))} failed ({done.returncode}): {(done.stderr or done.stdout).strip()[:300]}")
    return done


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


class Site:
    """The production host. The build-host rehearsal substitutes its own addresses and neighbours."""
    environment = 'production'
    stage = pathlib.Path('/home/mmm/gps-artifacts') / NAME
    state = pathlib.Path('/home/mmm/backups') / NAME
    api = pathlib.Path('/home/mmm/projects/gps-tracker-api')
    units = pathlib.Path('/etc/systemd/system')
    health_urls = ('http://127.0.0.1:3040/gps-tracker/health', 'https://gps.serial.kr/health')
    # Other services on this host. They must be exactly as they were afterwards.
    neighbors = ('gps-tracker.service', 'pm2-mmm.service', 'gps-tracker-api-dev.service', 'shield-api.service',
                 'nginx.service', 'postgresql@14-main.service', 'docker.service', 'gps-privacy-accounts.timer', 'gps-privacy-files.timer')

    @property
    def binary(self):
        return self.api / 'bin/gps-tracker-api'

    @property
    def renderer(self):
        return self.api / 'bin/gps-pdf-render'

    def health(self):
        seen = []
        for url in self.health_urls:
            with urllib.request.urlopen(url, timeout=5) as response:
                seen.append(json.load(response))
        require(all(h.get('ok') and h.get('db') and h.get('environment') == self.environment for h in seen), f'API health is {seen}')
        require(len({h.get('release') for h in seen}) == 1, f'health addresses disagree: {seen}')
        return seen[0]


def show(unit, *properties):
    out = run(['systemctl', 'show', unit, *[f'-p{p}' for p in properties]]).stdout
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def status(pid):
    return dict(line.split(':', 1) for line in pathlib.Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)


def environment(pid):
    return dict(item.split('=', 1) for item in pathlib.Path(f'/proc/{pid}/environ').read_bytes().decode(errors='replace').split('\0') if '=' in item)


def files(site):
    """The four files this procedure writes."""
    confinement = CONFINEMENT.format(account=ACCOUNT, renderer=site.renderer, memory=MEMORY_MAX)
    return {
        site.units / PROOF_UNIT: f'''# Written by ops/pdf_service.py. Remove with `pdf_service.py rollback`.
[Unit]
Description=GPS PDF processor: proof of its confinement in the environment it is served from
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={site.renderer} selftest
TimeoutStartSec=60
{confinement}''',
        site.units / SOCKET_UNIT: f'''# Written by ops/pdf_service.py. Remove with `pdf_service.py rollback`.
[Unit]
Description=GPS PDF processor: page requests from the API
# No socket without a passing proof, and a new proof whenever the proof is run again.
Requires={PROOF_UNIT}
After={PROOF_UNIT}
PartOf={PROOF_UNIT}
# Not an early-boot socket: it waits for the proof, an ordinary service that runs for seconds.
# With the default dependencies it would have to come before sockets.target and after it at once.
DefaultDependencies=no
Conflicts=shutdown.target
Before=shutdown.target
[Socket]
ListenStream={SOCKET}
Accept=yes
SocketUser=root
SocketGroup={API_ACCOUNT}
SocketMode=0660
DirectoryMode=0755
MaxConnections=4
RemoveOnStop=yes
[Install]
WantedBy=multi-user.target
''',
        site.units / RENDER_UNIT: f'''# Written by ops/pdf_service.py. Remove with `pdf_service.py rollback`.
[Unit]
Description=GPS PDF processor: one page
CollectMode=inactive-or-failed
[Service]
ExecStart={site.renderer}
StandardInput=socket
StandardOutput=socket
StandardError=null
RuntimeMaxSec=20
TimeoutStopSec=2
{confinement}''',
        site.units / f'{API_UNIT}.d' / DROPIN: f'''# Written by ops/pdf_service.py. Remove with `pdf_service.py rollback`.
# The API sends PDF pages to the separate processor service instead of starting the processor.
# Wants only: the API never waits for the processor's proof and starts without it. Until the
# socket is there, PDF pages are answered as unavailable and everything else works.
[Unit]
Wants={SOCKET_UNIT}
[Service]
Environment=GPS_PDF_SOCKET={SOCKET}
''',
    }


def neighbors(site):
    return {unit: show(unit, 'MainPID', 'ActiveEnterTimestamp', 'User', 'ActiveState') for unit in site.neighbors}


def exists(name):
    try:
        pwd.getpwnam(name)
        return True
    except KeyError:
        pass
    try:
        grp.getgrnam(name)
        return True
    except KeyError:
        return False


def survey(site):
    require(os.geteuid() == 0, 'run as root')
    require(int(run(['systemctl', '--version']).stdout.split()[1]) >= 249, 'systemd is older than this procedure was rehearsed with')
    manifest = json.loads((site.stage / 'manifest.json').read_text())
    api = show(API_UNIT, 'User', 'MainPID', 'ActiveState', 'NRestarts')
    require(api.get('ActiveState') == 'active' and int(api['MainPID']) > 0, 'the API is not running')
    require(api['User'] == API_ACCOUNT, f'the API runs as {api["User"]!r}: the runtime account (stage 1) must be in place first')
    # The API must be the build that knows how to send pages to a socket, and the processor the proven one.
    require(sha(site.binary) == manifest['api_sha256'] and sha(f"/proc/{api['MainPID']}/exe") == manifest['api_sha256'],
            'the running API is not the release this stage was rehearsed with (deploy that release first)')
    require(sha(site.renderer) == manifest['renderer_sha256'], 'the installed PDF processor is not the one this stage was rehearsed with')
    info = site.renderer.stat()
    require(info.st_uid == 0 and not info.st_mode & 0o022 and info.st_mode & 0o005 == 0o005, f'{site.renderer} must be owned by root and executable by all')
    for parent in site.renderer.parents:
        require(parent.stat().st_mode & 0o001, f'{parent} cannot be traversed by another account')
    return {'manifest': manifest, 'api': api, 'health': site.health(), 'api_environment': environment(api['MainPID']),
            'present': sorted(str(path) for path in files(site) if path.exists()),
            'content': {str(path): sha(path) for path in (site.binary, site.renderer)}, 'neighbors': neighbors(site)}


def preflight(site, want):
    found = survey(site)
    require(found['health'].get('release') == found['manifest']['release'], f"the API reports {found['health'].get('release')}, not {found['manifest']['release']}")
    if want == 'previous':
        require(not found['present'] and not exists(ACCOUNT) and not site.state.exists() and not pathlib.Path(SOCKET).parent.exists(),
                f"an earlier attempt left something ({found['present'] or ACCOUNT}); review it first")
        require('GPS_PDF_SOCKET' not in found['api_environment'], 'the API is already configured with a processor socket')
        require((site.units / f'{API_UNIT}.d').is_dir(), 'the API unit has no drop-in directory: stage 1 is not in place')
    else:
        require(len(found['present']) == 4 and exists(ACCOUNT) and (site.state / 'record.json').is_file(),
                'the host is not in the state `apply` leaves; nothing to roll back')
    return found


def wait_health(site, seconds=45):
    last = None
    for _ in range(seconds):
        try:
            return site.health()
        except Exception as error:  # still starting
            last = repr(error)
        time.sleep(1)
    raise Stop(f'the API did not become healthy: {last}')


def client(account, *arguments, confined=False):
    """One request to the socket as `account`; `confined` adds the API unit's own confinement."""
    command = [sys.executable, '-c', CLIENT, SOCKET, *arguments]
    if confined:
        properties = ['User=' + account, 'Group=' + account, 'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'PrivateTmp=yes',
                      'ProtectSystem=strict', 'ProtectHome=read-only', 'ProtectControlGroups=yes', 'UMask=0077']
        command = ['systemd-run', '--wait', '--pipe', '--collect', '--quiet', *[f'--property={p}' for p in properties], *command]
    else:
        command = ['runuser', '-u', account, '--', *command]
    done = subprocess.run(command, capture_output=True, text=True, timeout=120, cwd='/')
    return done.stdout.strip().split()


def instance(site):
    """What one running processor is and sees, looked at from outside while it waits for its input."""
    holder = subprocess.Popen(['runuser', '-u', API_ACCOUNT, '--', sys.executable, '-c', CLIENT, SOCKET, 'hold', '4'], cwd='/')
    try:
        pid = None
        for _ in range(30):
            found = run(['pgrep', '-n', '-x', site.renderer.name], check=False).stdout.strip()
            if found and run(['ps', '-o', 'unit=', '-p', found], check=False).stdout.strip().startswith('gps-pdf-render@'):
                pid = int(found)
                break
            time.sleep(0.1)
        require(pid, 'no processor was started for an open connection')
        seen = status(pid)
        root = f'/proc/{pid}/root'
        regular = []
        for directory, names, entries in os.walk(root):
            relative = directory[len(root):] or '/'
            if relative == '/':
                names[:] = [name for name in names if name not in ('proc', 'sys', 'dev')]  # kernel interfaces, not files
            regular += sorted(os.path.join(relative, name) for name in entries if os.path.isfile(os.path.join(directory, name)))
        group = pathlib.Path('/sys/fs/cgroup' + pathlib.Path(f'/proc/{pid}/cgroup').read_text().strip().split(':')[-1])
        links = [line.split(': ')[1] for line in run(['nsenter', '-t', str(pid), '-n', 'ip', '-o', 'link']).stdout.splitlines()]
        return {'unit': run(['ps', '-o', 'unit=', '-p', str(pid)]).stdout.strip(), 'user': pwd.getpwuid(int(seen['Uid'].split()[0])).pw_name,
                'no_new_privileges': int(seen['NoNewPrivs']) == 1, 'system_call_filter': int(seen['Seccomp']) == 2,
                'capabilities': int(seen['CapEff'], 16) | int(seen['CapBnd'], 16), 'files_it_can_see': regular,
                'network_interfaces': links, 'memory_max': int((group / 'memory.max').read_text()),
                'swap_max': (group / 'memory.swap.max').read_text().strip()}
    finally:
        holder.wait()


def verify(site, found):
    proof = show(PROOF_UNIT, 'Result', 'ActiveState')
    require(proof == {'Result': 'success', 'ActiveState': 'active'}, f'the self-test in the service environment ended with {proof}')
    lines = [line for line in run(['journalctl', '-u', PROOF_UNIT, '-o', 'cat', '--no-pager', '-n', '40']).stdout.splitlines() if 'sandbox_holds' in line]
    require(lines, 'the self-test left no report')
    report = json.loads(lines[-1])
    require(report.get('sandbox_holds') is True and report.get('renders_inside_sandbox') is True
            and all(report.get(probe, {}).get('blocked') is True for probe in PROBES), f'self-test report: {lines[-1][:300]}')
    require(show(SOCKET_UNIT, 'ActiveState')['ActiveState'] == 'active', 'the processor socket is not listening')
    socket = os.stat(SOCKET)
    require((pwd.getpwuid(socket.st_uid).pw_name, grp.getgrgid(socket.st_gid).gr_name, socket.st_mode & 0o777) == ('root', API_ACCOUNT, 0o660),
            'the processor socket has another owner or mode')
    page = ['reply', '1', str(32 + 3 * 1414 * 707), '0', '1414', '707', '2', '200000', '100000', '255', '0', '0']
    require(client(API_ACCOUNT, 'page') == page, 'the service did not draw the known page for the API account')
    require(client(API_ACCOUNT, 'page', confined=True) == page, 'the service is not reachable from inside the API unit confinement')
    require(client(API_ACCOUNT, 'unreadable') == ['reply', '1', '12', '2'], 'the service did not refuse an unreadable document as documented')
    require(client('nobody', 'page') == ['refused', 'PermissionError'], 'another account can connect to the processor socket')
    seen = instance(site)
    require(seen['user'] == ACCOUNT and seen['no_new_privileges'] and seen['system_call_filter'] and seen['capabilities'] == 0, f'processor instance: {seen}')
    require(seen['files_it_can_see'] == [str(site.renderer)], f"the processor can see more than itself: {seen['files_it_can_see'][:12]}")
    require(seen['network_interfaces'] == ['lo'] and seen['memory_max'] == MEMORY_MAX and seen['swap_max'] == '0', f'processor instance: {seen}')
    run(['systemctl', 'restart', API_UNIT])
    health = wait_health(site)
    require(health.get('release') == found['health'].get('release'), f'the API reports another release: {health}')
    api = show(API_UNIT, 'MainPID', 'User')
    require(api['User'] == API_ACCOUNT and environment(api['MainPID']).get('GPS_PDF_SOCKET') == SOCKET, 'the API was not started with the processor socket')
    account = pwd.getpwnam(ACCOUNT)
    members = sorted(g.gr_name for g in grp.getgrall() if ACCOUNT in g.gr_mem)
    require(not members and account.pw_shell.endswith('nologin'), f'{ACCOUNT} has groups {members} or a login shell')
    return {'health': health, 'self_test_in_service': {probe: report[probe]['how'] for probe in PROBES}, 'processor_instance': seen,
            'socket': f'{SOCKET} root:{API_ACCOUNT} 660', 'other_account_refused': True,
            'account': {'uid': account.pw_uid, 'shell': account.pw_shell, 'home': account.pw_dir, 'groups': members},
            'api_environment': {'GPS_PDF_SOCKET': SOCKET}}


def untouched(site, found):
    require(neighbors(site) == found['neighbors'], 'another service on the host changed during this work')
    for path, digest in found['content'].items():
        require(sha(path) == digest, f'the content of {path} changed')


def restore(site, record):
    """Units and drop-in away, the API back to starting the processor itself, then the account."""
    run(['systemctl', 'disable', '--now', SOCKET_UNIT], check=False)
    # A page being drawn at this moment ends here; the API answers that one request as failed.
    run(['systemctl', 'stop', RENDER_UNIT.replace('@', '@*'), PROOF_UNIT], check=False)
    for path in record['files']:
        pathlib.Path(path).unlink(missing_ok=True)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'reset-failed', PROOF_UNIT, SOCKET_UNIT], check=False)
    pathlib.Path(SOCKET).unlink(missing_ok=True)
    directory = pathlib.Path(SOCKET).parent
    if directory.is_dir() and not any(directory.iterdir()):
        directory.rmdir()
    if record['api_switched']:
        run(['systemctl', 'restart', API_UNIT])
    health = wait_health(site)
    api = show(API_UNIT, 'MainPID')
    require('GPS_PDF_SOCKET' not in environment(api['MainPID']), 'after going back the API still has the processor socket configured')
    if record['created_account'] and exists(ACCOUNT):
        for _ in range(50):  # an account with a running process cannot be removed
            if run(['pgrep', '-u', ACCOUNT], check=False).returncode:
                break
            time.sleep(0.1)
        run(['userdel', ACCOUNT])
        require(not exists(ACCOUNT), f'{ACCOUNT} could not be removed')
    return health


def check(site):
    found = preflight(site, 'previous')
    return {'mode': 'check', 'ready': True, 'changes_made': False, 'release': found['health'].get('release'),
            'now': {'api_runs_as': found['api']['User'], 'api_starts_the_processor_itself': True},
            'would_change': {'account': f'create {ACCOUNT} (system account, no login, no home, no groups)',
                             'files': [str(path) for path in files(site)], 'socket': f'{SOCKET} (root:{API_ACCOUNT} 660)',
                             'restart': API_UNIT},
            'not_changed': ['binaries', 'database', 'firewall', 'other accounts', *site.neighbors]}


def apply(site):
    os.umask(0o022)
    found = preflight(site, 'previous')
    record = {'name': NAME, 'taken_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'files': [str(path) for path in files(site)],
              'created_account': False, 'api_switched': False}
    site.state.mkdir(mode=0o700)
    (site.state / 'record.json').write_text(json.dumps(record, indent=1))
    try:
        run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent',
             '--shell', '/usr/sbin/nologin', '--comment', 'GPS PDF processor', ACCOUNT])
        record['created_account'] = True
        record['api_switched'] = True  # from here on the API may be restarted with the drop-in
        (site.state / 'record.json').write_text(json.dumps(record, indent=1))
        for path, text in files(site).items():
            path.write_text(text)
            path.chmod(0o644)
        run(['systemctl', 'daemon-reload'])
        # Starts the proof first; the socket does not come up without it.
        run(['systemctl', 'enable', '--now', SOCKET_UNIT])
        verified = verify(site, found)
        untouched(site, found)
    except Exception as failure:
        try:
            restore(site, record)
            untouched(site, found)
            site.state.rename(site.state.with_name(site.state.name + f'.reverted-{int(time.time())}'))
        except Exception as second:
            raise Stop(f'THE CHANGE FAILED AND THE AUTOMATIC RETURN FAILED TOO. change: {failure}; return: {second}. '
                       f'The record is in {site.state}; the units and the API drop-in need manual repair.') from second
        raise Stop(f'the change did not verify; everything was put back. Cause: {failure}') from failure
    report = {'mode': 'apply', 'name': NAME, 'account': ACCOUNT, **verified, 'files': record['files'],
              'record': str(site.state / 'record.json'), 'other_services_unchanged': True, 'binaries_unchanged': True}
    (site.stage / 'pdf-service.json').write_text(json.dumps(report, indent=2))
    return report


def rollback(site):
    os.umask(0o022)
    found = preflight(site, 'applied')
    record = json.loads((site.state / 'record.json').read_text())
    health = restore(site, record)
    untouched(site, found)
    after = survey(site)
    require(not after['present'] and not exists(ACCOUNT) and not pathlib.Path(SOCKET).exists(), 'something of the processor service is still there')
    site.state.rename(site.state.with_name(site.state.name + f'.rolled-back-{int(time.time())}'))
    report = {'mode': 'rollback', 'name': NAME, 'health': health, 'api_starts_the_processor_itself': True,
              'account_removed': True, 'units_removed': True, 'other_services_unchanged': True}
    (site.stage / 'pdf-service-rollback.json').write_text(json.dumps(report, indent=2))
    return report


def rehearsed(site):
    """Production runs only the exact script that passed the build-host rehearsal."""
    record = json.loads((site.stage / 'rehearsal.json').read_text())
    require(record.get('passed') is True and record.get('service_script_sha256') == sha(__file__),
            'this script has not passed the build-host rehearsal')


def main():
    modes = {'check': check, 'apply': apply, 'rollback': rollback}
    if len(sys.argv) != 2 or sys.argv[1] not in modes:
        sys.exit(__doc__)
    try:
        site = Site()
        rehearsed(site)
        print(json.dumps(modes[sys.argv[1]](site), indent=2, default=str))
    except Stop as stop:
        sys.exit(f'STOPPED: {stop}')


if __name__ == '__main__':
    main()
