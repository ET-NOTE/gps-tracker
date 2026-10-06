#!/usr/bin/env python3
"""Validate production-like PostgreSQL 14 role boundaries and nginx config on hub only."""
import json
from pathlib import Path
import secrets
import subprocess
import time

ROOT=Path('/home/etcom-hub/build/gps-tracker/shield-platform')
SOURCE=ROOT/'src/ops/shield'
DIR=ROOT/'infrastructure-test'
DB='shield-compat14-db'

def run(*args,**kwargs):
    return subprocess.check_output(args,text=True,**kwargs).strip()

def main():
    DIR.mkdir(exist_ok=True)
    if DB in run('docker','ps','-a','--format','{{.Names}}').splitlines():
        raise SystemExit('Compatibility container already exists; no reset performed.')
    admin=secrets.token_hex(24); password=secrets.token_hex(24)
    hba=DIR/'pg_hba.conf'
    hba.write_text((SOURCE/'postgres-hba.fragment').read_text()+'\nlocal all all trust\nhost all all 0.0.0.0/0 scram-sha-256\n')
    run('docker','run','-d','--name',DB,'--memory=256m','--cpus=1','-p','127.0.0.1:5544:5432','-v',f'{hba}:/etc/shield-pg-hba.conf:ro','-e',f'POSTGRES_PASSWORD={admin}', 'postgres:14-alpine','-c','max_connections=15','-c','shared_buffers=32MB','-c','hba_file=/etc/shield-pg-hba.conf')
    for _ in range(30):
        if subprocess.run(['docker','exec',DB,'pg_isready','-h','127.0.0.1','-U','postgres'],capture_output=True).returncode==0:break
        time.sleep(1)
    sql=f"\\set shield_password '{password}'\n"+(SOURCE/'bootstrap-database.sql').read_text()
    run('docker','exec','-i',DB,'psql','-U','postgres','-d','postgres',input=sql)
    env=DIR/'shield.env'
    env.write_text(f'SHIELD_ENV=production\nSHIELD_ORIGIN=https://shield.serial.kr\nSHIELD_BIND=127.0.0.1:3044\nSHIELD_DATABASE_URL=postgres://shield_app:{password}@127.0.0.1:5432/shield_prod\n')
    env.chmod(0o600)
    api=['docker','run','--rm','--network',f'container:{DB}','--user','1000:1000','--env-file',str(env),'-v','/home/etcom-hub/build/gps-tracker/cache/target/release/shield-api:/app/shield-api:ro','gps-build:rust1.88-node22.22.2','/app/shield-api']
    run(*api,'migrate')
    for db in ['postgres','template1']:
        result=subprocess.run(['docker','exec','-e',f'PGPASSWORD={password}',DB,'psql','-h','127.0.0.1','-U','shield_app','-d',db,'-Atqc','select 1'],capture_output=True,text=True)
        assert result.returncode!=0 and 'pg_hba.conf rejects' in result.stderr
    privilege=run('docker','exec',DB,'psql','-U','postgres','-d','shield_prod','-Atqc',"SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname='shield_app'")
    assert privilege=='f'
    run('docker','exec',DB,'psql','-U','postgres','-d','postgres','-c','CREATE ROLE gps_sentinel LOGIN;')
    assert run('docker','exec',DB,'psql','-U','postgres','-d','postgres','-Atqc',"SELECT has_database_privilege('gps_sentinel','shield_prod','CONNECT')")=='f'
    # Verify the immutable GPS SQL runs on the VPS major version too.
    assert run('docker','exec',DB,'psql','-U','postgres','-d','shield_prod','-Atqc',"SELECT count(*) FROM location_speed_points_between(1,1,now()-interval '1 day',now())")=='0'
    cert=DIR/'cert';cert.mkdir(exist_ok=True)
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=shield.serial.kr','-keyout',str(cert/'privkey.pem'),'-out',str(cert/'fullchain.pem')],check=True,capture_output=True)
    run('docker','run','--rm','-v',f'{SOURCE}/shield.serial.kr.conf:/etc/nginx/conf.d/default.conf:ro','-v',f'{cert}:/etc/letsencrypt/live/shield.serial.kr:ro','nginx:stable-alpine','nginx','-t')
    result={'postgres_major':14,'migrations':'passed','app_cross_database':'rejected','gps_role_shield_database':'rejected','privileged_role':False,'nginx_syntax':'passed'}
    (ROOT/'infrastructure-results.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result))
    run('docker','rm','-fv',DB)

if __name__=='__main__':main()
