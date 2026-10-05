# Category-first Shield example library

Production release: `shield-20261005-160712-5591980` (source `5591980`).
Artifact SHA-256: `0367ff6c882a71091bedb0b129bc55de3418fd266df2250a618b106fdeca6d17`.

`/examples` now opens category cards with icons, descriptions, actual visible
example counts and category search. It uses the editor's current categories rather
than reclassifying team content. Current groups: 시작하기 2, 센서·데이터활용 9,
외부서버연동 2, 아두이노 기초(공용) 10. The four untouched legacy examples
continue to resolve to their replacements, so 27 public posts yield 23 list entries.
New administrator-defined categories appear automatically; empty names use 기타.

Cards open `/examples/all?category=...`. That list displays the selected category's
title and examples, with category switching and example search. Filters are URL
parameters so reload, copied links and browser back preserve selection. Unknown
categories/searches show an empty state with reset. `/examples/all` remains an
unfiltered legacy/bookmark entry point, accessible through 모든 예제 보기. Lesson
details link back to their category. Guide selection, project introductions and
Google Drive attachments retain their existing behavior.

Validation:

- Anonymous local preview used a read-only snapshot of current production public
  posts, avoiding preview database fixtures with stale categories.
- Browser verified 4 category cards / 23 total entries, starting category's 2
  examples, detail/category return, search/empty/reset, reload and back behavior.
- Category grids checked at 320/390/768px with no horizontal overflow; example
  list checked at 320px. Desktop layout and production category navigation were
  visually verified. No browser errors were recorded.
- etcom-hub release pipeline passed GPS check, Rust 6 tests, Clippy, frontend 17
  tests and Vite build. No VPS build or DB/content migration was performed.
- Backup `shield-20261005T070753Z.tar.gz` SHA-256
  `3fb0bd2da534ac4d996860c7d4a658380074b46fcdb7c642078824b094b5a7ab`
  was restored on etcom-hub PostgreSQL 14 before deployment; schema/counts,
  64 image hashes, 38 file hashes and Drive metadata matched.
- Deployment preserved schema 10, GPS binary/PID/start time, nginx and Shield
  environment hashes. All 27 public post JSON objects were identical before/after.
  Only Shield was restarted; no KC, firmware, billing or carrier operation ran.

UI screenshot and public snapshot are under the private operator directory
`GPS-Builds/shield-categories-20261005`, outside Git.
