"""Functional check of the GPS API after `runtime_account.py apply`, with three fresh synthetic accounts.

Run once as root on the GPS host:

    python3 smoke_runtime_account.py

It confirms that the API and its cleanup workers work as the runtime account, through the real
paths: sign-in and token refresh, location ingest, a file the API writes and reads back, a PDF
page drawn by the processor the API starts, and the two timer-driven workers (removal of an
orphaned file, processing of account closures). Everything it creates is synthetic: the vehicle,
expenses and receipts are removed again and the three accounts are closed. No real account, SIM,
location, payment, email or push is changed.

On production no synthetic location is sent: ingest is confirmed from real device reports that
arrived since the API was restarted.
"""
import base64
import grp
import hashlib
import hmac
import json
import os
import pathlib
import pwd
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import zlib
from datetime import datetime, timedelta, timezone

import psycopg2

SIG = b'\x89PNG\r\n\x1a\n'
RED, BLUE, WHITE, BLACK = (255, 0, 0), (0, 0, 255), (255, 255, 255), (0, 0, 0)


class Site:
    """The production host. The build-host rehearsal substitutes a throwaway copy."""
    environment = 'production'
    account = 'gps-api'            # who the API and the workers must run as
    health_url = 'https://gps.serial.kr/health'
    api_url = 'https://gps.serial.kr/api/v1'
    ingest_url = None              # only the rehearsal sends a synthetic location
    stage = pathlib.Path('/home/mmm/gps-artifacts/runtime-account-20261106')
    private = 'smoke-private.json'
    env = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
    renderer = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-pdf-render')
    timer_wait = 200               # the workers run every two minutes


def config(path):
    return {k.strip(): v.strip().strip('"').strip("'") for k, v in
            (line.split('=', 1) for line in pathlib.Path(path).read_text().splitlines()
             if '=' in line and not line.lstrip().startswith('#'))}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def chunk(kind, value):
    return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value) & 0xffffffff)


def png(width, height, rgb):
    """A plain 8-bit RGB PNG of one colour."""
    row = b'\0' + bytes(rgb) * width
    return SIG + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(row * height)) + chunk(b'IEND', b'')


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


