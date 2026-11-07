"""Functional check of release privacy-facts-20261106-r1 with three fresh synthetic accounts.

Run once as root on the GPS host, after `release_privacy_facts.py apply`:

    python3 smoke_privacy_facts.py

A synthetic access request is taken into review; a grant with the collection, use and provision
facts is issued for a period, refused without one, downloaded by its subject only, and revoked,
all through the public endpoints. A grant without the section still works as before. No location
record, device or share link is created: the synthetic subject has none, so the facts are empty
except for one synthetic company link, and the file must say so in the released structure.
A second synthetic account holds a company link of its own, which must not appear in that file.

Expiry is checked on the synthetic grant without the section. The API offers no shorter validity
to ask for, so that row's two times are moved back past its 24 hours by SQL, the download is
refused, and the times are put back before the grant is revoked through the API.

The grants issued before this check are read through the administrator's list and must be the
same stored rows at the end.

It also measures, read-only and without naming anyone, how long the daily collection summary of
a year takes for the three accounts with the most reports of the last week. Nothing of those
accounts is shown or changed.

The synthetic company links are removed and the three accounts are closed. No real account, SIM,
location, payment, email or push is changed.

This revision adds the expiry, no-token, second-account and earlier-grant checks to the script
staged with the release. It runs from a directory of its own, so the staged files stay as the
release manifest lists them; it reads the one-time credential from the staged directory and
writes its report there.
"""
import base64
import hashlib
import hmac
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

import psycopg2

RELEASE = 'privacy-facts-20261106-r1'
SCHEMA = 99
# The cost of the daily collection summary of one account for a year, as the download computes it.
DAILY = """SELECT count(*),COALESCE(sum(reports),0),COALESCE(sum(points),0) FROM (
 SELECT count(*) AS reports,sum(CASE WHEN l.fixes_jsonb IS NULL THEN l.fix::int WHEN jsonb_typeof(l.fixes_jsonb)='array' THEN jsonb_array_length(l.fixes_jsonb) ELSE 0 END) AS points
 FROM location_records l WHERE l.user_id=%s AND l.recorded_at>=now()-interval '366 days' AND l.recorded_at<now()
 AND NOT EXISTS(SELECT 1 FROM fleet_vehicle_bindings b WHERE b.device_id=l.device_id)
 AND NOT EXISTS(SELECT 1 FROM device_data_controls c WHERE c.device_id=l.device_id AND c.blocked)
 GROUP BY l.device_id,(l.recorded_at AT TIME ZONE 'Asia/Seoul')::date,l.source) x"""
BUSIEST = """SELECT user_id FROM location_records WHERE recorded_at>now()-interval '7 days' AND user_id IS NOT NULL
 GROUP BY user_id ORDER BY count(*) DESC LIMIT 3"""
# The grants issued before this check, as stored, and how many of them the download would refuse.
EARLIER = "SELECT md5(COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text,'')) FROM privacy_account_packages p WHERE p.id=ANY(%s::bigint[])"
REFUSED = """SELECT count(*) FROM privacy_account_packages p JOIN privacy_requests r ON r.id=p.request_id
 WHERE p.id=ANY(%s::bigint[]) AND (p.revoked_at IS NOT NULL OR p.expires_at<=now() OR r.status IN ('cancelled','rejected'))"""


class Site:
    """The production host. The build-host rehearsal substitutes its own addresses."""
    environment = 'production'
    health_url = 'https://gps.serial.kr/health'
    api_url = 'https://gps.serial.kr/api/v1'
    stage = pathlib.Path('/home/mmm/gps-artifacts') / RELEASE
    private = 'smoke-private.json'  # one-time credential
    env = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
    ops = pathlib.Path('/home/mmm/gps-ops')  # the deployed account-closure worker


def config(path):
    return {k.strip(): v.strip().strip('"').strip("'") for k, v in
            (line.split('=', 1) for line in pathlib.Path(path).read_text().splitlines()
             if '=' in line and not line.lstrip().startswith('#'))}


def moment(text):
    return datetime.fromisoformat(text.replace('Z', '+00:00'))


