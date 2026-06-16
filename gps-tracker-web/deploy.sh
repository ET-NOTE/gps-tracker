#!/usr/bin/env bash
# deploy.sh — tar+scp source → build on server → reload nginx
set -e

SERVER=mmm@210.114.18.16
REMOTE_DIR=/home/mmm/gps-tracker-web
TMP_TAR=/tmp/gps-tracker-web-src.tar.gz

# ── 1. pack & upload source ───────────────────────────────────────────────
echo "=== [1/3] uploading source ==="
tar -czf "$TMP_TAR" \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.git' \
  -C . .
scp "$TMP_TAR" $SERVER:/tmp/
rm -f "$TMP_TAR"
echo "upload done"

# ── 2. install deps + build on server ─────────────────────────────────────
echo "=== [2/3] building on server ==="
ssh -T $SERVER <<ENDSSH
set -e

mkdir -p $REMOTE_DIR
tar -xzf /tmp/gps-tracker-web-src.tar.gz -C $REMOTE_DIR
rm -f /tmp/gps-tracker-web-src.tar.gz

# load nvm if present; install if missing
export NVM_DIR="\$HOME/.nvm"
if [ -s "\$NVM_DIR/nvm.sh" ]; then
  . "\$NVM_DIR/nvm.sh"
elif ! command -v node &>/dev/null; then
  echo ">>> installing nvm + Node 20"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  . "\$HOME/.nvm/nvm.sh"
  nvm install 20 && nvm alias default 20
fi

echo "node: \$(node --version)  npm: \$(npm --version)"

cd $REMOTE_DIR
npm install
# 1) seriallog.com/gps-tracker/app/ 용 (기본 base)
npm run build
# 2) gps.serial.kr/ 용 (root base, dist-root 로 출력)
VITE_BASE=/ VITE_OUT=dist-root npm run build
echo ">>> build OK (dist + dist-root)"
ENDSSH

# ── 3. nginx route (idempotent) ───────────────────────────────────────────
echo "=== [3/3] nginx ==="
ssh -T $SERVER <<'ENDSSH'
if grep -q "gps-tracker-web static" /etc/nginx/sites-enabled/seriallog.com 2>/dev/null; then
  echo "nginx block already present"
else
  sudo python3 /home/mmm/gps-tracker-web/scripts/nginx_add_web_route.py
fi
ENDSSH

echo ""
echo "=== deploy complete ==="
echo ">>> https://seriallog.com/gps-tracker/app/"
echo ">>> https://gps.serial.kr/   (서브도메인 nginx 설정 + 인증서 필요)"
