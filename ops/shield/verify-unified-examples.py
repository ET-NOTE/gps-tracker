#!/usr/bin/env python3
"""Read-only verification of a completed/partially reported classroom publication."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path('/home/mmm/shield-deploy')
spec = importlib.util.spec_from_file_location('checks', ROOT / 'verify-production.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0 and c.BASE == 'https://shield.serial.kr'
    directory = args.directory
    expected = json.loads((directory / 'applied-posts.json').read_text())
    before = {r['content']['id']: r for r in json.loads(sorted(directory.glob('posts-before-*.json'))[-1].read_text())}
    faqs_before = {r['id']: r for r in json.loads((directory / 'faqs-admin-before.json').read_text())}
    links = json.loads((directory / 'drive-links.json').read_text())
    admin, anon = c.Client(), c.Client()
    anon.opener = urllib.request.build_opener(NoRedirect())
    credentials = json.loads((ROOT / 'admin-enrollment.json').read_text())
    assert admin.call('/api/auth/login', {k: credentials[k] for k in ('email', 'password')})[0] == 200
    try:
        after = {r['content']['id']: r for r in admin.call('/api/admin/posts')[1]}
        public = {r['id']: r for r in anon.call('/api/posts')[1]}
        assert len(expected) == 11 and set(after) == set(before)
        file_ids = set()
        for slug, old in before.items():
            if slug not in expected:
                assert after[slug] == old
                continue
            desired = expected[slug]
            # The API canonicalizes an omitted empty image list on legacy seeds.
            desired.setdefault('images', [])
            assert after[slug]['content'] == desired, ('Stored content', slug)
            assert {k: v for k, v in public[slug].items() if k not in ('revision', 'updated_at')} == desired
            assert after[slug]['revision'] == old['revision'] + 1 and after[slug]['published']
            assert sorted(i['id'] for i in desired['images']) == sorted(i['id'] for i in old['content'].get('images', []))
            file_ids.update(a['id'] for a in desired.get('attachments', []))
            assert all(word not in json.dumps(desired) for word in ('SHIELD_UID', 'SHIELD_DEMO_UID', 'SHIELD_DEVICE_UID', 'YOUR_DEVICE_UID'))
        assert len(file_ids) == 24
        urls = {x['url'] for x in links.values()}
        for identifier in file_ids:
            status, body, headers = anon.call('/api/post-files/' + identifier)
            headers = {k.lower(): v for k, v in headers.items()}
            assert status == 307 and not body and headers['cache-control'] == 'no-store' and headers['location'] in urls
        faqs_after = {r['id']: r for r in admin.call('/api/admin/faqs')[1]}
        for identifier, row in faqs_before.items():
            latest = faqs_after[identifier]
            if identifier in (2, 9):
                assert latest['revision'] == row['revision'] + 1 and latest['answer'] != row['answer']
                assert all(latest[k] == row[k] for k in ('category', 'question', 'published', 'archived', 'position'))
                assert '등록 코드' in latest['answer']
            else:
                assert latest == row
        with tarfile.open('/var/backups/shield/shield-20261006T122139Z.tar.gz') as archive:
            metadata = json.load(archive.extractfile('metadata.json'))
        counts = metadata['counts_after_dump']
        for table in ('users', 'devices', 'point_orders', 'sim_requests', 'sim_ledger', 'credit_entries', 'site_settings', 'category_thumbnails', 'library_order'):
            assert int(c.pg('SELECT count(*) FROM ' + table)) == counts[table], table
        if 'library_order_data' in counts:
            assert json.loads(c.pg("SELECT content || jsonb_build_object('revision',revision) FROM library_order WHERE singleton")) == counts['library_order_data']
        if 'category_thumbnails_data' in counts:
            assert json.loads(c.pg("SELECT coalesce(json_object_agg(category,json_build_object('image_id',image_id,'alt',alt,'revision',revision)),'{}'::json) FROM category_thumbnails")) == counts['category_thumbnails_data']
        report = {'posts': {slug: after[slug]['revision'] for slug in expected}, 'other_posts_preserved': len(before)-len(expected),
                  'photos': 'all retained', 'drive_redirects': len(file_ids), 'faq_updated': [2, 9],
                  'account_device_financial_counts': 'unchanged', 'category_order_thumbnails': 'unchanged',
                  'hardware_validation': 'pending'}
        (directory / 'publication-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False))
    finally:
        assert admin.call('/api/auth/logout', {})[0] == 200


if __name__ == '__main__':
    main()
