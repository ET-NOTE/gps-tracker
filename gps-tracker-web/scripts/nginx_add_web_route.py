#!/usr/bin/env python3
"""
/gps-tracker/app/ → static files at /home/mmm/gps-tracker-web/dist/
Insert BEFORE the existing ^~ /gps-tracker/ block.
"""
import re, subprocess, sys

NGINX_CONF = "/etc/nginx/sites-enabled/seriallog.com"

NEW_BLOCK = """\
    # gps-tracker-web static (vite build)
    location ^~ /gps-tracker/app/ {
        alias /home/mmm/gps-tracker-web/dist/;
        try_files $uri $uri/ /gps-tracker/app/index.html;
        add_header Cache-Control "no-cache";
    }
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
