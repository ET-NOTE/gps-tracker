"""Compare real110/111 HTTP pages and cursors; no production endpoint accepted."""
import argparse
import hashlib
import json
import uuid
from urllib.parse import urlencode

from benchmark_location111 import OUT, connect, save
from load_location111 import request, token


def digest(body):
    return hashlib.sha256(json.dumps(json.loads(body), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def main(mode):
    fixture = json.loads((OUT / 'fixture.json').read_text())
    uid, did = fixture['user_id'], fixture['device_id']
    root = f'/gps-tracker/api/v1/devices/{did}/locations/page?'
    queries = []
    for options in [dict(limit=1),dict(limit=500),dict(limit=5000),dict(limit=9,source='l80'),
                    dict(limit=7,fix_only='false'),dict(limit=7,source='missing')]:
        queries.append(dict(since='2026-10-01T00:00:00Z',until='2026-11-01T00:00:00Z',**options))
    queries.append(dict(since='2026-10-10T00:00:00Z',until='2026-10-10T00:01:00Z',limit=7))
    report = []
    for query in queries:
        for page in range(2):
            path = root + urlencode(query)
            code, body, elapsed = request(path, token(uid))
            assert code == 200, (code, body[:100])
            value = json.loads(body)
            report.append({'query': query.copy(), 'page': page, 'sha256': digest(body),
                           'items': len(value['items']), 'has_more': value['has_more'], 'seconds': elapsed})
            if not value['next_cursor']:
                break
            query['cursor'] = value['next_cursor']
    if mode == 'baseline':
        save('baseline110-http-pages.json', report)
    else:
        baseline = json.loads((OUT / 'baseline110-http-pages.json').read_text())
        assert len(baseline) == len(report)
        for old, new in zip(baseline, report):
            assert {k:v for k,v in old.items() if k != 'seconds'} == {k:v for k,v in new.items() if k != 'seconds'}
        # Feed cursors issued by the110 binary directly to111, not just regenerated cursors.
        for old in baseline:
            if 'cursor' in old['query']:
                code, body, _ = request(root + urlencode(old['query']), token(uid))
                assert code == 200 and digest(body) == old['sha256']
        with connect() as db:
            tag = 'http111-' + uuid.uuid4().hex[:12]
            other = db.execute("INSERT INTO users(phone,email,password_hash) VALUES(%s,%s,'') RETURNING id", (tag,tag+'@example.invalid')).fetchone()[0]
            empty = db.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id", (uid,tag)).fetchone()[0]
        valid = root + urlencode(queries[0])
        assert request(valid, token(other))[0] == 404
        assert request(valid)[0] == 401
        empty_path = valid.replace(f'devices/{did}/', f'devices/{empty}/').split('&cursor=')[0]
        code, body, _ = request(empty_path, token(uid))
        assert code == 200 and json.loads(body) == {'items': [], 'has_more': False, 'next_cursor': None}
        assert request(valid + '&cursor=invalid', token(uid))[0] == 400
        bad_range = root + urlencode(dict(since='2026-10-01T00:00:00Z',until='2026-11-02T00:00:00Z'))
        assert request(bad_range, token(uid))[0] == 400
        old_cursor = next(x['query']['cursor'] for x in baseline if 'cursor' in x['query'])
        mismatch = root + urlencode(dict(since='2026-10-02T00:00:00Z',until='2026-11-01T00:00:00Z',cursor=old_cursor))
        assert request(mismatch, token(uid))[0] == 400
        save('http-pages111.json', {'passed': True, 'baseline_schema':110,'candidate_schema':111,
            'matched_responses':len(report),'all_item_fields_and_cursors_equal':True,
            'existing_other_account_denied':True,'empty_and_invalid_inputs_passed':True,'pages':report})
    print('HTTP PAGE PASS', mode, len(report), flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['baseline','current'])
    main(parser.parse_args().mode)
