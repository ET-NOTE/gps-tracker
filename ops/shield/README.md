# Shield build and deployment

This service is separate from GPS/KC. **Production changes require the user's explicit approval.** The included scripts build and test; they do not deploy to the VPS.

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

No invocation of a production apply step is included in this task's automated build or tests. The API's `invite` and `provision [name]` CLI commands emit one-time secrets; run under the Shield service environment and store/hand over through a private channel. Do not publish them in PRs or logs. Operators must provide the key to firmware separately from the owner's claim code.

## Rollback

- New service launch failure: stop only `shield-api`; disable only the Shield vhost, run `nginx -t`, then graceful reload. Leave GPS releases/services unchanged.
- Existing Shield upgrade: restore previous `/srv/shield/current` symlink and restart only Shield. DB changes must be backward compatible; take and restore the dedicated Shield backup if a future incompatible migration requires it. Never use a GPS dump to restore Shield.
- Do not automatically delete accounts, telemetry, certificates, roles or databases during rollback. HBA rollback restores the saved config only if necessary and after checking intervening changes; keep credential isolation if the new service is merely stopped.
- Actual device cutover is separate. Preserve the last known working firmware and GPS endpoint until HTTPS/key authentication and new-account ownership are verified. No broad nginx redirects from the old ingest path.

## Protocol

POST `/ingest/shield`, JSON <=8 KiB, `X-Device-Key` header. `shield_v=1` accepts GPS points; `shield_v=2` additionally accepts sensor samples. Top-level fields: `device_uid`, `build_tag`, `ts` (uptime seconds), `csq`, `reg`, `diag` (`pv_mv`, `gnss` optional), `points`, and optional `sensors`.

- GPS tuple: `[utc_seconds, latitude_microdegrees, longitude_microdegrees, satellites]`, ascending UTC, max 8, satellites >=4.
- Sensor: `{at: utc_seconds, temp_c?: number, hum_pct?: number}`, ascending UTC, max 32; at least one measurement, -40..85 °C and 0..100%.
- Timestamp window: -15 minutes..+30 seconds. Adjust the PC/device clock before retries. Never fabricate UTC from uptime.
- Same payload retry is idempotent; overlapping measured samples use a unique key. Empty GPS yields a no-fix status. Absent sensors yield receipt-time status with no temperature/humidity.
- Keys are sent only over verified HTTPS in operation. HTTP redirects are not a substitute for firmware TLS. No GPS account cookie or legacy JWT authenticates this endpoint.