def timing(url):
    """Seconds for the daily summary of a year, for the busiest accounts. Reads only; no identity leaves here."""
    probe = psycopg2.connect(url)
    probe.set_session(readonly=True, autocommit=True)
    measured = []
    try:
        with probe.cursor() as q:
            q.execute("SET statement_timeout='20s'")
            q.execute(BUSIEST)
            for rank, (account,) in enumerate(q.fetchall(), 1):
                start = time.monotonic()
                try:
                    q.execute(DAILY, (account,))
                    rows, reports, points = q.fetchone()
                    seconds = round(time.monotonic() - start, 2)
                    measured.append({'rank': rank, 'seconds': seconds, 'daily_rows': rows, 'stored_reports': int(reports), 'points': int(points),
                                     'fits_one_download': seconds < 10 and rows <= 4000})
                except psycopg2.errors.QueryCanceled:
                    measured.append({'rank': rank, 'seconds': 'more than 20', 'fits_one_download': False})
    finally:
        probe.close()
    return measured


def main(site):
    os.umask(0o077)
    sys.path.insert(0, str(site.ops))
    from privacy_account_closure import execute

    private = site.stage / site.private
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

    def rows(query, args=()):
        with db.cursor() as cursor:
            cursor.execute(query, args)
            return cursor.fetchall()

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
            return response.status, json.loads(raw) if 'application/json' in response.headers.get('content-type', '') else raw, response.headers, raw

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

    assert sql('SELECT max(version) FROM _sqlx_migrations') == SCHEMA
    admin = sql("SELECT u.id FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.role='admin' AND NOT c.restricted ORDER BY u.id LIMIT 1")
    assert admin
    at = mint(admin)
    before = sql('SELECT count(*) FROM privacy_account_packages')
    earlier = rows('SELECT id,request_id FROM privacy_account_packages ORDER BY id')
    earlier_ids = [grant_id for grant_id, _ in earlier]
    c['earlier'] = sql(EARLIER, (earlier_ids,))
    c['baseline'] = guard()
    c['users'] = []
    for suffix in ['', '-other', '-company']:
        email = c['email'].replace('@', suffix + '@')
        c['users'].append(sql("INSERT INTO users(email,password_hash,display_name,phone,phone_verified) VALUES(%s,%s,'수집·이용·제공사실 모의 검증','01000000000',false) RETURNING id", (email, c['password_hash'])))
        checkpoint()
    uid, other, owner = c['users']
    status, login, _, _ = call('POST', '/auth/login', {'email': c['email'], 'password': c['password']})
    assert status == 200, status
    token = login['access_token']

    due = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    status, r, _, _ = call('POST', '/privacy/requests', {'request_key': str(uuid.uuid4()), 'kind': 'access', 'scope': '모의 계정의 위치정보 수집·이용·제공사실 열람 검증', 'password': c['password']}, token)
    assert status == 202, status
    rid = c['request_id'] = r['id']
    checkpoint()
    path = f'/admin/privacy/requests/{rid}'
    status, r, _, _ = call('PATCH', path, {'revision': r['revision'], 'status': 'in_review', 'message': '합성 계정의 수집·이용·제공사실 범위를 검토합니다.', 'evidence_reference': 'FACTS-SYNTHETIC', 'due_at': due}, at)
    assert status == 200, status
    # One synthetic company link, so that one list of the file is not empty.
    staff = c['staff_id'] = sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'모의 검증 직원','member') RETURNING id", (owner,))
    checkpoint()
    sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)', (owner, staff, uid))
    # The second account has a link of its own: it must not appear in the first account's file.
    staff_other = c['staff_other_id'] = sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'모의 검증 직원 2','member') RETURNING id", (owner,))
    checkpoint()
    sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)', (owner, staff_other, other))

    def grant(sections=None, period=None, who=at):
        body = {'revision': call('GET', path, token=at)[1]['request']['revision'], 'confirmed': True, 'documents': []}
        if sections is not None:
            body['sections'] = sections
        if period:
            body.update(facts_from=period[0].isoformat(), facts_until=period[1].isoformat())
        return call('POST', path + '/account-packages', body, who)

    def download(package, who=None, password=None):
        return call('POST', f"/privacy/account-packages/{package['id']}/account", {'password': password or c['password']}, who or token)

    now = datetime.now(timezone.utc)
    period = (now - timedelta(days=30), now + timedelta(days=1))
    for sections, wrong in [(['location_facts'], None), (['transactions'], period), (['location_facts'], (now - timedelta(days=400), now)),
                            (['location_facts'], (now + timedelta(days=1), now + timedelta(days=2)))]:
        assert grant(sections, wrong)[0] == 400, (sections, wrong)
    assert grant(['location_facts'], period, token)[0] == 403
    status, package, _, _ = grant(['location_facts'], period)
    assert status == 200 and package['sections'] == ['location_facts'], (status, package)
    c['package_id'] = package['id']
    checkpoint()
    # The end lay in the future: it is the moment of issue.
    assert moment(package['facts_from']) == period[0] and now - timedelta(seconds=30) <= moment(package['facts_until']) <= datetime.now(timezone.utc) + timedelta(seconds=30), package

    assert download(package, mint(other))[0] == 404
    assert call('POST', f"/privacy/account-packages/{package['id']}/account", {'password': c['password']})[0] == 401  # no token
    assert download(package, password='wrong')[0] == 401
    status, data, headers, body = download(package)
    assert status == 200 and headers['Cache-Control'] == 'no-store, private', (status, data)
    assert data['format'] == 'gps-personal-account-v2' and data['coverage'][-1] == 'location_facts' and sorted(data['unselected_sections']) == ['activity_metadata', 'contact_settings', 'transactions']
    # The subject's own account and request, nobody else's.
    assert data['account']['email'] == c['email'] and data['request_id'] == rid and [r['id'] for r in data['requests']] == [rid], (data['request_id'], rid)
    assert sql("SELECT sha256 FROM privacy_account_package_events WHERE request_id=%s AND action='account_prepared' ORDER BY id DESC LIMIT 1", (rid,)) == hashlib.sha256(body).hexdigest()
    facts = data['additional']['location_facts']
    assert moment(facts['period']['from']) == moment(package['facts_from']) and moment(facts['period']['until']) == moment(package['facts_until']) and facts['period']['date_timezone'] == 'Asia/Seoul'
    # The synthetic subject has no device, report, event, analysis, link or location file.
    assert facts['collection']['daily'] == [] and facts['collection']['collection_changes'] == []
    assert facts['use'] == {'location_events': [], 'ai_analyses': []}
    assert facts['provision']['share_links'] == [] and facts['provision']['share_link_charges'] == [] and facts['provision']['location_file_deliveries'] == []
    links = facts['provision']['company_links']
    assert [(link['company_link'], link['action']) for link in links] == [(1, 'linked')] and set(links[0]) == {'company_link', 'action', 'effective_at'}, links
    assert facts['separate_review'] == {'devices_with_company_vehicle_history_or_erased': 0}
    assert len(facts['not_recorded']) == 8 and '좌표' in facts['notice'] and '제공 완료를 뜻하지 않습니다' in facts['notice']
    assert not any(key in body for key in [b'"lat"', b'"lng"', b'"raw"', b'"token"', b'fixes_jsonb'])
    assert guard() == c['baseline']

    # A grant without the section is what it was before this release, and replaces the first one.
    status, basic, _, _ = grant()
    assert status == 200 and basic['sections'] == [] and basic['facts_from'] is None and basic['facts_until'] is None, (status, basic)
    assert download(package)[0] == 410
    status, data, _, _ = download(basic)
    assert status == 200 and data['format'] == 'gps-personal-account-v1' and data['additional'] == {} and len(data['unselected_sections']) == 4

    # Expiry. The row's own times go back past its 24 hours; they are put back whatever happens.
    aged = "UPDATE privacy_account_packages SET created_at=%s,expires_at=%s WHERE id=%s AND request_id=%s"
    issued = rows('SELECT created_at,expires_at FROM privacy_account_packages WHERE id=%s AND request_id=%s', (basic['id'], rid))[0]
    c['aged'] = {'grant': basic['id'], 'created_at': issued[0].isoformat(), 'expires_at': issued[1].isoformat()}
    checkpoint()
    try:
        late = datetime.now(timezone.utc)
        sql(aged, (late - timedelta(hours=25), late - timedelta(hours=1), basic['id'], rid))
        expired = download(basic)[0]
    finally:
        sql(aged, (*issued, basic['id'], rid))
    assert expired == 410 and sql('SELECT revoked_at IS NULL FROM privacy_account_packages WHERE id=%s', (basic['id'],))
    assert rows('SELECT created_at,expires_at FROM privacy_account_packages WHERE id=%s', (basic['id'],))[0] == issued and download(basic)[0] == 200

    assert call('POST', f"/admin/privacy/account-packages/{basic['id']}/revoke", {}, at)[0] == 200 and download(basic)[0] == 410
    assert sql('SELECT count(*) FROM privacy_account_packages') == before + 2

    # The grants issued before this check: listed for the administrator as before, their stored rows untouched.
    for request in sorted({request for _, request in earlier}):
        status, listed, _, _ = call('GET', f'/admin/privacy/requests/{request}/account-packages', token=at)
        assert status == 200, (status, request)
        items = {item['id']: item for item in listed['items']}
        for grant_id in (g for g, r in earlier if r == request):
            item = items[grant_id]
            assert item['facts_from'] is None and item['facts_until'] is None and 'location_facts' not in item['sections'], grant_id
    assert sql(EARLIER, (earlier_ids,)) == c['earlier']

    measured = timing(cfg['DATABASE_URL'])

    # Remove the synthetic company links and close the three accounts; audit rows remain.
    for member, account in ((staff, uid), (staff_other, other)):
        sql('DELETE FROM fleet_staff_accounts WHERE owner_id=%s AND staff_id=%s AND account_id=%s', (owner, member, account))
        sql('DELETE FROM staff WHERE id=%s AND user_id=%s', (member, owner))
    assert sql('SELECT count(*) FROM fleet_staff_accounts WHERE account_id IN (%s,%s) OR owner_id=%s', (uid, other, owner)) == 0
    for subject in (uid, other):
        assert sql("SELECT array_agg(action ORDER BY id) FROM privacy_company_link_history WHERE subject_id=%s", (subject,)) == ['linked', 'unlinked']
    status, cancel, _, _ = call('POST', f'/privacy/requests/{rid}/cancel', {'revision': call('GET', path, token=at)[1]['request']['revision']}, token)
    assert status == 200, (status, cancel)
    for subject in c['users']:
        status, r, _, _ = call('POST', '/privacy/requests', {'request_key': str(uuid.uuid4()), 'kind': 'account_closure', 'scope': '수집·이용·제공사실 모의 검증 계정 이용 종료', 'password': c['password']}, mint(subject))
        assert status == 202, status
        assert call('POST', f"/admin/privacy/requests/{r['id']}/close-account", {'revision': r['revision']}, at)[0] == 200
        assert not execute(worker, r['id'])['request_fulfilled']
    assert all(sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s', (u,)) for u in c['users'])
    assert guard() == c['baseline'] and sql(EARLIER, (earlier_ids,)) == c['earlier']
    report = {'release': health['release'], 'schema': sql('SELECT max(version) FROM _sqlx_migrations'), 'request_id': rid,
              'synthetic_account_ids': c['users'], 'grant_ids': [package['id'], basic['id']],
              'section_needs_a_period_and_an_administrator': True, 'future_end_cut_at_issue': True,
              'subject_only_with_password': True, 'no_token_refused': True, 'other_account_refused': True,
              'file_holds_only_the_subjects_own_account_request_and_link': True,
              'expired_grant_refused_then_times_restored': True,
              'earlier_grants': len(earlier), 'earlier_grants_listed_and_rows_unchanged': True,
              'earlier_grants_downloadable_now': len(earlier) - sql(REFUSED, (earlier_ids,)),
              'file_structure_as_released': True, 'empty_lists_for_an_account_without_records': True,
              'company_link_listed_without_naming_the_company': True, 'no_coordinate_or_token_key_in_file': True,
              'prepared_file_hash_recorded': True, 'grant_without_section_unchanged': True, 'revoked_grant_refused': True,
              'daily_summary_seconds_for_busiest_accounts': measured,
              'synthetic_company_links_removed': True, 'synthetic_accounts_closed': True,
              'real_accounts_and_sim_ownership_unchanged': True, 'location_records_devices_or_share_links_created': 0,
              'external_messages_sent': False, 'full_erasure_confirmed': False}
    (site.stage / 'production-smoke.json').write_text(json.dumps(report, indent=2))
    return report


if __name__ == '__main__':
    print(json.dumps(main(Site()), indent=2))
