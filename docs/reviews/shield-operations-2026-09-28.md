# Shield administration, USIM and dynamic sensors — 2026-09-28

The user authorized an administrator account, browser editing and audit, retiring
remaining GPS Shield paths, functional 1NCE integration without live purchases, and
sensor-independent cards/tables. The deployment was completed at 17:03 KST.

## Deployed

- Source: `06e352b`, branch `codex/shield-platform`, draft PR 246.
- Release: `shield-20260928-170203-06e352b`, built on etcom-hub only.
- Artifact SHA256: `d075fd255f41da9043290276405ab0b1f81c6953d2151387d1223d390a5cffc3`.
- Independent Shield DB schema versions 1–6; API service still limited to 128 MiB,
  one CPU and four PostgreSQL connections. Observed cgroup memory about 60 MiB,
  three tasks; VPS available RAM about 1.1 GiB, disk about 4.3 GiB free.
- `admin@user.com` is a separate administrator using the same login. Its generated
  password is in the user's private local `GPS-Builds/shield-admin-account.txt`,
  never in Git. Existing `user@user.com` remains an ordinary owner of device 2.
- `/admin`: overview, editable/publishable posts and examples with revision conflicts,
  user roles/disable/session revocation/invites, device/SIM editing, requests,
  point adjustments, immutable credit/SIM events and audit inspection.
- Seven public examples now live in Shield DB, including the v3 sensor protocol.
  Browser editing was exercised in preview; production editor/login were verified.
- The existing physical v12 firmware continues sending GNSS/PV to Shield with its
  unique device credential. No firmware change was necessary in this round.

## 1NCE and ledger

The Shield service reads its own `SHIELD_NCE_*` configuration. Existing provider
credentials were installed once by the operator, with no runtime GPS DB/env access.
Live operations only authenticated and read SIM metadata/quota. At 17:03:15 KST the
real balance was 499.407129 MB out of 500 MB (displayed 499.41 MB). Cache refresh is
30 minutes, manual attempts are limited to five-minute spacing.

The provider execution path is configured, not stubbed. User requests reserve points;
admin approval alone does not purchase. A separate exact-reference confirmation
executes one durable, non-retried topup. Definitive rejection and pre-transmission
cancellation refund once. Ambiguous results stay unresolved until an administrator
checks the provider order; SIM/type/order uniqueness are checked. A crash cannot
automatically trigger a second POST. Mock provider tests cover concurrent execution,
rejection, ambiguous status and reconciliation. **No production topup/payment request,
point adjustment or charge was created.** New accounts have zero points; the existing
operational price is 143000 points per 500 MB. No new card payment gateway is implied.

1NCE v1 was verified against the live account. Its upcoming v2 migration remains a
provider-maintenance follow-up before v1 retirement; the dedicated adapter has a SIM
version setting. References: [data quota](https://help.1nce.com/api/sim-management/get-data-quota-for-sim-using-get/),
[topup](https://help.1nce.com/api/sim-management/top-up-using-post),
[API migration](https://help.1nce.com/platform-migration/api-migration/).

## Dynamic sensors

v3 declares sensor_set and channel key/label/unit, with UTC samples containing value
maps. The UI derives cards, chart choices, history columns and CSV from metadata.
Different configurations keep different channel IDs; historical units cannot be
overwritten. Late old batches cannot replace the active configuration. Legacy v1/v2
remain compatible and DHT history is backfilled. The real device currently sends
GNSS/PV only, so no fabricated temperature/humidity values are displayed. Soil/light
to pressure replacement was verified with preview data, not invented production data.

## GPS/KC preservation

- Live GPS binary hash remains `81214c4f4c49ee361a92271f913271ccc9bc633b7d0e41e51807df945cae79d9`.
  Its process/start time, home page and diagnostic page hashes match the pre-upgrade
  baseline. The GPS API was not restarted or rebuilt on the VPS.
- GPS and dev `/ingest/shield` and Shield monitor APIs are retired (410), while
  `/arduino-shield` redirects to Shield. Legacy seriallog API aliases are also closed.
  One seriallog enabled config was a regular file, not a symlink; its active file
  was backed up and patched separately, followed by full nginx validation and reload.
  The upgrade helper now uses loaded `sites-enabled` files explicitly.
- General `/ingest`, `/dht`, diagnostic, scanning, notifications and GPS USIM paths
  were not changed. Retired Shield modules/bundle were removed in source for the next
  GPS release; they are still in the unchanged live GPS executable behind closed paths.
- Old device 3015, its owner and telemetry are retained. It has no GPS SIM link and
  no historical/pending topup request, so no cross-product financial migration was needed.

## Verification and recovery

- Shield Rust unit tests 3, Clippy with warnings denied, release build.
- Existing API integration 40; new admin/USIM/dynamic-sensor integration 43;
  WebSocket ownership/origin/revocation 7; frontend tests 9.
- GPS frontend regression tests 29 and build; default GPS Rust target checks.
- Disposable PostgreSQL 14 schema/role isolation and nginx syntax checks.
- Browser checks: admin same-login/menus/editor, saved preview post, safe literal
  rendering, ordinary-account role boundary, dynamic pressure/old soil cards and
  table, real production quota. Production read-only verification script: 24 checks.
- Pre-upgrade offsite backup `shield-20260928T080043Z.tar.gz`, SHA256
  `394828326db81e57b22d3113a89fbb98add4e5d8fefbbdcf3ad3c55fffd6f701`, restored successfully.
- Post-upgrade `shield-20260928T080625Z.tar.gz` restored on PostgreSQL 14: users 2,
  devices 1, readings 81, location_records 460, content_posts 7, audit_log 1,
  sensor_channels/sim_requests/sim_ledger/credit_entries all zero, schema 1–6.
  Counts and dump now share an exported transaction snapshot during live ingestion.
- Root-private rollout state and old/proposed nginx configs remain under
  `/var/backups/shield-rollout/shield-20260928-170203-06e352b`.

The previous executable cannot accept new embedded SQLx migration versions, so a
symlink-only rollback is insufficient. Prefer a forward fix; if restore is needed,
preserve a fresh post-upgrade dump before supervised restoration of the dedicated
Shield backup. Do not discard new telemetry or touch GPS databases automatically.
