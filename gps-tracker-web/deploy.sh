#!/usr/bin/env bash
# deploy.sh ??tar+scp source ??build on server ??static ?∞Ï∂úÎ¨?Î∞∞Ìè¨
#
# ?¨Ïö©Î≤?
#   bash deploy.sh           # = prod (default) ??seriallog.com + gps.serial.kr
#   bash deploy.sh prod
#   bash deploy.sh dev       # = dev-gps.serial.kr ?®Ïùº base
#
# Î©îÎ™®Î¶? VPS RAM 2.9GB. dev/prod ÎπåÎìú ?ôÏãú ?§Ìñâ Í∏àÏ? (ÏßÅÎ†¨).
set -e

ENV="${1:-prod}"
case "$ENV" in
  prod)
    SERVER=mmm@210.114.18.16
    REMOTE_DIR=/home/mmm/gps-tracker-web
    HEALTH_URLS=("https://seriallog.com/gps-tracker/app/" "https://gps.serial.kr/")
    ;;
  dev)
    # gps-dev Í≥ÑÏ†ï ?µÎ°ú. junior + maintainer ?ëÏ™Ω SSH ???±Î°ù?òÏñ¥ ?àÏùå.
    SERVER=gps-dev@210.114.18.16
    REMOTE_DIR=/home/gps-dev/gps-tracker-web-dev
    HEALTH_URLS=("https://dev-gps.serial.kr/")
    ;;
  *)
    echo "usage: $0 [prod|dev]" >&2
    exit 2
    ;;
esac

TMP_TAR=/tmp/gps-tracker-web-src-${ENV}.tar.gz

echo "=== deploy target: ${ENV} ($REMOTE_DIR) ==="

# ?Ä?Ä 1. pack & upload source ?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä
echo "=== [1/3] uploading source ==="
tar -czf "$TMP_TAR" \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./dist-root' \
  --exclude='./.git' \
  -C . .
scp "$TMP_TAR" $SERVER:/tmp/
rm -f "$TMP_TAR"
echo "upload done"

# ?Ä?Ä 2. install deps + build on server ?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä
echo "=== [2/3] building on server ==="
ssh -T $SERVER <<ENDSSH
set -e

mkdir -p $REMOTE_DIR
tar -xzf /tmp/gps-tracker-web-src-${ENV}.tar.gz -C $REMOTE_DIR
rm -f /tmp/gps-tracker-web-src-${ENV}.tar.gz

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
if [ "$ENV" = "prod" ]; then
  # 1) seriallog.com/gps-tracker/app/ ??(Í∏∞Î≥∏ base)
  npm run build
  # 2) gps.serial.kr/ ??(root base, dist-root Î°?Ï∂úÎ†•)
  VITE_BASE=/ VITE_OUT=dist-root npm run build
  echo ">>> build OK (dist + dist-root)"
else
  # dev ??dev-gps.serial.kr ??root base Îß??ÑÏöî
  VITE_BASE=/ npm run build
  echo ">>> build OK (dist)"
fi
ENDSSH

# ?Ä?Ä 3. nginx route (prod Îß???idempotent. dev ??nginx Î≥ÑÎèÑ ?ãÏóÖ?? ?Ä?Ä?Ä?Ä?Ä?Ä
echo "=== [3/3] nginx ==="
if [ "$ENV" = "prod" ]; then
  ssh -T $SERVER <<'ENDSSH'
  if grep -q "gps-tracker-web static" /etc/nginx/sites-enabled/seriallog.com 2>/dev/null; then
    echo "nginx block already present"
  else
    sudo python3 /home/mmm/gps-tracker-web/scripts/nginx_add_web_route.py
  fi
ENDSSH
else
  echo "dev: nginx /etc/nginx/sites-enabled/dev-gps.serial.kr.conf Í∞Ä dist Î•?serve"
fi

echo ""
echo "=== deploy complete ==="
for u in "${HEALTH_URLS[@]}"; do echo ">>> $u"; done
