#!/usr/bin/env python3
"""
/gps-tracker/app/ → static files at /home/<deploy-user>/gps-tracker-web/dist/
Insert BEFORE the existing ^~ /gps-tracker/ block.

VPS 상 실제 파일 경로는 배포 계정 홈 기준. 초기 도메인 이력으로 nginx 사이트 파일명은
`seriallog.com` 인 채로 유지 (도메인 이관 후에도 rename X). 다른 서버에서는 env override:
  NGINX_CONF=/etc/nginx/sites-enabled/my.example.com \
  DEPLOY_USER=deploy python3 nginx_add_web_route.py
"""
import os, re, subprocess, sys

NGINX_CONF = os.environ.get("NGINX_CONF", "/etc/nginx/sites-enabled/seriallog.com")
DEPLOY_USER = os.environ.get("DEPLOY_USER", "mmm")

NEW_BLOCK = f"""\
    # gps-tracker-web static (vite build)
    location ^~ /gps-tracker/app/ {{
        alias /home/{DEPLOY_USER}/gps-tracker-web/dist/;
        try_files $uri $uri/ /gps-tracker/app/index.html;
        add_header Cache-Control "no-cache";
    }}
"""

with open(NGINX_CONF) as f:
    content = f.read()

if "gps-tracker-web static" in content:
    print("block already present, skipping")
    sys.exit(0)

m = re.search(r'([ \t]*location \^~ /gps-tracker/)', content)
if not m:
    print("ERROR: target location block not found"); sys.exit(1)

new_content = content[:m.start()] + NEW_BLOCK + "\n" + content[m.start():]
with open(NGINX_CONF, "w") as f:
    f.write(new_content)

subprocess.run(["nginx", "-t"], check=True)
subprocess.run(["systemctl", "reload", "nginx"], check=True)
print("nginx reloaded → /gps-tracker/app/ served from dist/")
