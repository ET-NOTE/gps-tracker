#!/usr/bin/env python3
"""Restore the newest offsite Shield dump in a disposable PostgreSQL 14 container."""
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time

ROOT=Path('/home/etcom-hub/backups/shield')
CONTAINER='shield-backup-restore-check'
def run(*args,**kwargs):return subprocess.check_output(args,text=True,**kwargs).strip()

def main():
    archive=sorted(ROOT.glob('shield-????????T??????Z.tar.gz'))[-1]
    assert CONTAINER not in run('docker','ps','-a','--format','{{.Names}}').splitlines()
    with tempfile.TemporaryDirectory(prefix='restore-',dir=ROOT) as tmp:
        dump=Path(tmp)/'shield.dump'
        with tarfile.open(archive,'r:gz') as tar:
            meta=json.load(tar.extractfile('metadata.json'))
            with dump.open('wb') as output:
                import shutil
                shutil.copyfileobj(tar.extractfile('shield_prod.dump'),output)
        run('docker','run','-d','--name',CONTAINER,'--network','none','--memory=256m','--cpus=1','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:14-alpine','-c','shared_buffers=32MB','-c','max_connections=15')
        try:
            for _ in range(30):
                # The image's bootstrap server accepts Unix sockets briefly,
                # then shuts down; wait for the final TCP listener instead.
                if subprocess.run(['docker','exec',CONTAINER,'pg_isready','-h','127.0.0.1','-U','postgres'],capture_output=True).returncode==0:break
                time.sleep(1)
            else:raise RuntimeError('Restore database did not become ready')
            run('docker','exec',CONTAINER,'createdb','-U','postgres','shield_restore_test')
            run('docker','cp',str(dump),CONTAINER+':/tmp/shield.dump')
            run('docker','exec',CONTAINER,'pg_restore','--exit-on-error','--no-owner','--no-acl','-U','postgres','-d','shield_restore_test','/tmp/shield.dump')
            observed={}
            for table in ('users','devices','readings','location_records','content_posts','audit_log','sensor_channels','sim_requests','sim_ledger','credit_entries','post_images','post_image_links','post_files','post_file_links','site_settings','faqs','point_orders','category_thumbnails','library_order'):
                if table not in meta['counts_after_dump']:continue
                observed[table]=int(run('docker','exec',CONTAINER,'psql','-U','postgres','-d','shield_restore_test','-Atqc',f'SELECT count(*) FROM {table}'))
                assert observed[table]==meta['counts_after_dump'][table],table+' restore count mismatch'
            versions=json.loads(run('docker','exec',CONTAINER,'psql','-U','postgres','-d','shield_restore_test','-Atqc','SELECT json_agg(version ORDER BY version) FROM _sqlx_migrations'))
            assert versions==meta['counts_after_dump']['schema_versions']
            if 'library_order_data' in meta['counts_after_dump']:
                order=json.loads(run('docker','exec',CONTAINER,'psql','-U','postgres','-d','shield_restore_test','-Atqc',"SELECT content || jsonb_build_object('revision',revision) FROM library_order WHERE singleton"))
                assert order==meta['counts_after_dump']['library_order_data'], 'Library order changed during restore'
            if 'category_thumbnails_data' in meta['counts_after_dump']:
                thumbnails=json.loads(run('docker','exec',CONTAINER,'psql','-U','postgres','-d','shield_restore_test','-Atqc',"SELECT coalesce(json_object_agg(category,json_build_object('image_id',image_id,'alt',alt,'revision',revision)),'{}'::json) FROM category_thumbnails"))
                assert thumbnails==meta['counts_after_dump']['category_thumbnails_data'], 'Category thumbnails changed during restore'
            if 'image_hashes' in meta['counts_after_dump']:
                hashes=json.loads(run('docker','exec',CONTAINER,'psql','-U','postgres','-d','shield_restore_test','-Atqc',"SELECT coalesce(json_object_agg(id,encode(sha256(data),'hex')),'{}'::json) FROM post_images"))
                assert hashes==meta['counts_after_dump']['image_hashes'], 'Image bytes changed during backup/restore'
                assert all(id==digest for id,digest in hashes.items()), 'Image content hash mismatch'
            if 'file_hashes' in meta['counts_after_dump']:
                hashes=json.loads(run('docker','exec',CONTAINER,'psql','-U','postgres','-d','shield_restore_test','-Atqc',"SELECT coalesce(json_object_agg(id,encode(sha256(data),'hex')),'{}'::json) FROM post_files"))
                assert hashes==meta['counts_after_dump']['file_hashes'], 'Attachment bytes changed during backup/restore'
                assert all(id==digest or (digest is None and id in meta['counts_after_dump'].get('drive_links',{})) for id,digest in hashes.items()), 'Attachment content hash mismatch or missing source'
            if 'drive_links' in meta['counts_after_dump']:
                links=json.loads(run('docker','exec',CONTAINER,'psql','-U','postgres','-d','shield_restore_test','-Atqc',"SELECT coalesce(json_object_agg(id,drive_url),'{}'::json) FROM post_files WHERE drive_url IS NOT NULL"))
                assert links==meta['counts_after_dump']['drive_links'], 'Drive destinations changed during backup/restore'
            result={'archive':archive.name,'postgres_major':14,'restored_counts':observed,'schema_versions':versions,'image_hashes_verified':len(meta['counts_after_dump'].get('image_hashes',{})),'file_hashes_verified':len(meta['counts_after_dump'].get('file_hashes',{})),'result':'passed'}
            (ROOT/'restore-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
        finally:run('docker','rm','-fv',CONTAINER)

if __name__=='__main__':main()
