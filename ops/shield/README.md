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
- `verify-backup.py` restores a copied dump in a new, unexposed PostgreSQL 14 container on the runner, checks schema versions and counts, then removes only that test container. The dump and metadata now share an exported MVCC snapshot, so counts match even during live ingestion. Checks include CMS, audit, channels and USIM/credit ledgers when present.
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

## Administration, USIM and dynamic sensors

Migration 5 adds users.role/disabled/credit_balance, posts with optimistic revisions,
append-only audit and credit/SIM events, sensor channel definitions and per-reading
values. Migration 6 makes provider order IDs unique. Existing v1/v2 GPS/sensor
payloads continue to work; legacy DHT readings are backfilled as `dht11` channels.

- The same `/login` serves both roles. `/admin` and every admin API independently
  require an active admin. Role changes, disabling accounts and session revocation
  invalidate sessions; at least one active administrator must remain.
- `enroll-admin.py` creates the requested separate `admin@user.com`, using a private
  resumable state. `grant-admin <email>` is an operator-only bootstrap command;
  admins subsequently manage roles, names, disabled accounts and invites in the UI.
- Posts are stored in Shield DB and seeded only when missing. Titles, descriptions,
  steps, code, categories and publishing are editable. React renders plain text;
  there is no arbitrary HTML execution. Conflicting revisions return 409.
- 1NCE uses only `SHIELD_NCE_*`, never a runtime GPS environment/database lookup.
  The operator installs selected credentials once during migration. API v1 is the
  currently verified version; follow the provider's v2 migration before v1 retirement.
  SIM quota reads are cached for 30 minutes, manual refresh throttled to 5 minutes.
  Remaining MB comes from quota.volume, capacity from quota.total_volume.
- `SHIELD_TOPUP_COST` is points per 500 MB, copied from the existing GPS operational
  setting (default 143000). New accounts have zero points. No card gateway is implied.
  Admin point adjustments require a reason and are audited. GPS balances/history
  are not merged into independent Shield identities.
- A user request atomically reserves points. Admin approval does not send an order.
  Explicit execution requires the exact request reference. One durable transition
  sends exactly one provider POST with no automatic retries. A timeout/crash/ambiguous
  response remains unresolved; no refund or new order is inferred. Definitive
  rejection or cancellation before transmission refunds once. Reconciliation reads
  the provider order, checks SIM/type/order uniqueness and records the operator's
  confirmation note. It is an operator confirmation, not inferred payment settlement.
- Preview purchase paths run only against `mock-nce.py` on loopback with mock-only
  credentials; `test-operations.py` refuses other settings. Production verification
  never executes a topup or payment request.
- v3 payload: `sensor_set` (stable key), `channels: [{key,label,unit}]`, and
  `sensors: [{at,values:{key:number}}]`. Each reading stores channel IDs to preserve
  meaning across sensor changes. Units are immutable per set/key: use a new set
  when replacing the sensor configuration. Maximum 16 channels per batch, 32 samples,
  64 channels across the device, 8 KiB total body; sensor values must be finite.
  The published `dynamic-sensors` example documents a soil/light payload. Cards,
  chart selectors, history columns and CSV use metadata rather than fixed DHT fields.
  The latest measurement activates a set; delayed older batches cannot reactivate it.

## Approved operations upgrade

`upgrade.py prepare --release <id> --sha256 <digest>` stages a checksum-verified
artifact and saves old/proposed nginx configs and the GPS binary/process/page baseline.
Take a fresh `shield-backup` first, pull it to the runner and pass restore verification.
Inspect the proposed diff, then `apply` with `--verified-backup-sha256 <digest>`.
Only Shield restarts. GPS/dev Shield ingest and monitor APIs return 410; the old
page redirects to Shield. The legacy seriallog API alias also blocks the retired
monitor. GPS `/ingest`, `/dht`, diagnostic, scanning, JWT, FCM and USIM APIs stay intact.
Legacy Shield code is removed from the GPS source for its next release; the live
GPS binary is intentionally not replaced during KC testing. Old device telemetry
and ownership are retained. The migrated bench had no GPS SIM link or pending order.

Migrations are additive to telemetry but the old binary's embedded SQLx migration
list cannot start against newer versions. Therefore **symlink-only rollback is not
valid for this release**. Prefer a forward fix. If restoration is necessary, stop
only Shield, preserve a new dump containing post-upgrade data, restore the verified
pre-upgrade Shield backup under operator supervision, restore old env/config/symlink,
then restart Shield. Never restore/drop a GPS database or silently discard new data.

## Post photos (schema 7)

Admin → 게시물 → 편집 supports clipboard image paste in the body area, file selection
and file drop. Each text step has its own photo insertion button. Photos have alt
text, captions and an insertion position; moving a step moves its photos, and
removing a text step keeps photos at the previous insertion point. Preview uses
the same renderer as the public article. Changes become visible only after Save.

