#!/usr/bin/env bash
# deploy.sh — gps-tracker-api 서버측 빌드+배포.
# 패턴은 gps-tracker-web/deploy.sh 와 동일: tar+scp 소스 → 서버에서 cargo build --release →
# bin/ 디렉토리로 atomic swap → systemctl restart.
#
# 함정 (memory: feedback_rust_api_deploy_path): systemd ExecStart 는 bin/gps-tracker-api 하위.
# bin 위 디렉토리에 덮어쓰면 옛 바이너리가 계속 실행됨 → 반드시 bin/ 안으로 swap.
set -e

SERVER=mmm@210.114.18.16
REMOTE_SRC=/home/mmm/projects/gps-tracker-api/src-deploy
REMOTE_BIN_DIR=/home/mmm/projects/gps-tracker-api/bin
TMP_TAR=/tmp/gps-tracker-api-src.tar.gz

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
tar -xzf /tmp/gps-tracker-api-src.tar.gz -C $REMOTE_SRC
rm -f /tmp/gps-tracker-api-src.tar.gz

# cargo PATH (rustup default install)
export PATH="\$HOME/.cargo/bin:\$PATH"
if ! command -v cargo >/dev/null; then
  echo ">>> cargo not found — installing rustup (stable)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  source "\$HOME/.cargo/env"
fi

echo "cargo: \$(cargo --version)"

cd $REMOTE_SRC
cargo build --release --bin gps-tracker-api
echo ">>> build OK"
ENDSSH

# ── 3. atomic swap binary in bin/ ─────────────────────────────────────────
echo "=== [3/4] swapping binary ==="
ssh -T $SERVER <<ENDSSH
set -e
cd $REMOTE_BIN_DIR
cp -f $REMOTE_SRC/target/release/gps-tracker-api gps-tracker-api.new
chmod +x gps-tracker-api.new
mv -f gps-tracker-api gps-tracker-api.bak
mv gps-tracker-api.new gps-tracker-api
echo ">>> swap OK"
ls -la gps-tracker-api gps-tracker-api.bak
ENDSSH

# ── 4. systemctl restart + health ─────────────────────────────────────────
echo "=== [4/4] restart ==="
ssh -T $SERVER <<'ENDSSH'
set -e
sudo systemctl restart gps-tracker-api
sleep 2
sudo systemctl is-active gps-tracker-api
echo ">>> service active"
# 30분 윈도우 내 최근 로그 마지막 20줄
sudo journalctl -u gps-tracker-api --since "1 minute ago" --no-pager | tail -20 || true
ENDSSH

echo ""
echo "=== deploy complete ==="
echo ">>> https://seriallog.com/gps-tracker/api/v1/health"
