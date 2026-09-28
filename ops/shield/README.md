# Shield build and deployment

This service is separate from GPS/KC. **Production changes require the user's explicit approval.** The first launch was approved and performed on 2026-09-28; see [the deployment record](../../docs/reviews/shield-production-2026-09-28.md). Build/test scripts never deploy. `deploy.py` is an explicit, step-by-step production operator tool.

## Build

From a clean committed worktree on Windows:

```powershell
./ops/shield/Build-Release.ps1
```

Uses `ssh etcom-hub`, the existing `gps-build:rust1.88-node22.22.2` container and bounded CPU/RAM. Only API + Shield source enters the release. Output is under `%LOCALAPPDATA%/GPS-Builds/shield-<date>-<time>-<commit>/`; tar checksum is verified on return. `release.txt`, `commit.txt`, and `SHA256SUMS` travel with the artifact. No build runs on the VPS. Existing GPS default builds do not enable `shield`.

## Preview and tests

The preview scripts are deliberately restricted to `/home/etcom-hub/build/gps-tracker/shield-platform` and named test containers. They never read GPS credentials. Initial API build:

```sh
cargo test --locked --features shield --bin shield-api
cargo clippy --locked --features shield --bin shield-api -- -D warnings
cargo build --locked --release --features shield --bin shield-api
```

On the runner, `start-preview.py` creates the loopback-only API 3043 and disposable PostgreSQL 5543. `test-integration.py` creates synthetic accounts/devices and stores a private UI fixture outside Git; `test-websocket.py` verifies stream authorization. `test-infrastructure.py` tests PostgreSQL 14 and nginx in disposable containers. Never copy these test accounts or credentials into production.

From Windows, forward `ssh -N -L 3043:127.0.0.1:3043 etcom-hub`, then in `shield-web` run `npm ci` and `npm run dev`. Visit `http://localhost:8043` (the exact Origin matters). Synthetic sender: `public/downloads/send_sample.py`, with a dedicated claimed test device's UID/key as process environment variables. It sends a finite number of reports and stops on rejected credentials.

Stop the two named preview containers and remove their disposable volumes when the preview is no longer needed; first confirm their names/images. Stop the task's SSH forward and Vite process. The compatibility test removes its own PostgreSQL container after success.

## Production apply procedure — only after approval

1. Record live GPS/KC versions, API health, selected KC device last receipt and GPS web asset hashes. Back up current nginx virtual hosts and `SHOW hba_file` path. Back up existing GPS and Shield databases as applicable, copy off VPS and verify checksums. Check available disk before staging; retain previous release for rollback.
2. Verify artifact SHA256, extract into a new `/srv/shield/releases/<release>` and run `sha256sum -c SHA256SUMS`. Do not extract over any GPS tree. Create OS service account `gps-shield` without login; release files stay root-owned/read-only.
3. Generate a random hex password into a root-only temporary psql variables file. Execute it with `bootstrap-database.sql` as PostgreSQL administrator. Existing role/DB names must stop the operation for inspection; do not blindly overwrite or drop them. Delete only that temporary credentials file after storing the secret in `/etc/shield-api/shield.env` (root:gps-shield 0640, parent 0750).
4. Prepend `postgres-hba.fragment` to the backed-up HBA file, preserving every existing rule. Validate `pg_hba_file_rules` for errors, reload PostgreSQL configuration (not restart). Test `shield_app` connecting to Shield and being rejected from **each** GPS database. Verify ordinary GPS roles cannot connect to Shield. A PostgreSQL superuser remains able to administer all DBs by design.
5. Point `/srv/shield/current` to the new release. Install the provided service unit, then start **only** `shield-api`. The service itself rejects wrong production DB/role/origin, public binding and privileged DB roles. Inspect `/health` on loopback and journal; no legacy API unit is restarted. The service owns schema migrations only inside its DB.
6. Verify `shield.serial.kr` DNS reaches the intended VPS. Issue/renew a dedicated certificate using the established ACME method. An HTTP challenge-only Shield vhost can be added first if needed. Install the full Shield vhost only when its certificate files exist. Run the **VPS's full** `nginx -t`; on failure remove the new vhost and retain the old active config. Reload nginx gracefully after success.
7. Check SPA deep links/downloads, HTTPS secure host-only cookie, unauthorized API, invitation consumption, device ownership/claim/key, REST/WS updates and logout revocation. Use a dedicated synthetic device. Compare the GPS/KC baseline again, including `/diagnostic` and ongoing receipt where a certification device is online.
8. Register Shield DB dump backups with the existing backup/offsite process and verify a restore on the runner before inviting real users. Monitor disk and API RSS/connection count. Auth metadata is pruned automatically; telemetry is not silently deleted. Agree retention before scaling.

No production apply step is invoked by automated builds or preview tests. `deploy.py` runs `prepare`, `install`, `challenge`, `activate`, `retire-page`, and `verify` separately. It requires an explicit release and archive SHA256. Copy and verify the `prepare` backup offsite before `install`; provision the certificate with the established ACME account between `challenge` and `activate`. Initial-creation steps deliberately stop if names or files already exist; inspect partial state instead of rerunning blindly. It supports Ubuntu 22.04 Python 3.10. Graceful nginx reload readiness is polled with certificate validation enabled.

