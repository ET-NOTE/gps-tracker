"""GPS production smoke for release privacy-pdf-20261106-r1 with three fresh synthetic accounts.

Run once as root on the GPS host after `release_privacy_pdf.py apply`:

    python3 smoke_privacy_pdf.py

A synthetic two-page PDF receipt is drawn page by page by the installed processor, one page is
partly disclosed, and the delivery is invalidated, all through the public endpoints. An unreadable
and an encrypted PDF are refused. The synthetic expenses and receipts are removed and the three
accounts are closed. Delivery selection and audit metadata stay for retention review. No real
account, SIM, location, payment, email or push is changed.

This is the first PDF page the production API draws, so it also proves that the API's own
self-test of the processor passed inside its service. It writes read proofs that use the new
schema-98 columns, so the scripted rollback of the release is no longer available afterwards.
"""
import base64
import hashlib
import hmac
import json
import os
import pathlib
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid
import zlib
from datetime import datetime, timedelta, timezone

import psycopg2

RELEASE = 'privacy-pdf-20261106-r1'
SIG = b'\x89PNG\r\n\x1a\n'
RED, BLUE, WHITE, BLACK = (255, 0, 0), (0, 0, 255), (255, 255, 255), (0, 0, 0)
# The two-page document below, encrypted with a user password by qpdf (as in ops/test_privacy_receipt_pdf.py).
ENCRYPTED = 'eNqdVE2IHEUUFjw5XrwYPIWSsAeFpOu/umDZkM3MgLph465ZDyGHV1WvNyOzPUtPJ+wa8KTiRb0IIYgH/1AjHvQUT3sURVAPIigSBD14MHoyghB93bs7O2ECEfunquv9fN+rV+/13Olu/6g45jpzOzffutURjLNReKYzP8+y3laN5XgwKsesWZ7oLvbaj0UY4xpWjYZl5DpluYQXcchytrDQPNlpWMcxk4S5wrKntjeRZSehhuFondQdLFNDJacoT44ulDU5ZE8M0pidZap11e14bh9iF/UAQN0GUFIo9ZiZXdJTmAawONoiLE635JwJes81KBW2XFPBNchTwPpOwPaOwIrvvv8N2EwBL2G5Xp9nOmdZfzCssaJ5CDV2MY5S6zSuK4SNzgd//vj2izfrVz586MahP248yO45fGX773uv/vPA8fuee/jJKx+998Xla+98/cZv310/fv/Lzz+aiGvPc4/V/h/WTx959fXvPzt868vfr/6Si8d//enSkR9+3vn2q8tvPn1o+O5L37xwxOxc//iv9z/5/Ng1uPTa0gyrm05ivy2g1TrtfZ24UJ/vXWzSlXVHcXkTy8boFCl6q2tqEqaS+xW1H+xqDWWCKk1MpLEsW2bzXClnhEGhIFrpIeUSnInowYpCmKgwqcADqhi0tEhnFr0OXhSFsUXBfYHWWKNASOFBeC4cOiEsJ5V21kuKYZnaIAj0PBgro49OQ0g6GovBKakKkDJyz0FJRDDcORUtGJWM9Rx5TIKMmuZgRzWNWG1Qf2kANFrnLikCS0WRgwvcgEpOC+8s2a9Q6dG+N/r7CaSpOlicIRAsAkBuoNAGTBKcMCXoYASPBqRRxhTEYkE47TwgKB6KoIKSIWoVHeYSiS/Pc4GoaDue57lFhxxlVC5QEGdo70rQrhWl0frYpCwmVzhTBJ4KDsknB4XlIfIQokkJXB5kyK0hrECnoIFg1qg/D9phq8Kiw1ne4ZOLWUPhsoJNZIKaptWUE5lQfFbmZ+1krmdkyqkZmfZiRma5P5DVFQyGVH5N6a6MRjUTu02+OngW6a+XPdZlZ+d1QhWco3LTLjeFUM5RHdLRROtACb9wdwv6i/TKWG1v1sy1DG0/QlW3mRLC2M7cXG+53/kXCoCovQ=='


class Site:
    """The production host. The build-host rehearsal substitutes a throwaway copy."""
    environment = 'production'
    health_url = 'https://gps.serial.kr/health'
    api_url = 'https://gps.serial.kr/api/v1'
    stage = pathlib.Path('/home/mmm/gps-artifacts') / RELEASE
    env = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
    renderer = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-pdf-render')
    ops = pathlib.Path('/home/mmm/gps-ops')  # the deployed account-closure worker


