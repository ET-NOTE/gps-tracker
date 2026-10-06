# Shield library order and category entry — 2026-10-05

Release `shield-20261005-165812-ee2999b` is deployed on shield.serial.kr.
Source: `22ce2b2` (behavior), `ee2999b` (control spacing). Artifact SHA-256:
`8fe276a33a42a0b11839fba945e1bbc4f6457578d609a0eeeb5a6a61fef4a7b9`.
Built on etcom-hub, installed without compiling on the VPS.

## Behavior

- 관리자 → 노출 순서 displays the actual public categories and lesson cards' titles.
  Select a category, move it or its lessons using arrows or direct position
  selection, then use 순서 저장. Changes have a shared revision and audit entry.
  Keyboard controls and mobile layouts work; unsaved navigation is protected.
- Saved lesson order overrides the previous guide/attachment priority. New public
  items append after saved positions using the prior fallback order. Hidden,
  renamed and removed memberships are filtered when reading public settings.
  Existing legacy tutorial redirects remain excluded just as in the card list.
- `/examples/all` shows category cards with category search and actual counts.
  Selecting a category opens the existing lesson card layout at
  `/examples/all?category=...`. The category filter's first control returns to the
  category cards; switching categories clears the previous lesson search.

Schema 12 adds a singleton `library_order` table with JSON metadata and revision.
No existing posts, content revisions or thumbnails are modified. The default
empty configuration preserves the existing order until the administrator saves.
Public metadata includes no draft identifiers, actor or revision. POST requires
active admin/same-origin; duplicate IDs/categories and invalid memberships are
rejected. Content publication and order saves share the site-settings lock, and
concurrent stale writes return 409 rather than overwrite changes.

## Verification

- Final build: Rust 6 tests, strict Clippy, GPS check, frontend 21 tests and Vite
  production build passed. Regression tests cover manual order precedence,
  fallback positions and movement without lost/duplicate records.
- `test-library-order.py`: 26 checks passed in `shield_test`, including
  auth/CSRF, invalid input, wrong category/draft rejection, persistence, unchanged
  posts, publication filtering, two concurrent writes with exactly one success,
  membership changes since load and audit history. No production fixture writes.
- Browser preview: moved GPS to first category and moved the guide behind the
  second lesson. Both saved orders appeared in the public cards and survived
  reload. Category search, return to category cards and unsaved discard checked.
  Controls fit at 320px/390px; final desktop panels have internal spacing.
- Production read-only UI: new order menu with 4 actual categories and 23 listed
  examples; `/examples/all` contains category cards and no lesson cards; entering
  시작하기 shows its 2 lesson cards. Initial order metadata remains empty.
- Public posts and thumbnail JSON were byte-for-byte identical before/after the
  release. GPS binary/PID/start, nginx and Shield environment hashes unchanged.
  No payment, 1NCE order, firmware or real telemetry test was performed.

Before-release backup `shield-20261005T075855Z.tar.gz` and after-release backup
`shield-20261005T080035Z.tar.gz` were restored under PostgreSQL 14 on etcom-hub.
The latter SHA-256 is
`6e19b89a9880ef5562bbc1d2a02d5e69363647f202b78a64b2908a41fc4999b1`.
Restore checks passed for schema 1–12, all table counts, the order JSON/revision,
27 posts, 64 image hashes and 38 file hashes. Financial activity remains zero.
Do not start a schema-11 binary after this migration; forward-fix or deliberately
restore while preserving new data.

Screenshots: `%LOCALAPPDATA%\GPS-Builds\shield-order-20261005\` contains
`production-order-admin.png` and `production-basic-categories.png`. Preview API,
DB, local Vite and SSH tunnel were stopped after verification.

## Library landing simplification

Follow-up release `shield-20261005-172117-5f3951b` (SHA-256
`d4bb3af39f23a09a0b382ef3f3c51b7f6c95e0c170bd397ac7d3a6a8486cd4c2`)
removes the application-project section and redundant 기본 예제/무료 heading and
전체 보기 link from `/examples`. The start-guide banner now precedes the complete
category grid. Categories still use the saved display order and search; the
separate projects route and category lesson-card navigation remain available.

This changes two frontend files only. Final standard build checks passed (Rust 6,
frontend 21, Clippy, GPS check and Vite). Production browser verified four category
cards, no project cards or redundant section title/link, guide above cards, and
the working guide link. At 390px there was no horizontal overflow and the guide
button used a full row. Screenshot:
`%LOCALAPPDATA%\GPS-Builds\shield-library-focus-20261005\production-library.png`.

Deployment kept schema 1–12, GPS runtime, nginx and Shield environment unchanged.
Before-release backup `shield-20261005T082024Z.tar.gz` was restored and verified on
etcom-hub (all counts, image/file hashes and ordering metadata). No content edits,
schema changes or financial actions were performed.
