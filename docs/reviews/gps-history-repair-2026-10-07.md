# GPS activity dates and history error repair

## Production result

- Deployed 2026-10-07 09:54 KST to `gps.serial.kr`.
- Source: `21adc14482b5ac3ab71b8f66760aa55b8954b459` (`codex/gps-history-production`).
- Release: `dev-20261007-094759-21adc14`; production directory `/home/mmm/releases/prod-20261007-094759-21adc14`.
- Artifact SHA-256: `5df835dba759252f4cfa592d3885f94a8b4a35afcb5910e70ea1ab5b11a1dd17`.
- Device label ending 520211: active dates HTTP 200 (2 dates), daily statistics HTTP 200 (3 rows), October 5-minute path HTTP 200 (56 buckets at deployment).
- Post-deployment API health and DB connection succeeded. No matching `ERROR`, `database error`, or `set-valued` API log entries through the follow-up check.

## Cause and implementation

The production PostgreSQL 14 / TimescaleDB 2.19.3 hypertable rejected `SELECT DISTINCT unnest(location_fix_dates(...)) ... ORDER BY ...` with SQLSTATE `0A000`: `set-valued function called in context that cannot accept a set`.

The existing query failed in a read-only reproduction on the affected device. The replacement query expands the array using `CROSS JOIN LATERAL unnest(...) AS dates(d)` in `FROM` and returned the two expected KST activity dates in approximately 24 ms. Ownership predicates, descending distinct dates and the latest-365 limit remain in place. The exact optimizer defect was not independently established; no global optimizer settings or SQL helper functions were changed.

The daily-statistics and aggregate-path endpoints were already successful. The frontend used one ambiguous message when either the date request or the statistics request failed, making the failure look broader than it was.

- Compact history converts internal DB/HTTP 5xx errors into a Korean, task-specific message with retry.
- Detailed history identifies whether activity dates, daily statistics or both failed. Successful results remain usable.
- Failed statistics are no longer described as pending aggregation, and failed lookup is not shown as an empty month.
- Summary results are keyed by login scope, device and refresh; aborted/late responses cannot replace a different device's result.
- Both summary requests accept cancellation. The initial jump to a recent activity date resets on device change.

## Scope and validation

The deployed API was based on `e2bb6e0`; the deployed web was `3cb7de9`. The ordinary working branch also contained an undeployed removal of legacy Shield endpoints. A release branch was constructed from the deployed API plus current web so this incident deploy changes only `gps-tracker-api/src/routes/stats.rs` in the backend. Unrelated Shield cleanup and firmware changes were excluded. The reusable fix commit on the newer source branch is `6ebfeb0`.

- Rust formatting and clippy passed; 12 Rust tests passed, including the durable FCM queue test using a disposable runner DB and fake delivery service.
- All 54 web tests passed, including partial failure, retry, stale response, cancellation and device-switch coverage; production Vite build passed.
- Current production DB was backed up read-only and restored to `gps_tracker_dev_prodreview_20261007`. All 85,373 location row hashes and the user count matched the snapshot.
- All 26 API regression groups passed on that isolated restore. Coverage includes KST batch-midnight dates, prior-owner exclusion, scalar/no-fix/empty-batch behavior, unique descending 365-day cap, large history paging, 31-day aggregation, ingest retry compatibility, speed/statistics, auth and KC anonymous ingest/pairing.
- External payment/USIM/FCM credentials were excluded from the validation environment. Its API service was stopped after testing.
- Embedded migration checksums exactly matched production before promotion; no schema change was applied.
- KC diagnostic page hashes, nginx/env hashes and device ownership/command fields matched before/after deployment. HTTP and HTTPS malformed-ingest behavior and public diagnostic data lookup remained compatible.

## Recovery evidence

`ops/release_history_repair.py` pins the reviewed previous API hash/web target and validates artifact hashes, migration checksums, clone checks and offsite backup receipt before promotion. It atomically replaces the API/web and restores both on verification failure.

Private backup: `/home/mmm/backups/gps-history-dev-20261007-094759-21adc14`, with a verified Windows copy under `%LOCALAPPDATA%/GPS-PrivateBackups/`. All 12 backup files were hash-verified, including the logical DB dump, hypertable CSV and previous API/web. Secrets and device data are not in Git. Build/deployment evidence is under `%LOCALAPPDATA%/GPS-Builds/dev-20261007-094759-21adc14/`.

Backend repair applies to an already-open app. Reopening or reloading the app loads the improved frontend messages; the HTML response requires cache revalidation. The physical phone screen was not directly inspected after deployment.