- Browser accepts PNG/JPEG/WebP up to 10 MiB, applies orientation and reduces the
  longest edge to 1,600 px. The admin-only raw upload endpoint accepts up to 2 MiB.
- Server decodes with 1,600 px/24 MiB limits and re-encodes canonical WebP, stripping
  metadata. Stored images are at most 1.5 MiB. Conversion shares the password-work
  semaphore to stay within the service's 128 MiB limit. No new service or volume.
- At most 20 photos per post; total storage is capped at 100 MiB/1,000 distinct
  assets, with SHA-256 deduplication. Only never-saved uploads older than 24 hours
  are pruned during the next upload. Any image ever saved in a post is retained
  for audit/history, even if removed later. Quota expansion requires an operator.
- `post_images` bytea and `post_image_links` are in **shield_prod**, not GPS.
  Public reads require a current published post reference; otherwise only an
  active admin may read. Unpublishing/removing the last public reference revokes
  access, with no-store/nosniff responses. Someone who already downloaded a public
  photo still has that copy. Text is rendered as text; SVG/HTML uploads are rejected.
- Daily and offsite dumps include the assets in the same database snapshot.
  Backup metadata records each image SHA-256; restore verification checks image
  hashes, table counts and schema versions.

The historical 6 → 7 deployment is documented in
`docs/reviews/shield-post-images-2026-09-28.md`. Current deployment tooling targets
schema 7 → 8 or an app-only update on schema 7/8; it does not combine older upgrades.

`test-post-images.py` runs only on the etcom-hub preview: authorization, content
validation, deduplication, optimistic revision conflicts, publishing/privacy and
bounded image processing. It never calls payment/topup endpoints.

## Device portal and lesson attachments (schema 8)

- `/guide` renders the published free example selected in Admin → 게시물. Publication
  and guide changes share a transaction lock, so the active guide cannot become a
  draft or paid introduction. Existing administrator content is never reseeded.
- `/examples` introduces free lessons and coming-soon projects. Categories/search
  appear on `/examples/all` and `/projects`. Projects have no price/payment/download
  until the product catalog and delivery policy are approved.
- Steps support titles, previous/next navigation and multiple photos with 5-second
  autoplay, pause/manual controls and reduced-motion support. Admins can upload up
  to 10 attachments, assigning each to every step or a specific step. Moving/deleting
  steps also moves/preserves photos, titles and attachments.
- `post_files` stores attachment bytes with SHA-256 IDs; `post_file_links` controls
  public visibility. Active admins upload/read drafts. Anonymous downloads require
  a current published free example reference. Files use attachment disposition,
  encoded names, no-store, nosniff and sandbox headers; no inline rendering.
- Allowlisted code/text/PDF/ZIP types only; 5 MiB per file, 100 MiB/500 assets total.
  Upload rate/concurrency limits share existing Shield resource budgets. As with
  images, never-attached uploads expire after 24 hours on the next upload; previously
  referenced files remain for audit. Backup/restore verifies both image and file bytes.
- `/data` displays labeled synthetic demos for anonymous or empty accounts/devices.
  An API error is not replaced by a demo. Private data resets across account changes.
  Device selection appears in the sidebar and URL. Existing dynamic sensor channels,
  chart/history/CSV ownership rules remain in force.
- `/devices` provides claim, owner rename (audited), recent data/location and cached
  USIM information. Online means a report in the last 3 minutes, not a confirmed
  power state. Missing quota is not zero; expired/disabled/exhausted SIMs need attention.
- Apply the reviewed schema 7 → 8 artifact with `deploy-app.py --portal-upgrade`,
  previous release/artifact SHA/fresh backup SHA arguments. It permits only the exact
  new Shield attachment nginx location and installs the updated backup script.
  Later app-only schema-8 releases omit this flag. Only Shield restarts.
- `test-portal.py` tests the disposable preview; `verify-portal.py` tests HTTPS with
  a private synthetic attachment and optional seed-pair compare-and-swap guide update.
  Neither calls billing APIs. Credentials and guide seed pairs live only in the
  private operator directory. `verify-bench.py` additionally requires fresh hardware
  telemetry, so an offline bench is reported separately from API/UI verification.

See `docs/reviews/shield-portal-2026-10-01.md` for the deployment and backup evidence.


### Wallet, FAQ and user-management rollout (schema 9)

`deploy-app.py --commerce-upgrade` is the narrow 8 → 9 transition. A fresh verified
backup is required. Only the Shield nginx CSP (Toss SDK/frames/connect/form) and
payment-return access-log suppression are changed. GPS binary, process, nginx and
Shield environment hashes are compared. Never roll an older binary back across a
completed schema migration; forward-fix, or restore deliberately after assessing
new data. Both backup and offsite restore verification include `point_orders` and `faqs`.

