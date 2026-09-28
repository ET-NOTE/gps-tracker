#!/usr/bin/env python3
"""Run on etcom-hub. Creates only disposable Shield test containers, never GPS DBs."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
from urllib.parse import urlsplit

ROOT = Path('/home/etcom-hub/build/gps-tracker/shield-platform')
IMAGE = 'gps-build:rust1.88-node22.22.2'

def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()

def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    state = ROOT / 'preview-state.json'
    if state.exists():
        raise SystemExit('Preview already provisioned; reuse preview-state.json. No reset performed.')
    password = secrets.token_hex(24)
    env = ROOT / 'preview.env'
    if not env.exists():
        env.write_text(f'SHIELD_DATABASE_URL=postgres://shield_test:{password}@127.0.0.1:5543/shield_test\nSHIELD_ORIGIN=http://localhost:8043\nSHIELD_ENV=test\nSHIELD_BIND=127.0.0.1:3043\n')
    else:
        password = urlsplit(next(line.split('=',1)[1] for line in env.read_text().splitlines() if line.startswith('SHIELD_DATABASE_URL='))).password
    env.chmod(0o600)
    if 'shield-preview-db' not in run('docker','ps','-a','--format','{{.Names}}').splitlines():
        run('docker', 'run', '-d', '--name', 'shield-preview-db', '--memory=256m', '--cpus=1',
            '-p', '127.0.0.1:5543:5432', '-e', 'POSTGRES_DB=shield_test',
            '-e', 'POSTGRES_USER=shield_test', '-e', f'POSTGRES_PASSWORD={password}',
            'postgres:16-alpine', '-c', 'max_connections=15', '-c', 'shared_buffers=32MB')
    for _ in range(30):
        ready = subprocess.run(['docker', 'exec', 'shield-preview-db', 'pg_isready', '-h', '127.0.0.1', '-U', 'shield_test'], capture_output=True)
        if ready.returncode == 0:
            break
        time.sleep(1)
    base = ['docker','run','--rm','--user','1000:1000','--network','host',
            '--env-file',str(env),'-v','/home/etcom-hub/build/gps-tracker/cache/target/release/shield-api:/app/shield-api:ro',IMAGE,'/app/shield-api']
    run(*base, 'migrate')
    run('docker','run','-d','--name','shield-preview-api','--user','1000:1000',
        '--network','host','--memory=128m','--cpus=1','--env-file',str(env),
        '-v','/home/etcom-hub/build/gps-tracker/cache/target/release/shield-api:/app/shield-api:ro',IMAGE,'/app/shield-api')
    state.write_text(json.dumps({'env_file':str(env),'cli':base}, indent=2))
    state.chmod(0o600)
    print('Shield preview API started on loopback 3043, isolated disposable PostgreSQL on 5543.')

if __name__ == '__main__':
    main()
