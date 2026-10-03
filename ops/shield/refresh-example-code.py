#!/usr/bin/env python3
"""Refresh example code/assets, preserving administrator text, images and visibility."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import time
import urllib.parse
from pathlib import Path

ROOT = Path('/home/mmm/shield-deploy')
spec = importlib.util.spec_from_file_location('publisher', ROOT / 'publish-examples.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
c = publisher.c
SLUGS = {'shield-uno-connect', 'shield-uno-dht11', 'shield-uno-gnss',
         'shield-uno-upload', 'shield-uno-firebase'}


def load(path):
    items = json.loads(path.read_text(encoding='utf-8'))
    assert len(items) == 5 and {i['content']['id'] for i in items} == SLUGS
    return {i['content']['id']: i for i in items}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--previous-manifest', required=True, type=Path)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    assert os.geteuid() == 0 and c.BASE == 'https://shield.serial.kr'
    os.umask(0o077)
    directory = args.directory.resolve()
    current = load(directory / 'publication.json')
    previous = load(args.previous_manifest)
    for item in current.values():
        for asset in item['assets']:
            file = (directory / asset['path']).resolve()
            assert file.is_relative_to(directory)
            assert hashlib.sha256(file.read_bytes()).hexdigest() == asset['sha256']

    admin, anon = c.Client(), c.Client()
    credentials = json.loads((ROOT / 'admin-enrollment.json').read_text())
    assert admin.call('/api/auth/login', {
        'email': credentials['email'], 'password': credentials['password']})[0] == 200
    try:
        rows = admin.call('/api/admin/posts')[1]
        before = {row['content']['id']: row for row in rows}
        plans = {}
        for slug, item in current.items():
            original = before[slug]
            old = previous[slug]
            # Refuse to replace code edited since the last known publication.
            assert original['content']['code'] in (old['content']['code'], item['content']['code']), slug
            old_assets = {a['path']: a['sha256'] for a in old['assets']}
            assert set(old_assets) == {a['path'] for a in item['assets']}
            replacements = {old_assets[a['path']]: a['sha256'] for a in item['assets']}
            content = copy.deepcopy(original['content'])
            content['code'] = item['content']['code']
            # Keep custom attachments, titles, step placement and intentional removals.
            for asset in content.get('attachments', []):
                asset['id'] = replacements.get(asset['id'], asset['id'])
            plans[slug] = content
        if not args.publish:
            print(json.dumps({'ready': sorted(plans), 'preserve': 'text, images, settings, custom attachments'}))
            return

        (directory / f'posts-before-{int(time.time())}.json').write_text(
            json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
        finance_sql = "SELECT json_build_array((SELECT count(*) FROM point_orders),(SELECT count(*) FROM sim_requests),(SELECT count(*) FROM sim_ledger),(SELECT count(*) FROM credit_entries));"
        financial = c.pg(finance_sql)
        for slug, content in plans.items():
            original = before[slug]
            if original['content'] != content:
                for asset in current[slug]['assets']:
                    file = directory / asset['path']
                    status, response = publisher.raw(admin, '/api/admin/post-files?' +
                        urllib.parse.urlencode({'name': file.name}), file.read_bytes())
                    assert status == 200 and json.loads(response)['id'] == asset['sha256']
                status, response, _ = admin.call('/api/admin/posts/' + slug, {
                    'content': content, 'published': original['published'], 'revision': original['revision']})
                assert status == 200, (slug, status, response)
            if original['published']:
                public = next(p for p in anon.call('/api/posts')[1] if p['id'] == slug)
                assert public['code'] == content['code'] and public['attachments'] == content['attachments']
                for asset in current[slug]['assets']:
                    if asset['sha256'] not in {a['id'] for a in content['attachments']}:
                        continue
                    status, body = publisher.raw(anon, '/api/post-files/' + asset['sha256'])
                    assert status == 200 and hashlib.sha256(body).hexdigest() == asset['sha256']

        after = {row['content']['id']: row for row in admin.call('/api/admin/posts')[1]}
        for slug, original in before.items():
            if slug in plans:
                assert after[slug]['content'] == plans[slug]
                assert after[slug]['published'] == original['published']
            else:
                assert after[slug] == original
        assert financial == c.pg(finance_sql)
        print(json.dumps({'refreshed': sorted(plans), 'other_posts': 'unchanged',
                          'administrator_text_images': 'preserved', 'financial_records': 'unchanged'}))
    finally:
        assert admin.call('/api/auth/logout', {})[0] == 200


if __name__ == '__main__':
    main()