The point wallet uses server-selected 10,000 / 30,000 / 50,000 / 100,000 KRW packs,
1 KRW = 1 point. Order creation is account-bound and idempotent. Confirmation binds
owner, amount and payment key before a single provider approval. Only a verified
`DONE` response with exact order/key/amount/currency and no cancellations credits the
wallet in the same transaction as the payment status and append-only ledger/audit.
Unknown results retain their key for read-only reconciliation; retries never issue a
second approval. Card payments only; no virtual-account or recurring-payment flow.
User history offers result lookup. Operator payment refunds/cancellations and their
wallet reconciliation are a separate activation prerequisite, not simulated refunds.

Production remains **disabled** without explicit `SHIELD_TOSS_ENABLED=true` and a
matching Shield `live_ck_` / `live_sk_` pair. GPS keys are never inherited or copied.
Confirm the merchant's Shield domain/return URLs and refund operating procedure
before activation. Preview payments require a loopback mock, even if test keys exist.
`test-commerce.py` cannot use a real Toss endpoint. No real payment was used to test.
SDK contract: https://docs.tosspayments.com/guides/v2/payment-window/integration
API contract: https://docs.tosspayments.com/reference

`SHIELD_SIM_SALES_ENABLED` defaults false while the user's new USIM catalog/prices
are pending. Existing requests and ledgers stay available. When explicitly enabled,
the established provider supports a single 500MB SKU, with server-side quote validation
and the existing reserve/approve/execute/refund workflow. Do not label a 1GB/5GB/10GB
mockup product as delivered through that adapter: volume-to-provider fulfillment must
be specified with the final catalog. Never test real 1NCE orders. Projects remain
coming soon and do not expose paid code/files or invent prices.

FAQ content is DB-driven, published/hidden/archived with revision conflict detection,
audit history and restore-to-hidden. Public views never include drafts/archives.
Admin user totals count paid orders only (Asia/Seoul day/month); adjustments do not
inflate sales. User details and CSV export omit raw subscriber identifiers; CSV
formula characters are escaped. CSV exports explicitly cover the currently loaded
page (up to 100 accounts), not all accounts silently.

### Google Drive attachments (schema 10)

The editor now registers Google Drive **file** links and display filenames instead
of uploading binary attachments to the VPS. Upload only free public example assets
to a dedicated Drive folder, share as "Anyone with the link / Viewer", allow
downloads, and verify access without signing in before adding the link. Photos
remain in the existing image store. Drive availability and sharing remain managed
in Google Drive; hiding a Shield post does not revoke a previously shared Drive URL.

`POST /api/admin/post-files/drive` canonicalizes HTTPS drive.google.com file URLs,
requires an active administrator and same-origin request, and audits additions.
No Google credentials are stored and no remote content is fetched by the API.
New records contain metadata only. `/api/post-files/:id` checks the existing free
published-example/admin permissions, then returns a no-store 307 to Drive without
loading or proxying file bytes. Paid projects still cannot contain attachments.

For existing files, the same endpoint's optional `existing_id` maps the original
ID to Drive, retaining all post content, revisions and attachment positions. A
different destination cannot silently overwrite a prior mapping. Verify uploaded
file hashes first. Existing binary data is retained for deliberate recovery;
unmapped historical files still use the legacy endpoint. The operator-only legacy
upload endpoint remains compatible, but is no longer used by the editor.

Use `deploy-app.py --drive-upgrade` for the reviewed 9 → 10 release, with a fresh
offsite-restored backup. No nginx, GPS or Shield environment change is needed.
Backup/restore verifies Drive metadata and any retained bytes. Do not start a
schema-9 binary after migration; forward-fix or deliberately restore after assessing
new data. `test-drive-files.py` runs only against shield_test and never contacts
Google, payment providers, or production.

### Category and lesson thumbnails (schema 11)

Administrators can set a category thumbnail in **카테고리** and a lesson/project
thumbnail in the post editor. Both accept file selection, clipboard images and
drag/drop through the existing normalized image pipeline. Images fit inside white
cards without cropping; removal restores the default illustration/icon. An alt
description is required. Unsaved previews do not change public cards.

Post thumbnails use the existing post revision and image links. Category settings
have their own revision conflict check and audit entry. Public category images are
accessible only while that category has a published example. Draft-only images
remain administrator-only. Removed images are retained for history. Backups verify
category metadata and all image bytes on restore.

Lesson line controls allow **순서 번호** or **! 안내**. A line prefixed with `! `
renders as an unnumbered notice; later numbered lines continue without counting
the notice. Existing lesson text is not rewritten.

Use `deploy-app.py --thumbnail-upgrade` for the 10 → 11 migration after a fresh
offsite-restored backup. This adds an empty category table; existing posts and
files stay intact. Do not start a schema-10 binary against schema 11.
`test-thumbnails.py` exercises authorization, publication, removal, conflicts and
shared image references exclusively in `shield_test`.
