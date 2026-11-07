"""GPS production smoke for release privacy-raster-20261106-r1 with three fresh synthetic accounts.

Run once as root on the GPS host after `release_privacy_raster.py apply`:

    python3 smoke_privacy_raster.py

A large synthetic JPEG receipt with an EXIF orientation is reduced, turned upright, partly
disclosed and invalidated through the public endpoints. The synthetic expense and receipt are
removed and the three accounts are closed. Delivery selection and audit metadata stay for
retention review. No real account, SIM, location, payment, email or push is changed.

This writes read proofs that use the new schema-97 columns, so the scripted rollback of the
release is no longer available afterwards.
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

RELEASE = 'privacy-raster-20261106-r1'
SIG = b'\x89PNG\r\n\x1a\n'
DC = [(0b00, 2), (0b010, 3), (0b011, 3), (0b100, 3), (0b101, 3), (0b110, 3), (0b1110, 4), (0b11110, 5),
      (0b111110, 6), (0b1111110, 7), (0b11111110, 8), (0b111111110, 9)]


class Site:
    """The production host. The build-host rehearsal substitutes a throwaway copy."""
    environment = 'production'
    health_url = 'https://gps.serial.kr/health'
    api_url = 'https://gps.serial.kr/api/v1'
    stage = pathlib.Path('/home/mmm/gps-artifacts') / RELEASE
    env = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
    ops = pathlib.Path('/home/mmm/gps-ops')  # the deployed account-closure worker


def config(path):
    return {k.strip(): v.strip().strip('"').strip("'") for k, v in
            (line.split('=', 1) for line in pathlib.Path(path).read_text().splitlines()
             if '=' in line and not line.lstrip().startswith('#'))}


def jpeg_file(width, height, block, orientation):
    """Minimal gray JPEG whose 8x8 blocks are flat: DC coefficients only, unit quantization."""
    exif = b'Exif\0\0II*\0' + struct.pack('<IHHHIHHI', 8, 1, 0x0112, 3, 1, orientation, 0, 0)
    head = (b'\xff\xd8\xff\xe1' + struct.pack('>H', len(exif) + 2) + exif + b'\xff\xdb\0\x43\0' + b'\x01' * 64
            + b'\xff\xc0' + struct.pack('>HBHHB', 11, 8, height, width, 1) + bytes([1, 0x11, 0])
            + b'\xff\xc4\0\x1f\0' + bytes([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]) + bytes(range(12))
            + b'\xff\xc4\0\x14\x10' + bytes([1] + [0] * 15) + b'\0'
            + b'\xff\xda' + struct.pack('>HB', 8, 1) + bytes([1, 0, 0, 63, 0]))
    parts, previous, memo = [], 0, {}
    for by in range((height + 7) // 8):
        for bx in range((width + 7) // 8):
            dc = 8 * (block(bx, by) - 128)
            diff, previous = dc - previous, dc
            if diff not in memo:
                category = abs(diff).bit_length()
                code, length = DC[category]
                extra = format(diff if diff >= 0 else diff + (1 << category) - 1, f'0{category}b') if category else ''
                memo[diff] = format(code, f'0{length}b') + extra + '0'
            parts.append(memo[diff])
    bits = ''.join(parts)
    bits += '1' * (-len(bits) % 8)
    return head + int(bits, 2).to_bytes(len(bits) // 8, 'big').replace(b'\xff', b'\xff\0') + b'\xff\xd9'


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


def near(found, gray):
    return all(abs(value - gray) <= 1 for value in found)


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
        c['users'].append(sql("INSERT INTO users(email,password_hash,display_name,phone,phone_verified) VALUES(%s,%s,'큰 영수증 축소 모의 검증','01000000000',false) RETURNING id", (email, c['password_hash'])))
        checkpoint()
    uid, other, owner = c['users']
    status, login, _ = call('POST', '/auth/login', {'email': c['email'], 'password': c['password']})
    assert status == 200, status
    token = login['access_token']

    due = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    status, r, _ = call('POST', '/privacy/requests', {'request_key': str(uuid.uuid4()), 'kind': 'access', 'scope': '모의 큰 영수증의 본인 영역만 축소 이미지로 제공하는 검증', 'password': c['password']}, token)
    assert status == 202, status
    rid = c['request_id'] = r['id']
    checkpoint()
    status, r, _ = call('PATCH', f'/admin/privacy/requests/{rid}', {'revision': r['revision'], 'status': 'in_review', 'message': '합성 영수증 범위를 검토합니다.', 'evidence_reference': 'ROUND15-SYNTHETIC', 'due_at': due}, at)
    assert status == 200, status
    path = f'/admin/privacy/requests/{rid}'
    staff = sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'모의 검증 직원','member') RETURNING id", (owner,))
    category = sql("SELECT id FROM fleet_expense_categories WHERE owner_id=%s AND kind='expense' ORDER BY id LIMIT 1", (owner,))
    expense = sql("INSERT INTO fleet_expenses(owner_id,created_by,request_id,request_value,spent_on,category_id,category_name,group_name,category_kind,staff_id,staff_name,department_name,vehicle_name,amount_krw,payment_method) VALUES(%s,%s,%s,'{}','2026-01-01',%s,'모의 항목','모의 분류','expense',%s,'모의 직원','','',1000,'cash') RETURNING id", (owner, owner, str(uuid.uuid4()), category, staff))
    # 4000x3000 stored sideways (EXIF 6). Quadrants: 10 / 80 on top, 160 / 240 below.
    source = jpeg_file(4000, 3000, lambda bx, by: (10 if bx < 250 else 80) if by < 188 else (160 if bx < 250 else 240), 6)
    digest = hashlib.sha256(source).hexdigest()
    receipt = sql("INSERT INTO fleet_expense_receipts(owner_id,expense_id,filename,mime,content,digest) VALUES(%s,%s,'synthetic.jpg','image/jpeg',%s,%s) RETURNING id", (owner, expense, source, digest))
    c.update(expense_id=expense, receipt_id=receipt)
    checkpoint()
    status, review, _ = call('POST', path + '/company-reviews', {'revision': detail(rid)['revision'], 'company_owner_id': owner, 'staff_id': staff, 'category': 'expenses', 'from_at': '2026-01-01T00:00:00+09:00', 'until_at': '2026-01-02T00:00:00+09:00', 'due_at': due}, at)
    assert status == 200, (status, review)
    cr = review['id']

    def scope():
        return next(v for v in call('GET', path + '/company-reviews', token=at)[1]['items'] if v['id'] == cr)

    status, response, _ = call('PATCH', f'/admin/privacy/company-reviews/{cr}', {'request_revision': detail(rid)['revision'], 'revision': scope()['revision'], 'status': 'in_review', 'identity': 'confirmed', 'identity_evidence': 'ROUND15 SYNTHETIC staff match', 'evidence_reference': '', 'internal_reason': '모의 자료 검증', 'public_message': '영수증 범위를 검토합니다.', 'due_at': due, 'outcome': '', 'confirmed': False}, at)
    assert status == 200, (status, response)
    rev = scope()['revision']
    sources = path + f'/receipt-sources/{cr}'
    assert call('GET', sources + f'?company_revision={rev}', token=token)[0] == 403
    status, listed, _ = call('GET', sources + f'?company_revision={rev}', token=at)
    assert status == 200 and [x['id'] for x in listed['items']] == [receipt], (status, listed)
    assert call('POST', sources + f'/{receipt}', {'company_revision': rev}, token)[0] == 403

    # Reduced and turned upright by the server; the stored bytes are untouched.
    status, raw, headers = call('POST', sources + f'/{receipt}', {'company_revision': rev}, at)
    assert status == 200, (status, raw)
    assert raw['normalization'] == {'version': 2, 'source_width': 4000, 'source_height': 3000, 'width': 865, 'height': 1154, 'orientation': 6, 'reduced': True}, raw['normalization']
    display = base64.b64decode(raw['data_base64'])
    assert raw['sha256'] == digest and raw['display_sha256'] == hashlib.sha256(display).hexdigest() and headers['Cache-Control'] == 'no-store, private'
    shown = png_image(display)
    assert shown[:2] == (865, 1154)
    assert near(pixel(shown, 100, 100), 160) and near(pixel(shown, 800, 100), 10) and near(pixel(shown, 100, 1000), 240) and near(pixel(shown, 800, 1000), 80)
    assert len(sql('SELECT pixels_sha256 FROM privacy_receipt_reads WHERE receipt_id=%s ORDER BY id DESC LIMIT 1', (receipt,))) == 64

    b = {'receipt': raw['receipt'], 'company_review_id': cr, 'company_revision': rev, 'category': 'receipt', 'source_reference': f'SYNTHETIC expense {expense} receipt {receipt}', 'source_sha256': digest, 'width': 865, 'height': 1154, 'regions': [{'x': 700, 'y': 50, 'width': 100, 'height': 100}], 'notice': '모의 본인 영역만 포함하고 나머지는 제거했습니다.', 'rgb_base64': 'AAAA'}
    assert call('POST', path + '/image-preview', b, token)[0] == 403
    assert call('POST', path + '/image-preview', {**b, 'width': 4000, 'height': 3000}, at)[0] == 400
    assert call('POST', path + '/images', {'revision': detail(rid)['revision'], 'confirmed': True, 'source_confirmed': True, 'preview_sha256': '0' * 64, **b}, at)[0] == 409
    status, preview, headers = call('POST', path + '/image-preview', b, at)
    assert status == 200 and headers['Cache-Control'] == 'no-store, private', (status, preview)
    cut = png_image(base64.b64decode(preview['png_base64']))
    assert cut[:2] == (865, 1154) and near(pixel(cut, 750, 100), 10)
    assert all(pixel(cut, x, y) == (0, 0, 0) for x, y in [(0, 0), (699, 100), (800, 100), (750, 49), (750, 150), (100, 1000), (864, 1153)])
    status, d, _ = call('POST', path + '/images', {'revision': detail(rid)['revision'], 'confirmed': True, 'source_confirmed': True, 'preview_sha256': preview['preview_sha256'], **b}, at)
    assert status == 200, (status, d)
    pid = c['delivery_id'] = d['id']
    checkpoint()
    assert detail(rid)['status'] == 'in_review'
    assert sql('SELECT source_normalization FROM privacy_image_deliveries WHERE id=%s', (pid,)) == raw['normalization']
    public = call('GET', f'/privacy/requests/{rid}/images', token=token)[1]
    assert len(public['items']) == 1
    assert all(x not in json.dumps(public) for x in ['source_sha256', 'source_reference', 'regions', 'created_by', 'company_review_id', 'normalization', 'source_width'])
    assert call('POST', f'/privacy/images/{pid}/download', {'password': c['password']}, mint(other))[0] == 404
    assert call('POST', f'/privacy/images/{pid}/download', {'password': 'wrong'}, token)[0] == 401
    status, data, headers = call('POST', f'/privacy/images/{pid}/download', {'password': c['password']}, token)
    assert status == 200 and data == base64.b64decode(preview['png_base64'])
    assert headers['Content-Type'] == 'application/octet-stream' and headers['X-Content-Type-Options'] == 'nosniff' and 'attachment' in headers['Content-Disposition']
    assert guard() == c['baseline']
    assert sql('SELECT content FROM fleet_expense_receipts WHERE id=%s', (receipt,)).tobytes() == source

    # A source change blocks the reduced delivery and removes its temporary PNG.
    sql("UPDATE fleet_expenses SET note='모의 수정 검증' WHERE id=%s AND owner_id=%s", (expense, owner))
    assert call('POST', f'/privacy/images/{pid}/download', {'password': c['password']}, token)[0] == 409
    assert sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s', (pid,)) == 0
    assert sql('SELECT content FROM fleet_expense_receipts WHERE id=%s', (receipt,)).tobytes() == source

    # Remove only this run's synthetic source; immutable audit rows remain.
    assert sql('SELECT email FROM users WHERE id=%s', (owner,)).startswith('account-smoke-')
    sql('DELETE FROM fleet_expenses WHERE id=%s AND owner_id=%s', (expense, owner))
    assert sql('SELECT count(*) FROM fleet_expense_receipts WHERE id=%s', (receipt,)) == 0
    assert call('POST', f'/privacy/requests/{rid}/cancel', {'revision': detail(rid)['revision']}, token)[0] == 200
    for subject in c['users']:
        status, r, _ = call('POST', '/privacy/requests', {'request_key': str(uuid.uuid4()), 'kind': 'account_closure', 'scope': '라운드15 모의 검증 계정 이용 종료', 'password': c['password']}, mint(subject))
        assert status == 202, status
        assert call('POST', f"/admin/privacy/requests/{r['id']}/close-account", {'revision': r['revision']}, at)[0] == 200
        assert not execute(worker, r['id'])['request_fulfilled']
    assert all(sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s', (u,)) for u in c['users'])
    assert guard() == c['baseline']
    report = {'release': health['release'], 'schema': sql('SELECT max(version) FROM _sqlx_migrations'), 'request_id': rid, 'delivery_id': pid,
              'synthetic_account_ids': c['users'], 'large_source_reduced': [4000, 3000, 865, 1154], 'exif_orientation_applied': 6,
              'read_proof_bound_to_pixels': True, 'selection_in_reduced_coordinates': True, 'forged_client_rgb_ignored': True,
              'excluded_pixels_removed_and_metadata_absent': True, 'preview_and_download_exact_bytes': True,
              'password_and_foreign_account_denial': True, 'source_changed_delivery_purged': True,
              'no_automatic_whole_request_completion': True, 'synthetic_source_removed': True, 'synthetic_accounts_closed': True,
              'real_accounts_and_sim_ownership_unchanged': True, 'external_messages_sent': False, 'full_erasure_confirmed': False}
    (site.stage / 'production-smoke.json').write_text(json.dumps(report, indent=2))
    return report


if __name__ == '__main__':
    print(json.dumps(main(Site()), indent=2))
