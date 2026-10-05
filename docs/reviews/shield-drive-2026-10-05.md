# Shield example downloads on Google Drive

## Result

- Production: `shield-20261005-153059-68d0e7d`, source `68d0e7d`.
- Artifact SHA-256: `4f569da36b9e372e83c706a1277f14d74db2fd6eb9b1cf0a0a1b7daf06d8ae7a`.
- Public tutorial attachments: 18 files, 158,286 bytes. ZIP, INO and Markdown were
  copied byte-for-byte to the company Drive's dedicated public examples folder.
  All 18 were downloaded without Google cookies/authorization and matched their
  existing SHA-256 IDs before production mapping.
- Folder: https://drive.google.com/drive/folders/1YMujWFyPGKWDrBnDso-sHwq4cW-Ke11D
  (Anyone with the link / Viewer). No existing company folder was shared.
- All 18 existing attachment URLs return an empty, no-store 307 to their Drive
  file viewer. File bytes flow from Google to the visitor, not through the VPS.
- All 27 production posts, revisions, update timestamps, photos and attachment
  positions were compared before/after and remained identical. Recent team edits
  were preserved. No source seed was republished.

## Editor and backend

The editor accepts a filename and Google Drive file share link. Registered links
appear in the existing attachment list, per-step placements and user preview.
The editor instructs authors to verify public download permission and warns that
unpublishing a post does not revoke independent Drive sharing. Free public examples
only: the existing paid-project attachment prohibition remains in force.

Migration 10 adds a Drive destination to `post_files` and permits metadata-only
records. URL validation allows canonical HTTPS Google Drive file destinations,
including a validated resource key, and rejects folders, foreign hosts, credentials,
ports, controls and ambiguous IDs. Registration is admin-only, origin-checked,
rate-limited and audited. The server makes no request to Google and stores no Google
credential. Repeated registration is idempotent. A different destination cannot
overwrite an existing mapping silently.

Old IDs and stored bytes are retained for deliberate recovery; unpublished legacy
attachments are not migrated automatically. Legacy upload is retained for operator
compatibility, but removed from the CMS UI. Inline code remains readable; redundant
local code-file downloads were removed. Images and user CSV exports are unchanged.

## Verification

- etcom-hub immutable build: GPS cargo check, Rust 6 tests, strict Clippy, frontend
  17 tests and Vite build passed. No VPS build was performed.
- Isolated preview: 24 Drive tests and 39 portal regression tests passed. Checks
  include metadata-only storage, malformed URLs, admin/user/anonymous permissions,
  public/draft visibility, unchanged revisions and preserved legacy bytes.
- Browser: added and saved a real Drive link to a preview-only draft through the
  editor; production Firebase example's ZIP action opened the expected Drive file.
- Production: 18 anonymous redirects verified; 28 existing commerce/isolation
  checks passed, with no financial calls. Financial tables remained unchanged.
- GPS binary, PID/start time, nginx and Shield environment hashes were unchanged.
  Only Shield API restarted. KC/firmware were untouched.
- Before: `shield-20261005T063456Z.tar.gz`, SHA-256
  `2b33bfecd662780d2edb7b44a26196de3f2cf598165a1c7c6eb832ea4244e4e4`.
- After: `shield-20261005T063654Z.tar.gz`, SHA-256
  `3015665def310caa5c812e12dbd1d633e33616e862db2d59113956bc2b837a5b`.
- Both backups were copied to etcom-hub and restored in isolated PostgreSQL 14.
  Schema/counts, 64 image hashes, 38 retained file hashes and the 18 Drive mappings
  were verified. Mapping added exactly 18 audit events (197 → 215).

## Operation

Upload a new free attachment to Drive, enable public viewer/download access, then
paste the file's share link into the editor and save the post. A folder link cannot
be attached. Drive permissions/deletion/availability govern actual file access;
the application validates link shape rather than claiming Google accessibility.
The dedicated folder is public, so do not place private or paid delivery files there.

The 9 → 10 deploy uses `ops/shield/deploy-app.py --drive-upgrade` after a fresh
verified backup. Older SQLx binaries cannot be restarted against schema 10; use
a forward fix or deliberate Shield-only restore accounting for newer data.
Private migration maps, post snapshots and verification results are kept outside
Git under the operator's `GPS-Builds/shield-drive-20261005` and Shield deploy folder.