`verify-production.py smoke` creates two recorded synthetic accounts and a keyed test device in **Shield only**. Its 34 checks never call SIM or payment services. After browser inspection, `cleanup` removes exactly the generated identities and dependent telemetry. It refuses unknown identities and does not touch GPS. The API's `invite` and `provision [name]` CLI commands emit one-time secrets; run under the Shield service environment and store/hand over through a private channel. Do not publish them in PRs or logs. Operators must provide the key to firmware separately from the owner's claim code.

## Production backups

- VPS: `shield-backup.timer` runs daily at 02:35 Asia/Seoul plus up to five minutes of jitter. Root-only `/var/backups/shield` contains seven days of PostgreSQL custom dumps plus the Shield environment, nginx config, service unit and release metadata. These archives contain secrets; never serve them through HTTP or put them in Git. Telemetry itself is not pruned.
- Runner: the system `shield-backup-pull.timer` runs as `etcom-hub` at 03:20 Asia/Seoul plus up to five minutes of jitter. `/home/etcom-hub/backups/shield` is mode 0700; it retains fourteen days of mode-0600 archives and checksums. A dedicated SSH key is restricted to exporting the newest Shield backup, with no shell, forwarding or PTY. Pin the already trusted VPS host key; do not disable host checking.
- Initial install: upload the backup scripts/units and the runner's **public** `backup-pull-key.pub`, then run `install-backup.py` as root. It adds a Shield-only nginx reload hook after successful certificate renewal. The runner's `ssh-config` and `known_hosts` are installed privately, outside Git; they use the dedicated key and `StrictHostKeyChecking yes`. Install the pull units under `/etc/systemd/system` and enable the timer; user lingering is unnecessary.
- `verify-backup.py` restores a copied dump in a new, unexposed PostgreSQL 14 container on the runner, checks schema versions and counts, then removes only that test container. Count equality assumes a quiescent source; live backups are transaction-consistent but a later count snapshot may differ.
- Check failures with `systemctl --failed` and the two backup service journals. There is no new external notification integration. The latest launch backup was also copied to Windows. Restore credentials only into the intended Shield service; never into GPS or a publicly bound test container.

## Rollback

- New service launch failure: stop only `shield-api`; disable only the Shield vhost, run `nginx -t`, then graceful reload. Leave GPS releases/services unchanged.
- Existing Shield upgrade: restore previous `/srv/shield/current` symlink and restart only Shield. DB changes must be backward compatible; take and restore the dedicated Shield backup if a future incompatible migration requires it. Never use a GPS dump to restore Shield.
- Do not automatically delete accounts, telemetry, certificates, roles or databases during rollback. HBA rollback restores the saved config only if necessary and after checking intervening changes; keep credential isolation if the new service is merely stopped.
- If rolling back Shield while the old page redirects there, restore only the old monitor locations from the saved GPS nginx config after checking for intervening changes, then `nginx -t` and reload. Preserve the KC and ingest locations. Keep backups active even while the app is stopped.
- Actual device cutover is separate. Preserve the last known working firmware and GPS endpoint until HTTPS/key authentication and new-account ownership are verified. No broad nginx redirects from the old ingest path.

## Protocol

The first real-device cutover is recorded in the deployment report. `enroll-bench.py` is the explicitly approved one-device operator: it verifies the old GPS device owner read-only, creates an independent Shield password, provisions/claims the new UID and stores a mode-0600 resumable state in `/home/mmm/shield-deploy`. Never rerun it for unrelated devices or copy the private state into a release. The original first-owner invitation has been consumed.

`verify-bench.py` signs in to that account and verifies ownership, fresh v12 reports and GPS coordinates (`--require-fix`). Optional `--attach-sim` reads the privately collected modem ICCID and only attaches it to the exact enrolled device/owner; uniqueness prevents attaching another device's SIM. These commands never call a provider, topup or payment API and never write GPS rows. Local credentials, hardware identifiers, raw coordinates and HEX files remain outside Git. The normal firmware must replace the temporary certificate-provisioning bridge before handing the device over.

POST `/ingest/shield`, JSON <=8 KiB, `X-Device-Key` header. `shield_v=1` accepts GPS points; `shield_v=2` additionally accepts sensor samples. Top-level fields: `device_uid`, `build_tag`, `ts` (uptime seconds), `csq`, `reg`, `diag` (`pv_mv`, `gnss` optional), `points`, and optional `sensors`.

- GPS tuple: `[utc_seconds, latitude_microdegrees, longitude_microdegrees, satellites]`, ascending UTC, max 8, satellites >=4.
- Sensor: `{at: utc_seconds, temp_c?: number, hum_pct?: number}`, ascending UTC, max 32; at least one measurement, -40..85 °C and 0..100%.
- Timestamp window: -15 minutes..+30 seconds. Adjust the PC/device clock before retries. Never fabricate UTC from uptime.
- Same payload retry is idempotent; overlapping measured samples use a unique key. Empty GPS yields a no-fix status. Absent sensors yield receipt-time status with no temperature/humidity.
- Keys are sent only over verified HTTPS in operation. HTTP redirects are not a substitute for firmware TLS. No GPS account cookie or legacy JWT authenticates this endpoint.
