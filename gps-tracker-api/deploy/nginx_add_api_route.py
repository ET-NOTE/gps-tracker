#!/usr/bin/env python3
"""Idempotently inject `^~ /gps-tracker/api/` proxy block into nginx server blocks.

Run on the server as: sudo python3 nginx_add_api_route.py

NOTE: nginx 사이트 파일명은 VPS 상 실제 파일명 그대로. 초기 도메인 이력으로
`/etc/nginx/sites-enabled/seriallog.com` 이지만 도메인 이관 후에도 파일 rename X.
다른 서버에서는: NGINX_CONF=/etc/nginx/sites-enabled/my.example.com python3 ...
"""
import os, re, sys, time, shutil, subprocess

PATH = os.environ.get("NGINX_CONF", "/etc/nginx/sites-enabled/seriallog.com")
MARKER = "http://127.0.0.1:3040/gps-tracker/api/"
ANCHOR_RE = re.compile(r"\n(    location \^~ /gps-tracker/ \{)")

BLOCK = """    # gps-tracker REST API → Rust API (3040). prefix match로 /api/* 만 분기.
    location ^~ /gps-tracker/api/ {
        proxy_pass http://127.0.0.1:3040/gps-tracker/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 64k;
    }

"""

with open(PATH) as f:
    content = f.read()

# nginx에서는 prefix 길이 기준이라 두 server 블록 각각에 삽입되어야 함.
expected = content.count("location ^~ /gps-tracker/ {")
already  = content.count(MARKER)
if already >= expected and expected > 0:
    print(f"already patched ({already}/{expected} blocks)")
    sys.exit(0)

backup = f"{PATH}.bak.{int(time.time())}"
shutil.copy2(PATH, backup)
print(f"backup -> {backup}")

new = ANCHOR_RE.sub("\n" + BLOCK + r"\1", content)
if new == content:
    print("ERROR: anchor not found", file=sys.stderr)
    sys.exit(1)

with open(PATH, "w") as f:
    f.write(new)

# validate
r = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
print(r.stdout + r.stderr)
if r.returncode != 0:
    print("nginx -t failed; restoring backup")
    shutil.copy2(backup, PATH)
    sys.exit(2)

subprocess.check_call(["systemctl", "reload", "nginx"])
print("nginx reloaded")
