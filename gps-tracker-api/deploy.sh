#!/usr/bin/env bash
# deploy.sh — gps-tracker-api 서버측 빌드+배포.
# 패턴: tar+scp 소스 → 서버에서 cargo build --release → bin/ atomic swap → systemctl restart.
#
# 사용법:
#   bash deploy.sh            # = prod (default)
#   bash deploy.sh prod
#   bash deploy.sh dev        # → dev-gps.serial.kr (gps_tracker_dev DB, port 3041)
#
# 함정 (memory: feedback_rust_api_deploy_path): systemd ExecStart 는 bin/<name> 하위.
# bin 위 디렉토리에 덮어쓰면 옛 바이너리가 계속 실행됨 → 반드시 bin/ 안으로 swap.
#
# 메모리: VPS RAM 2.9GB. dev/prod 빌드 동시 실행 금지 (직렬).
set -e

ENV="${1:-prod}"
# VPS host — 다른 서버 배포 시 `DEPLOY_HOST=my.host.com bash deploy.sh` 형태로 override.
DEPLOY_HOST="${DEPLOY_HOST:-210.114.18.16}"
case "$ENV" in
  prod)
    SERVER="${DEPLOY_USER_PROD:-deploy}@${DEPLOY_HOST}"
    SERVICE=gps-tracker-api
    BIN_NAME=gps-tracker-api
    REMOTE_HOME=/home/${DEPLOY_USER_PROD:-deploy}/projects/gps-tracker-api
    HEALTH_URL="${HEALTH_URL_PROD:-https://gps.serial.kr/api/v1/health}"
    ;;
  dev)
    # gps-dev 계정 통로. authorized_keys 에 등록된 키 (junior + maintainer) 면 모두 ssh 가능.
    SERVER="${DEPLOY_USER_DEV:-gps-dev}@${DEPLOY_HOST}"
    SERVICE=gps-tracker-api-dev
    BIN_NAME=gps-tracker-api-dev
    REMOTE_HOME=/home/${DEPLOY_USER_DEV:-gps-dev}/projects/gps-tracker-api
    HEALTH_URL="${HEALTH_URL_DEV:-https://dev-gps.serial.kr/api/v1/health}"
    ;;
  *)
    echo "usage: $0 [prod|dev]" >&2
    exit 2
    ;;
esac

REMOTE_SRC=${REMOTE_HOME}/src-deploy$( [ "$ENV" = dev ] && echo -dev || true )
REMOTE_BIN_DIR=${REMOTE_HOME}/bin
TMP_TAR=/tmp/gps-tracker-api-src-${ENV}.tar.gz

echo "=== deploy target: ${ENV} ($SERVICE) ==="

# ── 1. pack & upload source ───────────────────────────────────────────────
echo "=== [1/4] uploading source ==="
tar -czf "$TMP_TAR" \
  --exclude='./target' \
  --exclude='./.git' \
  --exclude='./.idea' \
  --exclude='./.vscode' \
  -C . .
scp "$TMP_TAR" $SERVER:/tmp/
rm -f "$TMP_TAR"
echo "upload done"

# ── 2. build on server ────────────────────────────────────────────────────
echo "=== [2/4] building on server ==="
ssh -T $SERVER <<ENDSSH
set -e

mkdir -p $REMOTE_SRC
tar -xzf /tmp/gps-tracker-api-src-${ENV}.tar.gz -C $REMOTE_SRC
rm -f /tmp/gps-tracker-api-src-${ENV}.tar.gz

# cargo PATH (rustup default install)
export PATH="\$HOME/.cargo/bin:\$PATH"
if ! command -v cargo >/dev/null; then
  echo ">>> cargo not found — installing rustup (stable)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  source "\$HOME/.cargo/env"
fi

echo "cargo: \$(cargo --version)"

cd $REMOTE_SRC
# sqlx::migrate! macro 가 cargo 캐시에 의해 새 migration 파일을 못 보고 지나갈 때가 있음.
# main.rs 를 touch 해서 macro 재실행 강제 (Phase 6A 0043 mig 가 이 함정에 빠진 적 있음).
touch src/main.rs
cargo build --release --bin gps-tracker-api
echo ">>> build OK"
ENDSSH

# ── 3. atomic swap binary in bin/ ─────────────────────────────────────────
echo "=== [3/4] swapping binary ==="
ssh -T $SERVER <<ENDSSH
set -e
cd $REMOTE_BIN_DIR
cp -f $REMOTE_SRC/target/release/gps-tracker-api ${BIN_NAME}.new
chmod +x ${BIN_NAME}.new
if [ -f ${BIN_NAME} ]; then mv -f ${BIN_NAME} ${BIN_NAME}.bak; fi
mv ${BIN_NAME}.new ${BIN_NAME}
echo ">>> swap OK"
ls -la ${BIN_NAME} ${BIN_NAME}.bak 2>/dev/null
ENDSSH

# ── 4. systemctl restart + health ─────────────────────────────────────────
echo "=== [4/4] restart ==="
ssh -T $SERVER <<ENDSSH
set -e
sudo systemctl restart ${SERVICE}
sleep 2
sudo systemctl is-active ${SERVICE}
echo ">>> service active"
sudo journalctl -u ${SERVICE} --since "1 minute ago" --no-pager 2>/dev/null | tail -20 || true
ENDSSH

echo ""
echo "=== deploy complete ==="
echo ">>> $HEALTH_URL"