def unit(name, *properties):
    out = subprocess.run(['systemctl', 'show', name, *[f'-p{p}' for p in properties]], check=True, capture_output=True, text=True).stdout
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def main(site):
    os.umask(0o077)
    private = site.stage / site.private
    c = json.loads(private.read_text())
    assert c['email'].startswith('account-smoke-') and c['email'].endswith('@example.invalid')
    assert not c.get('users'), 'run once; inspect the private checkpoint before any retry'
    cfg = config(site.env)
    with urllib.request.urlopen(site.health_url, timeout=10) as response:
        health = json.load(response)
    assert health['ok'] and health['db'] and health['environment'] == site.environment, health

    # Who the API is, as the kernel reports it.
    service = unit('gps-tracker-api.service', 'MainPID', 'User', 'NRestarts')
    status = dict(line.split(':', 1) for line in pathlib.Path(f"/proc/{service['MainPID']}/status").read_text().splitlines() if ':' in line)
    owner = pwd.getpwuid(int(status['Uid'].split()[0]))
    assert service['User'] == owner.pw_name == site.account, (service['User'], owner.pw_name)
    workers = {name: unit(name, 'User')['User'] for name in ('gps-privacy-accounts.service', 'gps-privacy-files.service')}
    assert set(workers.values()) == {site.account}, workers
    started = datetime.fromtimestamp(os.stat(f"/proc/{service['MainPID']}").st_mtime, timezone.utc)  # when the API process began

    db = psycopg2.connect(cfg['DATABASE_URL'])
    db.autocommit = True

    def sql(query, args=()):
        with db.cursor() as cursor:
            cursor.execute(query, args)
            row = cursor.fetchone() if cursor.description else None
            return row[0] if row else None

    def call(method, path, body=None, token=None, raw=None, content='application/json'):
        headers = {'Content-Type': content}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(site.api_url + path, data=data, method=method, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=60)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            answer = response.read()
            return response.status, json.loads(answer) if 'application/json' in response.headers.get('content-type', '') else answer, response.headers

    def mint(user_id):
        b64 = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
        now = int(time.time())
        message = b64(b'{"alg":"HS256","typ":"JWT"}') + '.' + b64(json.dumps({'sub': str(user_id), 'iat': now, 'exp': now + 900, 'typ': 'access'}, separators=(',', ':')).encode())
        return message + '.' + b64(hmac.new(cfg['JWT_SECRET'].encode(), message.encode(), hashlib.sha256).digest())

    def guard():
        # Every account this run did not create and every non-synthetic device must be unchanged.
        return sql("""SELECT md5(jsonb_build_object('users',(SELECT jsonb_agg(jsonb_build_array(u.id,u.email,u.role,c.restricted) ORDER BY u.id) FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.email NOT LIKE 'account-smoke-%%'),'devices',(SELECT jsonb_agg(jsonb_build_array(id,owner_id,device_uid,iccid) ORDER BY id) FROM devices WHERE device_uid NOT LIKE 'account-smoke-%%'))::text)""")

    def checkpoint():
        private.write_text(json.dumps(c))

    def wait(condition, what):
        for _ in range(site.timer_wait):
            if condition():
                return
            time.sleep(1)
        raise AssertionError(f'{what} did not happen within {site.timer_wait} s')

    admin = sql("SELECT u.id FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.role='admin' AND NOT c.restricted ORDER BY u.id LIMIT 1")
    assert admin
    at = mint(admin)

    def detail(request_id):
        return call('GET', f'/admin/privacy/requests/{request_id}', token=at)[1]['request']

    c['baseline'] = guard()
    c['users'] = []
    for suffix in ['', '-other', '-company']:
        email = c['email'].replace('@', suffix + '@')
        c['users'].append(sql("INSERT INTO users(email,password_hash,display_name,phone,phone_verified) VALUES(%s,%s,'실행 계정 분리 모의 검증','01000000000',false) RETURNING id", (email, c['password_hash'])))
        checkpoint()
    uid, other, company = c['users']

    # ---- sign-in and tokens ------------------------------------------------------------------
    assert call('POST', '/auth/login', {'email': c['email'], 'password': 'wrong-' + c['password']})[0] == 401
    status_code, login, _ = call('POST', '/auth/login', {'email': c['email'], 'password': c['password']})
    assert status_code == 200, status_code
    token = login['access_token']
    assert call('GET', '/auth/me', token=token)[0] == 200
    status_code, renewed, _ = call('POST', '/auth/refresh', {'refresh_token': login['refresh_token']})
    assert status_code == 200 and call('GET', '/auth/me', token=renewed['access_token'])[0] == 200, status_code
    token = renewed['access_token']
    company_token = mint(company)

    # ---- ingest ------------------------------------------------------------------------------
    if site.ingest_url:
        tag = uuid.uuid4().hex[:12]
        sim = '89882280777' + str(int(tag, 16))[-8:]
        key, auth = hashlib.sha256(b'synthetic-runtime-key').digest(), 'account-smoke-' + tag
        device = sql("INSERT INTO devices(device_uid,iccid,owner_id,api_key_hash,display_name) VALUES(%s,%s,%s,'fixture','synthetic') RETURNING id", ('account-smoke-' + tag, sim, uid))
        sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)', (auth, key, uid))
        body = json.dumps({'iccid': sim, 'l80': {'fix': True, 'lat': 37.5, 'lng': 127.0}}, separators=(',', ':')).encode()
        signature = hmac.new(key, f'{auth}\n1\n'.encode() + body, hashlib.sha256).hexdigest()
        request = urllib.request.Request(site.ingest_url, data=body, headers={'Content-Type': 'application/json', 'X-GPS-Auth-Version': '2', 'X-GPS-UID': auth, 'X-GPS-Counter': '1', 'X-GPS-Signature': signature})
        with urllib.request.urlopen(request, timeout=20) as response:
            ack = json.load(response)
        assert hmac.compare_digest(ack['signature'], hmac.new(key, f"response\n{auth}\n1\n{ack['payload']}".encode(), hashlib.sha256).hexdigest())
        assert json.loads(base64.b64decode(ack['payload']))['stored'] is True, ack
        assert sql('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s', (device, uid)) == 1
        ingest = {'synthetic_signed_report_stored': True}
    else:
        # Real devices only. If one was reporting before the restart, it must be stored again after it.
        before = sql("SELECT count(*) FROM location_records WHERE recorded_at >= %s - interval '10 minutes' AND recorded_at < %s", (started, started))
        if before:
            wait(lambda: sql('SELECT count(*) FROM location_records WHERE recorded_at >= %s', (started,)) > 0, 'a real device report after the API restart')
        ingest = {'real_reports_in_the_10_minutes_before_restart': before,
                  'real_reports_since_restart': sql('SELECT count(*) FROM location_records WHERE recorded_at >= %s', (started,))}

    # ---- a file the API writes, reads back, and the worker removes ----------------------------
    vehicle = sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'모의 검증 차량') RETURNING id", (company,))
    c['vehicle_id'] = vehicle
    checkpoint()
    picture, boundary = png(8, 8, (10, 120, 200)), uuid.uuid4().hex
    form = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
            + picture + f'\r\n--{boundary}--\r\n'.encode())
    status_code, stored, _ = call('POST', f'/corporate/vehicles/{vehicle}/photo', token=company_token, raw=form, content=f'multipart/form-data; boundary={boundary}')
    assert status_code == 200, (status_code, stored)
    root = pathlib.Path(cfg.get('PRIVATE_UPLOAD_DIR') or str(pathlib.Path(cfg.get('UPLOAD_DIR', '/home/mmm/uploads')).with_name('gps-private-uploads')))
    file = root / 'car-images' / stored['url'].rsplit('/', 1)[1]
    info = file.stat()
    assert file.read_bytes() == picture and pwd.getpwuid(info.st_uid).pw_name == site.account and grp.getgrgid(info.st_gid).gr_name == site.account, (info.st_uid, info.st_gid)
    file_mode = info.st_mode & 0o777
    status_code, shown, _ = call('GET', f'/corporate/vehicles/{vehicle}/photo', token=company_token)
    assert status_code == 200 and shown == picture
    assert call('GET', f'/corporate/vehicles/{vehicle}/photo', token=token)[0] == 404
    sql('DELETE FROM fleet_vehicles WHERE id=%s AND owner_id=%s', (vehicle, company))
    assert sql("SELECT state FROM privacy_file_cleanup WHERE storage_kind='car_image' AND storage_key=%s", (stored['url'],)) in ('pending', 'local_absent')

    # ---- a PDF page drawn by the processor the API starts ------------------------------------
    renderer = sha(site.renderer.read_bytes())
    due = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    status_code, r, _ = call('POST', '/privacy/requests', {'request_key': str(uuid.uuid4()), 'kind': 'access', 'scope': '실행 계정 분리 뒤 모의 PDF 영수증 제공 검증', 'password': c['password']}, token)
    assert status_code == 202, status_code
    rid = c['request_id'] = r['id']
    checkpoint()
    status_code, r, _ = call('PATCH', f'/admin/privacy/requests/{rid}', {'revision': r['revision'], 'status': 'in_review', 'message': '합성 PDF 영수증 범위를 검토합니다.', 'evidence_reference': 'RUNTIME-ACCOUNT-SYNTHETIC', 'due_at': due}, at)
    assert status_code == 200, status_code
    path = f'/admin/privacy/requests/{rid}'
    staff = sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'모의 검증 직원','member') RETURNING id", (company,))
    category = sql("SELECT id FROM fleet_expense_categories WHERE owner_id=%s AND kind='expense' ORDER BY id LIMIT 1", (company,))
    c['expenses'] = []

    def attach(content):
        expense = sql("INSERT INTO fleet_expenses(owner_id,created_by,request_id,request_value,spent_on,category_id,category_name,group_name,category_kind,staff_id,staff_name,department_name,vehicle_name,amount_krw,payment_method) VALUES(%s,%s,%s,'{}','2026-01-01',%s,'모의 항목','모의 분류','expense',%s,'모의 직원','','',1000,'cash') RETURNING id", (company, company, str(uuid.uuid4()), category, staff))
        c['expenses'].append(expense)
        checkpoint()
        return expense, sql("INSERT INTO fleet_expense_receipts(owner_id,expense_id,filename,mime,content,digest) VALUES(%s,%s,'synthetic.pdf','application/pdf',%s,%s) RETURNING id", (company, expense, content, sha(content)))

    source = document()
    expense, receipt = attach(source)
    _, unreadable = attach(b'%PDF-1.7\n%%EOF\n')
    status_code, review, _ = call('POST', path + '/company-reviews', {'revision': detail(rid)['revision'], 'company_owner_id': company, 'staff_id': staff, 'category': 'expenses', 'from_at': '2026-01-01T00:00:00+09:00', 'until_at': '2026-01-02T00:00:00+09:00', 'due_at': due}, at)
    assert status_code == 200, (status_code, review)
    cr = review['id']

    def scope():
        return next(v for v in call('GET', path + '/company-reviews', token=at)[1]['items'] if v['id'] == cr)

    status_code, answer, _ = call('PATCH', f'/admin/privacy/company-reviews/{cr}', {'request_revision': detail(rid)['revision'], 'revision': scope()['revision'], 'status': 'in_review', 'identity': 'confirmed', 'identity_evidence': 'RUNTIME-ACCOUNT SYNTHETIC staff match', 'evidence_reference': '', 'internal_reason': '모의 자료 검증', 'public_message': '영수증 범위를 검토합니다.', 'due_at': due, 'outcome': '', 'confirmed': False}, at)
    assert status_code == 200, (status_code, answer)
    rev = scope()['revision']
    sources = path + f'/receipt-sources/{cr}'
    status_code, one, _ = call('POST', sources + f'/{receipt}', {'company_revision': rev}, at)
    assert status_code == 200, (status_code, one)
    assert one['normalization'] == {'version': 3, 'kind': 'pdf', 'page': 1, 'pages': 2, 'page_width_pt': 200.0, 'page_height_pt': 100.0, 'width': 1414, 'height': 707, 'renderer_sha256': renderer}, one['normalization']
    image = png_image(base64.b64decode(one['data_base64']))
    assert image[:2] == (1414, 707) and pixel(image, 100, 100) == RED and pixel(image, 1300, 100) == WHITE
    status_code, two, _ = call('POST', sources + f'/{receipt}', {'company_revision': rev, 'page': 2}, at)
    assert status_code == 200 and two['normalization']['page'] == 2, (status_code, two)
    image = png_image(base64.b64decode(two['data_base64']))
    assert image[:2] == (1000, 1000) and pixel(image, 350, 650) == BLUE and pixel(image, 100, 100) == WHITE
    status_code, refusal, _ = call('POST', sources + f'/{unreadable}', {'company_revision': rev}, at)
    assert status_code == 400 and sql('SELECT count(*) FROM privacy_receipt_reads WHERE receipt_id=%s', (unreadable,)) == 0, (status_code, refusal)
    b = {'receipt': two['receipt'], 'company_review_id': cr, 'company_revision': rev, 'category': 'receipt', 'source_reference': f'SYNTHETIC expense {expense} receipt {receipt} page 2', 'source_sha256': sha(source), 'width': 1000, 'height': 1000, 'regions': [{'x': 300, 'y': 600, 'width': 100, 'height': 100}], 'notice': '모의 본인 영역만 포함하고 나머지는 제거했습니다.', 'rgb_base64': 'AAAA'}
    status_code, preview, _ = call('POST', path + '/image-preview', b, at)
    assert status_code == 200, (status_code, preview)
    cut = png_image(base64.b64decode(preview['png_base64']))
    assert pixel(cut, 350, 650) == BLUE and pixel(cut, 0, 0) == BLACK and pixel(cut, 500, 500) == BLACK
    status_code, d, _ = call('POST', path + '/images', {'revision': detail(rid)['revision'], 'confirmed': True, 'source_confirmed': True, 'preview_sha256': preview['preview_sha256'], **b}, at)
    assert status_code == 200, (status_code, d)
    pid = c['delivery_id'] = d['id']
    checkpoint()
    assert call('POST', f'/privacy/images/{pid}/download', {'password': c['password']}, mint(other))[0] == 404
    status_code, data, _ = call('POST', f'/privacy/images/{pid}/download', {'password': c['password']}, token)
    assert status_code == 200 and data == base64.b64decode(preview['png_base64'])
    # A source change blocks the delivery and removes its temporary PNG.
    sql("UPDATE fleet_expenses SET note='모의 수정 검증' WHERE id=%s AND owner_id=%s", (expense, company))
    assert call('POST', f'/privacy/images/{pid}/download', {'password': c['password']}, token)[0] == 409
    assert sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s', (pid,)) == 0
    # One processor per page, none left behind.
    assert subprocess.run(['pgrep', '-c', 'gps-pdf-render'], capture_output=True, text=True).stdout.strip() in ('', '0')

    # ---- the two workers, started by their timers as the runtime account -----------------------
    assert sql('SELECT email FROM users WHERE id=%s', (company,)).startswith('account-smoke-')
    for row in c['expenses']:
        sql('DELETE FROM fleet_expenses WHERE id=%s AND owner_id=%s', (row, company))
    assert sql('SELECT count(*) FROM fleet_expense_receipts WHERE owner_id=%s', (company,)) == 0
    assert call('POST', f'/privacy/requests/{rid}/cancel', {'revision': detail(rid)['revision']}, token)[0] == 200
    closures = []
    for subject in c['users']:
        status_code, r, _ = call('POST', '/privacy/requests', {'request_key': str(uuid.uuid4()), 'kind': 'account_closure', 'scope': '실행 계정 분리 모의 검증 계정 이용 종료', 'password': c['password']}, mint(subject))
        assert status_code == 202, status_code
        assert call('POST', f"/admin/privacy/requests/{r['id']}/close-account", {'revision': r['revision']}, at)[0] == 200
        closures.append(r['id'])
    c['closures'] = closures
    checkpoint()
    assert all(sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s', (u,)) for u in c['users'])
    wait(lambda: not file.exists() and sql("SELECT state FROM privacy_file_cleanup WHERE storage_kind='car_image' AND storage_key=%s", (stored['url'],)) == 'local_absent',
         'removal of the orphaned file by the file cleanup worker')
    wait(lambda: sql("SELECT count(*) FROM privacy_account_closures WHERE request_id = ANY(%s) AND state='restricted'", (closures,)) == 0,
         'processing of the account closures by the closure worker')
    states = sql("SELECT jsonb_agg(jsonb_build_array(state,coalesce(last_error,'')) ORDER BY request_id) FROM privacy_account_closures WHERE request_id = ANY(%s)", (closures,))
    assert all(state == 'review_required' and not error for state, error in states), states
    if site.ingest_url:
        assert sql('SELECT count(*) FROM location_records WHERE device_id=%s', (device,)) == 0  # removed with the closed account's own scope
    assert guard() == c['baseline']
    report = {'release': health['release'], 'environment': health['environment'], 'schema': sql('SELECT max(version) FROM _sqlx_migrations'),
              'api_runs_as': owner.pw_name, 'workers_run_as': workers, 'api_no_new_privileges': int(status['NoNewPrivs']) == 1,
              'api_capabilities': int(status['CapEff'], 16), 'synthetic_account_ids': c['users'], 'request_id': rid, 'delivery_id': pid,
              'sign_in_refresh_and_wrong_password': True, 'ingest': ingest,
              'file_written_by_api_owned_by': site.account, 'file_mode': f'{file_mode:o}', 'file_read_back_and_foreign_account_denied': True,
              'orphaned_file_removed_by_timer_worker': True, 'pdf_pages_rendered_by_installed_processor': [[1, 1414, 707], [2, 1000, 1000]],
              'renderer_sha256': renderer, 'unreadable_pdf_refused_without_read_proof': True, 'delivery_download_and_source_change_purge': True,
              'account_closures_processed_by_timer_worker': len(closures), 'synthetic_source_removed': True, 'synthetic_accounts_closed': True,
              'real_accounts_and_sim_ownership_unchanged': True, 'external_messages_sent': False}
    (site.stage / 'runtime-account-smoke.json').write_text(json.dumps(report, indent=2))
    return report


if __name__ == '__main__':
    print(json.dumps(main(Site()), indent=2))
