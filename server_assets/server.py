#!/usr/bin/env python3
# gps-tracker ingest + dashboard (stdlib only)
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, 'data')
os.makedirs(DATA_DIR, exist_ok=True)
NDJSON_PATH = os.path.join(DATA_DIR, 'points.ndjson')
LATEST_PATH = os.path.join(DATA_DIR, 'latest.json')
INDEX_PATH  = os.path.join(BASE, 'index.html')


def _strip_prefix(p):
    if p.startswith('/gps-tracker'):
        return p[len('/gps-tracker'):] or '/'
    return p


def read_recent(limit=100):
    if not os.path.exists(NDJSON_PATH):
        return []
    # 마지막 ~500KB만 읽어서 최신 N 줄 파싱
    with open(NDJSON_PATH, 'rb') as f:
        f.seek(0, 2)
        size = f.tell()
        read_size = min(size, 500 * 1024)
        f.seek(size - read_size)
        data = f.read()
    lines = data.decode('utf-8', 'replace').splitlines()
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = 'gps-tracker/1.1'

    def _send(self, code, body=b'', ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        path = _strip_prefix(u.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}

        if path in ('/', ''):
            try:
                with open(INDEX_PATH, 'rb') as f:
                    self._send(200, f.read(), 'text/html; charset=utf-8')
            except FileNotFoundError:
                self._send(404, b'index.html missing', 'text/plain')
        elif path.startswith('/health'):
            self._send(200, b'{"ok":true}')
        elif path.startswith('/latest'):
            try:
                with open(LATEST_PATH, 'rb') as f:
                    self._send(200, f.read())
            except FileNotFoundError:
                self._send(404, b'{"error":"no data"}')
        elif path.startswith('/recent'):
            try:
                limit = max(1, min(2000, int(q.get('limit', '200'))))
            except ValueError:
                limit = 200
            body = json.dumps(read_recent(limit), ensure_ascii=False).encode('utf-8')
            self._send(200, body)
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        u = urlparse(self.path)
        path = _strip_prefix(u.path)
        if path.startswith('/purge-unpaired'):
            # 양쪽(l80+lte) 모두 fix인 레코드만 남기고 나머지 제거
            import time as _t
            ts = _t.strftime('%Y%m%d-%H%M%S')
            if not os.path.exists(NDJSON_PATH):
                self._send(200, b'{"ok":true,"kept":0,"removed":0}')
                return
            backup = NDJSON_PATH + '.before-purge.' + ts
            try:
                os.rename(NDJSON_PATH, backup)
            except Exception as e:
                self._send(500, (f'{{"error":"{e}"}}').encode())
                return
            kept = 0
            removed = 0
            last_rec = None
            with open(backup) as fin, open(NDJSON_PATH, 'w') as fout:
                for line in fin:
                    line_s = line.rstrip()
                    if not line_s:
                        continue
                    try:
                        rec = json.loads(line_s)
                        pl = rec.get('payload') or {}
                        l80 = pl.get('l80') or {}
                        # 옛 포맷(flat lat/lng, src:L80R) 호환: l80 비어있으면 flat → l80
                        if not l80 and pl.get('lat') is not None:
                            l80 = {'fix': pl.get('fix'), 'lat': pl.get('lat'), 'lng': pl.get('lng')}
                        lte = pl.get('lte') or {}
                        if l80.get('fix') and lte.get('fix'):
                            fout.write(line_s + '\n')
                            kept += 1
                            last_rec = rec
                        else:
                            removed += 1
                    except Exception:
                        removed += 1
            if last_rec:
                with open(LATEST_PATH, 'w') as f:
                    json.dump(last_rec, f, ensure_ascii=False)
            else:
                if os.path.exists(LATEST_PATH):
                    try:
                        os.rename(LATEST_PATH, LATEST_PATH + '.before-purge.' + ts)
                    except Exception:
                        pass
            self._send(200, (f'{{"ok":true,"kept":{kept},"removed":{removed}}}').encode())
            return
        if path.startswith('/clear'):
            # 전체 기록 삭제 (NDJSON truncate + latest 제거). 백업은 남김.
            import time as _t
            ts = _t.strftime('%Y%m%d-%H%M%S')
            try:
                if os.path.exists(NDJSON_PATH):
                    os.rename(NDJSON_PATH, NDJSON_PATH + '.cleared.' + ts)
                if os.path.exists(LATEST_PATH):
                    os.rename(LATEST_PATH, LATEST_PATH + '.cleared.' + ts)
            except Exception as e:
                self._send(500, (f'{{"error":"{e}"}}').encode())
                return
            self._send(200, b'{"ok":true,"cleared":true}')
            return
        if not path.startswith('/ingest'):
            self._send(404, b'{"error":"not found"}')
            return
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length) if length > 0 else b''
        try:
            payload = json.loads(raw.decode('utf-8'))
        except Exception:
            payload = {'raw': raw.decode('utf-8', 'replace')}
        record = {
            'received_at': datetime.now(timezone.utc).isoformat(),
            'remote': self.headers.get('X-Real-IP') or self.client_address[0],
            'payload': payload,
        }
        with open(NDJSON_PATH, 'a') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
        with open(LATEST_PATH, 'w') as f:
            json.dump(record, f, ensure_ascii=False)
        self._send(200, b'{"ok":true}')

    def log_message(self, fmt, *args):
        print('[%s] %s - %s' % (datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                                 self.address_string(), fmt % args), flush=True)


if __name__ == '__main__':
    bind = os.environ.get('BIND', '127.0.0.1')
    port = int(os.environ.get('PORT', '3030'))
    print(f'gps-tracker listening on {bind}:{port}', flush=True)
    HTTPServer((bind, port), Handler).serve_forever()