def config(path):
    return {k.strip(): v.strip().strip('"').strip("'") for k, v in
            (line.split('=', 1) for line in pathlib.Path(path).read_text().splitlines()
             if '=' in line and not line.lstrip().startswith('#'))}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pdf(objects):
    data, offsets = b'%PDF-1.5\n', []
    for number, body in enumerate(objects, 1):
        offsets.append(len(data))
        data += f'{number} 0 obj\n'.encode() + (body if isinstance(body, bytes) else body.encode()) + b'\nendobj\n'
    xref = len(data)
    data += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode() + b''.join(f'{o:010} 00000 n \n'.encode() for o in offsets)
    return data + f'trailer\n<</Size {len(objects) + 1}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n'.encode()


def stream(content):
    return f'<</Length {len(content)}>>\nstream\n{content}\nendstream'


def document():
    """Page 1: 200x100pt, left half red. Page 2: 300x300pt, a blue square 60..150pt from the bottom left."""
    return pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>',
                '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>', stream('1 0 0 rg 0 0 100 100 re f'),
                '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 6 0 R>>', stream('0 0 1 rg 60 60 90 90 re f')])


def png_image(data):
    """(width, height, rows) of an 8-bit RGB PNG that has only IHDR/IDAT/IEND chunks."""
    assert data[:8] == SIG
    offset, kinds, packed = 8, [], b''
    while offset < len(data):
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        kind, value = data[offset + 4:offset + 8], data[offset + 8:offset + 8 + length]
        kinds.append(kind)
        if kind == b'IHDR':
            width, height, depth, color, _, _, _ = struct.unpack('>IIBBBBB', value)
            assert depth == 8 and color == 2
        if kind == b'IDAT':
            packed += value
        offset += length + 12
    assert set(kinds) == {b'IHDR', b'IDAT', b'IEND'}, kinds
    raw, stride, rows, previous = zlib.decompress(packed), width * 3, [], bytes(width * 3)
    assert len(raw) == height * (stride + 1)
    for y in range(height):
        kind, line = raw[y * (stride + 1)], raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)]
        if kind == 0:
            row = line
        elif kind == 2:
            row = bytes((a + b) & 255 for a, b in zip(line, previous))
        else:
            row = bytearray(line)
            for x in range(stride):
                a, b, c = (row[x - 3] if x >= 3 else 0), previous[x], (previous[x - 3] if x >= 3 else 0)
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                paeth = a if pa <= pb and pa <= pc else b if pb <= pc else c
                row[x] = (row[x] + [0, a, b, (a + b) // 2, paeth][kind]) % 256
            row = bytes(row)
        rows.append(row)
        previous = row
    return width, height, rows


def pixel(image, x, y):
    return tuple(image[2][y][x * 3:x * 3 + 3])


def main(site):
    os.umask(0o077)
    sys.path.insert(0, str(site.ops))
    from privacy_account_closure import execute

    private = site.stage / 'smoke-private.json'
    c = json.loads(private.read_text())
    assert c['email'].startswith('account-smoke-') and c['email'].endswith('@example.invalid')
    assert not c.get('users'), 'run once; inspect the private checkpoint before any retry'
    cfg = config(site.env)
    with urllib.request.urlopen(site.health_url, timeout=10) as response:
        health = json.load(response)
    assert health['release'] == RELEASE and health['environment'] == site.environment, health
    # The processor the API will start is the one that was built, verified and installed.
    renderer = sha(site.renderer.read_bytes())
    assert renderer == json.loads((site.stage / 'manifest.json').read_text())['renderer_sha256'], renderer
    db = psycopg2.connect(cfg['DATABASE_URL'])
    db.autocommit = True
    worker = psycopg2.connect(cfg['DATABASE_URL'])

    def sql(query, args=()):
        with db.cursor() as cursor:
            cursor.execute(query, args)
            row = cursor.fetchone() if cursor.description else None
            return row[0] if row else None

    def call(method, path, body=None, token=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(site.api_url + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=60)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if 'application/json' in response.headers.get('content-type', '') else raw, response.headers

    def mint(user_id):
        b64 = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
        now = int(time.time())
        message = b64(b'{"alg":"HS256","typ":"JWT"}') + '.' + b64(json.dumps({'sub': str(user_id), 'iat': now, 'exp': now + 600, 'typ': 'access'}, separators=(',', ':')).encode())
        return message + '.' + b64(hmac.new(cfg['JWT_SECRET'].encode(), message.encode(), hashlib.sha256).digest())

    def guard():
        # Real test accounts and every non-synthetic device must be byte-for-byte unchanged.
        return sql("""SELECT md5(jsonb_build_object('users',(SELECT jsonb_agg(jsonb_build_array(u.id,u.email,u.password_hash,u.role,u.display_name,c.restricted) ORDER BY u.id) FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.email IN ('user@user.com','user@user4.com')),'devices',(SELECT jsonb_agg(jsonb_build_array(id,owner_id,device_uid,iccid) ORDER BY id) FROM devices WHERE device_uid NOT LIKE 'account-smoke-%%'))::text)""")

    def checkpoint():
        private.write_text(json.dumps(c))

    admin = sql("SELECT u.id FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.role='admin' AND NOT c.restricted ORDER BY u.id LIMIT 1")
    assert admin
    at = mint(admin)

    def detail(request_id):
        return call('GET', f'/admin/privacy/requests/{request_id}', token=at)[1]['request']

    c['baseline'] = guard()
    c['users'] = []
    for suffix in ['', '-other', '-company']:
        email = c['email'].replace('@', suffix + '@')
        c['users'].append(sql("INSERT INTO users(email,password_hash,display_name,phone,phone_verified) VALUES(%s,%s,'PDF 영수증 모의 검증','01000000000',false) RETURNING id", (email, c['password_hash'])))
        checkpoint()
    uid, other, owner = c['users']
    status, login, _ = call('POST', '/auth/login', {'email': c['email'], 'password': c['password']})
    assert status == 200, status
    token = login['access_token']

    due = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    status, r, _ = call('POST', '/privacy/requests', {'request_key': str(uuid.uuid4()), 'kind': 'access', 'scope': '모의 PDF 영수증의 본인 영역만 이미지로 제공하는 검증', 'password': c['password']}, token)
    assert status == 202, status
    rid = c['request_id'] = r['id']
    checkpoint()
    status, r, _ = call('PATCH', f'/admin/privacy/requests/{rid}', {'revision': r['revision'], 'status': 'in_review', 'message': '합성 PDF 영수증 범위를 검토합니다.', 'evidence_reference': 'ROUND16-SYNTHETIC', 'due_at': due}, at)
    assert status == 200, status
    path = f'/admin/privacy/requests/{rid}'
    staff = sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'모의 검증 직원','member') RETURNING id", (owner,))
    category = sql("SELECT id FROM fleet_expense_categories WHERE owner_id=%s AND kind='expense' ORDER BY id LIMIT 1", (owner,))
    c['expenses'] = []

    def attach(content):
        expense = sql("INSERT INTO fleet_expenses(owner_id,created_by,request_id,request_value,spent_on,category_id,category_name,group_name,category_kind,staff_id,staff_name,department_name,vehicle_name,amount_krw,payment_method) VALUES(%s,%s,%s,'{}','2026-01-01',%s,'모의 항목','모의 분류','expense',%s,'모의 직원','','',1000,'cash') RETURNING id", (owner, owner, str(uuid.uuid4()), category, staff))
        c['expenses'].append(expense)
        checkpoint()
        return expense, sql("INSERT INTO fleet_expense_receipts(owner_id,expense_id,filename,mime,content,digest) VALUES(%s,%s,'synthetic.pdf','application/pdf',%s,%s) RETURNING id", (owner, expense, content, sha(content)))

    source = document()
    digest = sha(source)
    expense, receipt = attach(source)
    _, unreadable = attach(b'%PDF-1.7\n%%EOF\n')
    _, encrypted = attach(zlib.decompress(base64.b64decode(ENCRYPTED)))
    status, review, _ = call('POST', path + '/company-reviews', {'revision': detail(rid)['revision'], 'company_owner_id': owner, 'staff_id': staff, 'category': 'expenses', 'from_at': '2026-01-01T00:00:00+09:00', 'until_at': '2026-01-02T00:00:00+09:00', 'due_at': due}, at)
    assert status == 200, (status, review)
    cr = review['id']

    def scope():
        return next(v for v in call('GET', path + '/company-reviews', token=at)[1]['items'] if v['id'] == cr)

    status, response, _ = call('PATCH', f'/admin/privacy/company-reviews/{cr}', {'request_revision': detail(rid)['revision'], 'revision': scope()['revision'], 'status': 'in_review', 'identity': 'confirmed', 'identity_evidence': 'ROUND16 SYNTHETIC staff match', 'evidence_reference': '', 'internal_reason': '모의 자료 검증', 'public_message': '영수증 범위를 검토합니다.', 'due_at': due, 'outcome': '', 'confirmed': False}, at)
    assert status == 200, (status, response)
    rev = scope()['revision']
    sources = path + f'/receipt-sources/{cr}'

    def read(fid, page=None, who=at):
        return call('POST', sources + f'/{fid}', {'company_revision': rev, **({'page': page} if page is not None else {})}, who)

    def proofs(fid):
        return sql('SELECT count(*) FROM privacy_receipt_reads WHERE receipt_id=%s', (fid,))

    assert call('GET', sources + f'?company_revision={rev}', token=token)[0] == 403
    status, listed, _ = call('GET', sources + f'?company_revision={rev}', token=at)
    assert status == 200 and sorted((x['id'], x['mime']) for x in listed['items']) == sorted((f, 'application/pdf') for f in (receipt, unreadable, encrypted)), (status, listed)
    assert read(receipt, 1, token)[0] == 403

    # Page 1 and page 2, each drawn from the stored original by the installed processor.
    status, one, headers = read(receipt)
    assert status == 200, (status, one)
    assert one['normalization'] == {'version': 3, 'kind': 'pdf', 'page': 1, 'pages': 2, 'page_width_pt': 200.0, 'page_height_pt': 100.0, 'width': 1414, 'height': 707, 'renderer_sha256': renderer}, one['normalization']
    assert one['receipt']['page'] == 1 and one['sha256'] == digest and headers['Cache-Control'] == 'no-store, private'
    shown = base64.b64decode(one['data_base64'])
    assert one['display_sha256'] == sha(shown)
    image = png_image(shown)
    assert image[:2] == (1414, 707) and pixel(image, 100, 100) == RED and pixel(image, 700, 350) == RED and pixel(image, 714, 350) == WHITE and pixel(image, 1300, 100) == WHITE
    status, two, _ = read(receipt, 2)
    assert status == 200, (status, two)
    assert two['normalization'] == {**one['normalization'], 'page': 2, 'page_width_pt': 300.0, 'page_height_pt': 300.0, 'width': 1000, 'height': 1000} and two['receipt']['page'] == 2
    image = png_image(base64.b64decode(two['data_base64']))
    assert image[:2] == (1000, 1000) and pixel(image, 350, 650) == BLUE and pixel(image, 100, 100) == WHITE and pixel(image, 350, 400) == WHITE
    assert read(receipt, 3)[0] == 400
    assert sql('SELECT array_agg(page ORDER BY id) FROM privacy_receipt_reads WHERE receipt_id=%s', (receipt,)) == [1, 2]
    assert sql('SELECT count(DISTINCT pixels_sha256) FROM privacy_receipt_reads WHERE receipt_id=%s', (receipt,)) == 2

    # Documents the processor must refuse leave no read proof and do not disturb the next page.
    status, refusal, _ = read(unreadable)
    assert status == 400 and '읽을 수 없습니다' in refusal['error'] and proofs(unreadable) == 0, (status, refusal)
    status, refusal, _ = read(encrypted)
    assert status == 400 and '암호' in refusal['error'] and proofs(encrypted) == 0, (status, refusal)

    # Selection, preview and delivery are bound to page 2 as the server drew it.
    b = {'receipt': two['receipt'], 'company_review_id': cr, 'company_revision': rev, 'category': 'receipt', 'source_reference': f'SYNTHETIC expense {expense} receipt {receipt} page 2', 'source_sha256': digest, 'width': 1000, 'height': 1000, 'regions': [{'x': 300, 'y': 600, 'width': 100, 'height': 100}], 'notice': '모의 본인 영역만 포함하고 나머지는 제거했습니다.', 'rgb_base64': 'AAAA'}
    assert call('POST', path + '/image-preview', b, token)[0] == 403
    assert call('POST', path + '/image-preview', {**b, 'width': 1414, 'height': 707}, at)[0] == 400
    assert call('POST', path + '/image-preview', {**b, 'receipt': {k: v for k, v in b['receipt'].items() if k != 'page'}}, at)[0] == 400
    assert call('POST', path + '/images', {'revision': detail(rid)['revision'], 'confirmed': True, 'source_confirmed': True, 'preview_sha256': '0' * 64, **b}, at)[0] == 409
    status, preview, headers = call('POST', path + '/image-preview', b, at)
    assert status == 200 and headers['Cache-Control'] == 'no-store, private', (status, preview)
    cut = png_image(base64.b64decode(preview['png_base64']))
    assert cut[:2] == (1000, 1000) and pixel(cut, 350, 650) == BLUE
    assert all(pixel(cut, x, y) == BLACK for x, y in [(0, 0), (299, 650), (400, 650), (350, 599), (350, 700), (500, 500), (999, 999)])
    status, d, _ = call('POST', path + '/images', {'revision': detail(rid)['revision'], 'confirmed': True, 'source_confirmed': True, 'preview_sha256': preview['preview_sha256'], **b}, at)
    assert status == 200, (status, d)
    pid = c['delivery_id'] = d['id']
    checkpoint()
    assert detail(rid)['status'] == 'in_review'
    assert sql('SELECT source_page FROM privacy_image_deliveries WHERE id=%s', (pid,)) == 2
    assert sql('SELECT source_normalization FROM privacy_image_deliveries WHERE id=%s', (pid,)) == two['normalization']
    public = call('GET', f'/privacy/requests/{rid}/images', token=token)[1]
    assert len(public['items']) == 1
    assert all(x not in json.dumps(public) for x in ['source_sha256', 'source_reference', 'regions', 'created_by', 'company_review_id', 'normalization', 'source_page', 'renderer'])
    assert call('POST', f'/privacy/images/{pid}/download', {'password': c['password']}, mint(other))[0] == 404
    assert call('POST', f'/privacy/images/{pid}/download', {'password': 'wrong'}, token)[0] == 401
    status, data, headers = call('POST', f'/privacy/images/{pid}/download', {'password': c['password']}, token)
    assert status == 200 and data == base64.b64decode(preview['png_base64'])
    assert headers['Content-Type'] == 'application/octet-stream' and headers['X-Content-Type-Options'] == 'nosniff' and 'attachment' in headers['Content-Disposition']
    assert guard() == c['baseline']
    assert sql('SELECT content FROM fleet_expense_receipts WHERE id=%s', (receipt,)).tobytes() == source

    # A source change blocks the delivery and removes its temporary PNG.
    sql("UPDATE fleet_expenses SET note='모의 수정 검증' WHERE id=%s AND owner_id=%s", (expense, owner))
    assert call('POST', f'/privacy/images/{pid}/download', {'password': c['password']}, token)[0] == 409
    assert sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s', (pid,)) == 0
    assert sql('SELECT content FROM fleet_expense_receipts WHERE id=%s', (receipt,)).tobytes() == source

    # Remove only this run's synthetic sources; immutable audit rows remain.
    assert sql('SELECT email FROM users WHERE id=%s', (owner,)).startswith('account-smoke-')
    for row in c['expenses']:
        sql('DELETE FROM fleet_expenses WHERE id=%s AND owner_id=%s', (row, owner))
    assert sql('SELECT count(*) FROM fleet_expense_receipts WHERE owner_id=%s', (owner,)) == 0
    assert call('POST', f'/privacy/requests/{rid}/cancel', {'revision': detail(rid)['revision']}, token)[0] == 200
    for subject in c['users']:
        status, r, _ = call('POST', '/privacy/requests', {'request_key': str(uuid.uuid4()), 'kind': 'account_closure', 'scope': '라운드16 모의 검증 계정 이용 종료', 'password': c['password']}, mint(subject))
        assert status == 202, status
        assert call('POST', f"/admin/privacy/requests/{r['id']}/close-account", {'revision': r['revision']}, at)[0] == 200
        assert not execute(worker, r['id'])['request_fulfilled']
    assert all(sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s', (u,)) for u in c['users'])
    assert guard() == c['baseline']
    report = {'release': health['release'], 'schema': sql('SELECT max(version) FROM _sqlx_migrations'), 'request_id': rid, 'delivery_id': pid,
              'synthetic_account_ids': c['users'], 'renderer_sha256': renderer, 'pdf_pages_rendered': [[1, 1414, 707], [2, 1000, 1000]],
              'installed_processor_used_inside_the_api_service': True, 'read_proof_bound_to_page_and_pixels': True,
              'missing_page_refused': True, 'unreadable_and_encrypted_pdf_refused_without_read_proof': True,
              'selection_bound_to_page': True, 'forged_client_rgb_ignored': True,
              'excluded_pixels_removed_and_metadata_absent': True, 'preview_and_download_exact_bytes': True,
              'password_and_foreign_account_denial': True, 'source_changed_delivery_purged': True,
              'no_automatic_whole_request_completion': True, 'synthetic_source_removed': True, 'synthetic_accounts_closed': True,
              'real_accounts_and_sim_ownership_unchanged': True, 'external_messages_sent': False, 'full_erasure_confirmed': False}
    (site.stage / 'production-smoke.json').write_text(json.dumps(report, indent=2))
    return report


if __name__ == '__main__':
    print(json.dumps(main(Site()), indent=2))
