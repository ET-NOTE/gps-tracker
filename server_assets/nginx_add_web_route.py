#!/usr/bin/env python3
"""
nginx_add_web_route.py
/gps-tracker/app/ → static files at /home/mmm/gps-tracker-web/dist/
Insert BEFORE the existing ^~ /gps-tracker/ block.
"""
import re, subprocess, sys

NGINX_CONF = "/etc/nginx/sites-enabled/seriallog.com"

NEW_BLOCK = """\
    # gps-tracker-web static (react/vite build)
    location ^~ /gps-tracker/app/ {
        alias /home/mmm/gps-tracker-web/dist/;
        try_files $uri $uri/ /gps-tracker/app/index.html;
        add_header Cache-Control "no-cache";
    }
"""

with open(NGINX_CONF) as f:
    content = f.read()

# Safety: don't insert twice
if "gps-tracker-web static" in content:
    print("block already present, skipping")
    sys.exit(0)

# Insert before the first ^~ /gps-tracker/ block (api or root catch-all)
pattern = r'([ \t]*location \^~ /gps-tracker/[^\n]*\n)'
m = re.search(pattern, content)
if not m:
    print("ERROR: could not find target location block")
    sys.exit(1)

new_content = content[:m.start()] + NEW_BLOCK + "\n" + content[m.start():]

with open(NGINX_CONF, "w") as f:
    f.write(new_content)

subprocess.run(["nginx", "-t"], check=True)
subprocess.run(["systemctl", "reload", "nginx"], check=True)
print("nginx reloaded — /gps-tracker/app/ now served from dist/")
