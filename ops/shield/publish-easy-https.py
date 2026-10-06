#!/usr/bin/env python3
"""Create only the new HTTPS tutorial, with verified public Drive attachments.

Run on the VPS after a backup/restore check. No app deployment, device writes,
old-post updates, start-guide changes, or financial API calls.
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
import urllib.error
import urllib.request

ROOT = Path('/home/mmm/shield-deploy')
SLUG = 'shield-uno-easy-https'
spec = importlib.util.spec_from_file_location('checks', ROOT / 'verify-production.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    assert os.geteuid() == 0 and c.BASE == 'https://shield.serial.kr'
    os.umask(0o077)
    directory = args.directory.resolve()
    item = json.loads((directory / 'publication.json').read_text())
    links = json.loads((directory / 'drive-links.json').read_text())
    content = copy.deepcopy(item['content'])
    assert content['id'] == SLUG and content['kind'] == 'example'
    assert not content['attachments'] and len(item['assets']) == 3
    assert set(links) == {a['path'] for a in item['assets']}
    for asset in item['assets']:
        file = (directory / asset['path']).resolve()
        assert file.is_relative_to(directory)
        assert hashlib.sha256(file.read_bytes()).hexdigest() == asset['sha256']
        link = links[asset['path']]
        match = re.fullmatch(r'https://drive\.google\.com/file/d/([A-Za-z0-9_-]+)/view', link['url'])
        assert match and Path(link['filename']).name == link['filename']
        # Anonymous public download, no browser session or account credentials.
        url = 'https://drive.usercontent.google.com/download?id=' + match[1] + '&export=download'
        with urllib.request.urlopen(url, timeout=45) as response:
            data = response.read(2_000_000)
        assert hashlib.sha256(data).hexdigest() == asset['sha256'], link['filename']

    admin, anon = c.Client(), c.Client()
    anon.opener = urllib.request.build_opener(NoRedirect())
    credentials = json.loads((ROOT / 'admin-enrollment.json').read_text())
    assert admin.call('/api/auth/login', {k: credentials[k] for k in ('email', 'password')})[0] == 200
    protected_sql = """SELECT json_build_object(
      'settings',(SELECT json_agg(t) FROM site_settings t),
      'order',(SELECT json_agg(t) FROM library_order t),
      'thumbnails',(SELECT json_agg(t) FROM category_thumbnails t),
      'orders',(SELECT count(*) FROM point_orders),
      'requests',(SELECT count(*) FROM sim_requests),
      'ledger',(SELECT count(*) FROM sim_ledger),
      'credits',(SELECT count(*) FROM credit_entries));"""
    try:
        protected = c.pg(protected_sql)
        status, rows, _ = admin.call('/api/admin/posts')
        assert status == 200
        existing = {r['content']['id']: r for r in rows}
        # Never overwrite this or any other post after administrators edit it.
        assert SLUG not in existing, 'Post already exists; inspect it instead of overwriting'
        print(json.dumps({'action': 'create' if args.publish else 'dry run',
                          'slug': SLUG, 'verified_drive_downloads': len(links)}))
        if not args.publish:
            return
        (directory / f'posts-before-{int(time.time())}.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
        for asset in item['assets']:
            status, file, _ = admin.call('/api/admin/post-files/drive', links[asset['path']])
            assert status == 200, ('Drive registration', status, file)
            assert file['drive_url'] == links[asset['path']]['url']
            content['attachments'].append({'id': file['id'], 'title': asset['title'], 'after_step': 0})
        status, result, _ = admin.call('/api/admin/posts/' + SLUG,
                                     {'content': content, 'published': True, 'revision': 0})
        assert status == 200, (status, result)
        public = next(p for p in anon.call('/api/posts')[1] if p['id'] == SLUG)
        assert {k: v for k, v in public.items() if k not in ('revision', 'updated_at')} == content
        for attachment, asset in zip(content['attachments'], item['assets']):
            status, body, headers = anon.call('/api/post-files/' + attachment['id'])
            headers = {k.lower(): v for k, v in headers.items()}
            assert status == 307 and body == '' and headers['cache-control'] == 'no-store'
            assert headers['location'] == links[asset['path']]['url']
        after = {r['content']['id']: r for r in admin.call('/api/admin/posts')[1]}
        assert all(after[slug] == post for slug, post in existing.items())
        assert protected == c.pg(protected_sql)
        report = {'url': c.BASE + '/examples/' + SLUG, 'revision': public['revision'],
                  'drive_files': len(links), 'existing_posts_preserved': len(existing),
                  'guide_order_thumbnails_financial': 'unchanged',
                  'hardware_validation': 'pending'}
        (directory / 'publication-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False))
    finally:
        assert admin.call('/api/auth/logout', {})[0] == 200


if __name__ == '__main__':
    main()
