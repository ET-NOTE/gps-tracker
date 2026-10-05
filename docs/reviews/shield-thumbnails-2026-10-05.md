# Shield category and lesson thumbnails — 2026-10-05

## Result

Release `shield-20261005-163018-8fb5223` is running on shield.serial.kr with schema
1–11. Source commit: `8fb5223`; artifact SHA-256:
`d419f4348cbcad0c07c727944bddcd83d30828bf493cafb9315777aa51172fbd`.
Built on etcom-hub and installed as an artifact; no build on the VPS.

- 관리자 → 카테고리: choose a current category, upload/paste/drop one image,
  enter its accessible description, preview the actual card, and save.
- 관리자 → 예제·가이드 → 편집: set the independent 강의 썸네일, with the same
  upload controls and a live list-card preview. The lesson body's photos remain
  independent. Images fit in white card areas without cropping. Delete restores
  the default icon/illustration.
- 문장별 표시 (번호 / ! 안내): choose which lines are notices. Internally a `! `
  prefix marks an unnumbered notice; following sequential items continue normally.

No production thumbnails were chosen on the author's behalf. Existing post text,
photos, category names and revisions were not rewritten. All 27 public post JSON
objects were byte-for-byte unchanged across this deployment. Real content can be
edited through the new UI; no test content was written to production.

## Storage and permission checks

Schema 11 adds only `category_thumbnails`. Post thumbnails are optional existing
content JSON metadata linked through `post_image_links`. The existing image
normalization and storage limits apply. Category metadata is audited with a
revision conflict check; clearing it retains a revision tombstone. Draft-only
photos are administrator-only, and public category photos require a published
example in that category. Removing the last public reference revokes anonymous
access while retaining historical images. Backups cover category metadata too.

ZIP/code attachments still redirect to Google Drive. No payment, 1NCE order,
firmware upload, GPS environment, nginx, GPS binary or GPS process changed.

## Verification

- Rust 6 unit tests, strict Clippy, GPS compile check, frontend 18 tests and
  production Vite build passed.
- Isolated `shield_test`: thumbnail 23, image 24 and portal 39 checks passed.
  Includes auth/CSRF, invalid image reference/alt, publish/unpublish, shared body
  and thumbnail links, removal, stale revisions, audit and historical retention.
- Browser preview: product photo file upload for a category; clipboard replacement
  for a lesson; saved preview persistence; numbered → notice → numbered behavior;
  unsaved-change discard protection. At 390px, both editors had no horizontal
  overflow. Mixed category icon/photo card titles stayed aligned on desktop.
- Production read-only browser check: category chooser, upload control, real
  category counts, lesson thumbnail and per-line controls present. Public category
  thumbnail API returns an empty list until the author assigns photos.

Before release, backup `shield-20261005T073422Z.tar.gz` was restored on etcom-hub
under PostgreSQL 14. After release, `shield-20261005T073704Z.tar.gz` (SHA-256
`080fdacdd8080ff5999eb33b2bc4c8d3694f1c23b65aac5302f2ce3b3f06822b`) also passed
restore verification: schema 1–11, 27 posts, 64 image hashes, 38 file hashes,
category metadata and all tracked table counts. Category settings initially 0.
Real point orders, USIM requests and ledgers remain 0. Do not roll back to a
schema-10 binary after this migration; forward-fix or deliberately restore.

Local screenshots are under
`%LOCALAPPDATA%\GPS-Builds\shield-thumbnails-20261005\`:
`category-preview.png` (isolated sample) and `production-category-editor.png`.
