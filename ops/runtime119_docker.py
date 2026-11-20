#!/usr/bin/python3
"""Scoped Docker adapter for existing synthetic116/117 harnesses only.

All protected workloads use an immutable image guard before application code.
The controller has the Docker socket solely to run these fixed rehearsals; this
is never a production service or a claim of untrusted-code isolation.
"""
import json
import os
import subprocess
import sys

REAL = '/usr/bin/docker'
args = sys.argv[1:]
if args[:2] == ['network', 'create']:
    name = args[-1]
    assert '119' in name and '--internal' in args
    old = subprocess.run([REAL, 'network', 'inspect', name], capture_output=True)
    if old.returncode == 0:
        value = json.loads(old.stdout)[0]
        assert value['Internal'] and value['Labels'].get('gps.runtime119') == 'synthetic'
        print(value['Id']); sys.exit(0)
if args[:1] == ['run']:
    images = ('gps-build:rust1.88-node22.22.2', 'timescale/timescaledb:2.19.3-pg14', 'nginx:stable-alpine')
    selected = [i for i, value in enumerate(args) if value in images]
    if selected:
        i = selected[0]; image = args[i]; options = args[1:i]; command = args[i+1:]
        assert '--network' in options and '119' in options[options.index('--network')+1]
        assert '--privileged' not in options and not any(x in options for x in ('-p', '--publish', '--network=host'))
        memory = next(x.split('=',1)[1] for x in options if x.startswith('--memory='))
        db = image.startswith('timescale/')
        proxy = image.startswith('nginx:')
        profile = 'db-memory' if db else ('proxy' if proxy else 'api')
        if not db and memory == '256m':
            # Offline file-owner test is a controller, not the 550 MiB API.
            options[options.index('--memory=256m')] = '--memory=1024m'; memory = '1024m'; profile = 'controller'
        assert memory == ('1500m' if db else ('64m' if proxy else ('1024m' if profile == 'controller' else '550m')))
        if db and 'gps-provision22-test-20261112cumulative119' in options:
            # The full source AND restored cluster reside in RAM in this
            # synthetic recovery fixture. 1500 MiB caused an OOM in119; keep
            # that failure as evidence and use an explicit4 GiB recovery
            # budget. This is NOT the deployment or load-test DB budget.
            options[options.index('--memory=1500m')] = '--memory=4096m'
            memory = '4096m'; profile = 'db-recovery'
        if not any(x.startswith('--memory-swap=') for x in options): options += ['--memory-swap='+memory]
        if '--ulimit=core=0' not in options: options += ['--ulimit=core=0']
        options += ['--label', 'gps.runtime119=synthetic', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
                    '-e', 'GPS_RUNTIME_PROFILE='+profile]
        if db:
            # 116 already uses a bounded all-RAM PGDATA. Enforce mount flags.
            options = [x.replace('/var/lib/postgresql/data:rw,size=1600m',
                       '/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=1600m') for x in options]
            image = 'gps-runtime119-db:20261112'
        elif proxy:
            image = 'gps-runtime119-proxy:20261112'
        else:
            image = 'gps-runtime119:20261112'
        args = ['run', *options, image, *command]
os.execv(REAL, [REAL, *args])
