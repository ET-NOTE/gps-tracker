#!/usr/bin/env python3
"""Apply a reviewed public-content snapshot with revision checks and Drive-only assets.

No firmware upload, enrollment, financial calls or configuration changes. The
operator prepares content-plan.json from the current public posts, reviews its
diff, verifies a fresh backup, and uses --publish only for that exact plan.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import time
import urllib.request

ROOT = Path('/home/mmm/shield-deploy')
spec = importlib.util.spec_from_file_location('checks', ROOT / 'verify-production.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def content(public):
    return {k: v for k, v in public.items() if k not in ('revision', 'updated_at')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    assert os.geteuid() == 0 and c.BASE == 'https://shield.serial.kr'
    os.umask(0o077)
    directory = args.directory.resolve()
    plan = json.loads((directory / 'content-plan.json').read_text())['posts']
    packages = directory / 'packages'
    manifest = json.loads((packages / 'publication.json').read_text())
    links = json.loads((directory / 'drive-links.json').read_text())
    assert len(manifest) == 8 and len(plan) == 11
    expected_ids = {item['content']['id'] for item in manifest} | {'start', 'upload', 'dynamic-sensors'}
    assert expected_ids == {item['before']['id'] for item in plan}
    assets = [asset for item in manifest for asset in item['assets']]
    assert len(assets) == 24 and set(links) == {asset['path'] for asset in assets}
    for asset in assets:
        file = (packages / asset['path']).resolve()
        assert file.is_relative_to(packages) and hashlib.sha256(file.read_bytes()).hexdigest() == asset['sha256']
        link = links[asset['path']]
        match = re.fullmatch(r'https://drive\.google\.com/file/d/([A-Za-z0-9_-]+)/view', link['url'])
        assert match and Path(link['filename']).name == link['filename']
        with urllib.request.urlopen('https://drive.usercontent.google.com/download?id=' + match[1] + '&export=download', timeout=45) as response:
            data = response.read(2_000_000)
        assert hashlib.sha256(data).hexdigest() == asset['sha256'], link['filename']

    admin = c.Client()
    credentials = json.loads((ROOT / 'admin-enrollment.json').read_text())
    assert admin.call('/api/auth/login', {k: credentials[k] for k in ('email', 'password')})[0] == 200
    protected_sql = """SELECT json_build_object(
      'settings',(SELECT json_agg(t) FROM site_settings t),
      'order',(SELECT json_agg(t) FROM library_order t),
      'thumbnails',(SELECT json_agg(t) FROM category_thumbnails t),
      'orders',(SELECT count(*) FROM point_orders), 'requests',(SELECT count(*) FROM sim_requests),
      'ledger',(SELECT count(*) FROM sim_ledger), 'credits',(SELECT count(*) FROM credit_entries));"""
    try:
        protected = c.pg(protected_sql)
        status, rows, _ = admin.call('/api/admin/posts')
        assert status == 200
        existing = {p['content']['id']: p for p in rows}
        for item in plan:
            before, after = item['before'], item['after']
            assert after['id'] == before['id']
            row = existing[before['id']]
            assert row['published'] and row['revision'] == before['revision'], ('Changed revision; re-review', before['id'])
            assert row['content'] == content(before), ('Content drift; re-review', before['id'])
            assert sorted(i['id'] for i in before.get('images', [])) == sorted(i['id'] for i in after.get('images', []))
        print(json.dumps({'mode': 'publish' if args.publish else 'dry run', 'posts': len(plan), 'verified_public_drive_files': len(assets), 'photos': 'preserved'}))
        if not args.publish:
            return
        backup = directory / ('posts-before-' + str(int(time.time())) + '.json')
        backup.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
        attachments = {}
        for item in manifest:
            slug = item['content']['id']
            attachments[slug] = []
            for asset in item['assets']:
                status, result, _ = admin.call('/api/admin/post-files/drive', links[asset['path']])
                assert status == 200, ('Register Drive attachment', status, result)
                assert result['drive_url'] == links[asset['path']]['url']
                attachments[slug].append({'id': result['id'], 'title': asset['title'], 'after_step': 0})
                time.sleep(0.6)
        sources = {item['content']['id']: item['content'] for item in manifest}
        applied = {}
        for item in plan:
            before, after = item['before'], copy.deepcopy(content(item['after']))
            slug = after['id']
            source_id = 'shield-uno-first-upload' if slug in ('start', 'upload') else slug
            if source_id in sources:
                assert len(before.get('attachments', [])) == (0 if slug == 'upload' else 3), ('Review additional attachments', slug)
                after['code'] = sources[source_id]['code']
                after['attachments'] = copy.deepcopy(attachments[source_id])
                if slug == 'start':
                    for attachment in after['attachments']:
                        attachment['after_step'] = 2
            status, result, _ = admin.call('/api/admin/posts/' + slug, {'content': after, 'published': True, 'revision': before['revision']})
            assert status == 200, (slug, status, result)
            applied[slug] = after
            (directory / 'applied-posts.json').write_text(json.dumps(applied, ensure_ascii=False, indent=2))
        after_rows = {p['content']['id']: p for p in admin.call('/api/admin/posts')[1]}
        public = {p['id']: p for p in c.Client().call('/api/posts')[1]}
        for slug, desired in applied.items():
            assert after_rows[slug]['content'] == desired and content(public[slug]) == desired
            assert after_rows[slug]['revision'] == existing[slug]['revision'] + 1
        assert all(after_rows[slug] == row for slug, row in existing.items() if slug not in applied)
        assert protected == c.pg(protected_sql), 'Protected settings/ledgers changed'
        report = {'revisions': {slug: public[slug]['revision'] for slug in applied}, 'drive_files': len(assets),
                  'other_posts_unchanged': len(existing) - len(applied), 'photos': 'all existing retained',
                  'settings_order_thumbnails_financial': 'unchanged', 'hardware_validation': 'pending'}
        (directory / 'publication-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False))
    finally:
        assert admin.call('/api/auth/logout', {})[0] == 200


if __name__ == '__main__':
    main()
