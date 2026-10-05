#!/usr/bin/env python3
"""Root-owned daily Shield backup. Retains seven days, never deletes telemetry."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time

ROOT=Path('/var/backups/shield')

def main():
    assert os.geteuid()==0
    os.umask(0o077)
    ROOT.mkdir(mode=0o700,exist_ok=True)
    stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    archive=ROOT/f'shield-{stamp}.tar.gz'
    assert not archive.exists()
    with tempfile.TemporaryDirectory(prefix='work-',dir=ROOT) as tmp:
        work=Path(tmp)
        # Dump and count the same MVCC snapshot, even while devices keep sending.
        with subprocess.Popen(['sudo','-u','postgres','psql','-XAtq','-v','ON_ERROR_STOP=1','-d','shield_prod'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True) as session:
            def query(sql):
                session.stdin.write(sql+'\n');session.stdin.flush()
                value=session.stdout.readline().strip()
                assert value, 'Snapshot query failed'
                return value
            snapshot=query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();')
            assert re.fullmatch(r'[0-9A-Fa-f-]+',snapshot)
            tables=('users','devices','readings','location_records','content_posts','audit_log','sensor_channels','sim_requests','sim_ledger','credit_entries','post_images','post_image_links','post_files','post_file_links','site_settings','faqs','point_orders','category_thumbnails','library_order')
            counts={}
            for table in tables:
                if query(f"SELECT to_regclass('{table}') IS NOT NULL;")=='t':
                    counts[table]=int(query(f'SELECT count(*) FROM {table};'))
            counts['schema_versions']=json.loads(query('SELECT json_agg(version ORDER BY version) FROM _sqlx_migrations;'))
            if 'library_order' in counts:
                counts['library_order_data']=json.loads(query("SELECT content || jsonb_build_object('revision',revision) FROM library_order WHERE singleton;"))
            if 'category_thumbnails' in counts:
                counts['category_thumbnails_data']=json.loads(query("SELECT coalesce(json_object_agg(category,json_build_object('image_id',image_id,'alt',alt,'revision',revision)),'{}'::json) FROM category_thumbnails;"))
            if 'post_images' in counts:
                counts['image_hashes']=json.loads(query("SELECT coalesce(json_object_agg(id,encode(sha256(data),'hex')),'{}'::json) FROM post_images;"))
            if 'post_files' in counts:
                counts['file_hashes']=json.loads(query("SELECT coalesce(json_object_agg(id,encode(sha256(data),'hex')),'{}'::json) FROM post_files;"))
                if 10 in counts['schema_versions']:
                    counts['drive_links']=json.loads(query("SELECT coalesce(json_object_agg(id,drive_url),'{}'::json) FROM post_files WHERE drive_url IS NOT NULL;"))
            with (work/'shield_prod.dump').open('wb') as f:
                subprocess.run(['sudo','-u','postgres','pg_dump','-Fc','--no-owner','--no-acl','--snapshot='+snapshot,'shield_prod'],stdout=f,check=True)
            session.stdin.write('ROLLBACK;\n\\q\n');session.stdin.flush()
            assert session.wait(timeout=10)==0
        subprocess.run(['pg_restore','--list',str(work/'shield_prod.dump')],check=True,stdout=subprocess.DEVNULL)
        for source,name in [('/etc/shield-api/shield.env','shield.env'),('/etc/nginx/sites-available/shield.serial.kr.conf','nginx.conf'),('/etc/systemd/system/shield-api.service','shield-api.service')]:
            shutil.copyfile(source,work/name)
        (work/'metadata.json').write_text(json.dumps({'created_at':stamp,'database':'shield_prod','release':Path('/srv/shield/current/release.txt').read_text().strip(),'counts_after_dump':counts},indent=2))
        # counts_after_dump retains the metadata key used by older restore tooling.
        with tarfile.open(str(archive)+'.partial','w:gz') as tar:
            for file in work.iterdir():tar.add(file,arcname=file.name)
        os.replace(str(archive)+'.partial',archive)
    link=ROOT/'latest.new';link.symlink_to(archive.name);os.replace(link,ROOT/'latest.tar.gz')
    for file in ROOT.iterdir():
        if re.fullmatch(r'shield-\d{8}T\d{6}Z\.tar\.gz',file.name) and file!=archive and file.stat().st_mtime<time.time()-7*86400:
            file.unlink()
    h=hashlib.sha256()
    with archive.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    print(json.dumps({'archive':archive.name,'sha256':h.hexdigest(),'bytes':archive.stat().st_size}))

if __name__=='__main__':main()
