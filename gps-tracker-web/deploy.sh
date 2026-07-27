#!/usr/bin/env bash
# deploy.sh — tar+scp source → build on server → static 산출물 배포
#
# 사용법:
#   bash deploy.sh           # = prod (default) — gps.serial.kr + legacy /gps-tracker/app/ 서브패스
#   bash deploy.sh prod
#   bash deploy.sh dev       # = dev-gps.serial.kr 단일 base
#
# 메모리: VPS RAM 2.9GB. dev/prod 빌드 동시 실행 금지 (직렬).
set -e

ENV="${1:-prod}"
# VPS host — 다른 서버 배포 시 `DEPLOY_HOST=my.host.com bash deploy.sh` 형태로 override.
DEPLOY_HOST="${DEPLOY_HOST:-210.114.18.16}"
case "$ENV" in
  prod)
    SERVER="${DEPLOY_USER_PROD:-mmm}@${DEPLOY_HOST}"
    REMOTE_DIR=/home/${DEPLOY_USER_PROD:-mmm}/gps-tracker-web
    # 주 도메인 gps.serial.kr — legacy /gps-tracker/app/ 서브패스도 아직 nginx 유지 (backward-compat)
    HEALTH_URLS=("https://gps.serial.kr/" "https://gps.serial.kr/gps-tracker/app/")
    ;;
  dev)
    # gps-dev 계정 통로. junior + maintainer 양쪽 SSH 키 등록되어 있음.
    SERVER="${DEPLOY_USER_DEV:-gps-dev}@${DEPLOY_HOST}"
    REMOTE_DIR=/home/${DEPLOY_USER_DEV:-gps-dev}/gps-tracker-web-dev
    HEALTH_URLS=("https://dev-gps.serial.kr/")
    ;;
  *)
    echo "usage: $0 [prod|dev]" >&2
    exit 2
    ;;
esac

TMP_TAR=/tmp/gps-tracker-web-src-${ENV}.tar.gz

echo "=== deploy target: ${ENV} ($REMOTE_DIR) ==="

# ── 1. pack & upload source ───────────────────────────────────────────────
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

# ── 2. install deps + build on server ─────────────────────────────────────
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
  # 1) legacy /gps-tracker/app/ 서브패스용 (기본 base) — nginx 에 아직 살아 있음
  npm run build
  # 2) gps.serial.kr/ 루트용 (root base, dist-root 로 출력)
  VITE_BASE=/ VITE_OUT=dist-root npm run build
  echo ">>> build OK (dist + dist-root)"
else
  # dev — dev-gps.serial.kr 는 root base 만 필요
  VITE_BASE=/ npm run build
  echo ">>> build OK (dist)"
fi
ENDSSH

# ── 3. nginx route (prod 만 — idempotent. dev 는 nginx 별도 셋업됨) ──────
echo "=== [3/3] nginx ==="
if [ "$ENV" = "prod" ]; then
  # NOTE: nginx 사이트 파일명은 VPS 상 실제 파일명. 초기 도메인 이력으로
  # `/etc/nginx/sites-enabled/seriallog.com` 인 채로 유지 (도메인 이관 후에도 rename X).
  # 다른 서버 배포 시 `DEPLOY_NGINX_SITE=my.example.com bash deploy.sh` 로 override.
  NGINX_SITE="${DEPLOY_NGINX_SITE:-seriallog.com}"
  DEPLOY_USER="${DEPLOY_USER_PROD:-mmm}"
  ssh -T $SERVER "if grep -q 'gps-tracker-web static' /etc/nginx/sites-enabled/${NGINX_SITE} 2>/dev/null; then echo 'nginx block already present'; else sudo python3 /home/${DEPLOY_USER}/gps-tracker-web/scripts/nginx_add_web_route.py; fi"
else
  echo "dev: nginx /etc/nginx/sites-enabled/dev-gps.serial.kr.conf 가 dist 를 serve"
fi

echo ""
echo "=== deploy complete ==="
for u in "${HEALTH_URLS[@]}"; do echo ">>> $u"; done
