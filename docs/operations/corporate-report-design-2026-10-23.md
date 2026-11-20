# Corporate report subscription design — 2026-10-23

Production web release: `web-report-design-20261023-2126bd4`.
Source: `2126bd46e853a154d4a4dbde5684e23523fe60ca`.

## Change

- Corporate vehicle and monthly report entry screens now reuse the settings subscription component, including the existing payment confirmation modal and duplicate-submit lock.
- The report entry presents the API-provided price, 30-day duration, points guidance and three report features in standard business cards. Desktop uses two columns; narrower screens stack the cards.
- Subscription loading, failure and inactive states are handled before mounting report queries. A failed status lookup offers retry instead of a misleading purchase prompt.
- Active reports, payment APIs, prices and account data remain unchanged. The shared settings component also shows the points top-up guidance.

## Verification

- Node 22 build runner: all 138 existing tests passed; production Vite build passed. The archived source includes the shared battery-policy JSON dependency. Existing PDF chunk-size warning remains.
- Isolated browser fixture: 320px dark theme and 390px light theme have no horizontal overflow; desktop cards and both report selectors verified.
- Mock-only purchase confirmation: cancel, failure with preserved modal, and success returning to the report verified. Missing price disables purchase. Subscription lookup error shows retry. Active daily and monthly report rendering verified without console errors.
- Production authenticated corporate report screen verified after deployment; cards use the available content width, with no console errors. No production purchase was made.
- Production promotion verified root, devices and corporate SPA routes, all new JS/CSS hashes, unchanged API release and unchanged diagnostic pages.

## Deployment and evidence

- Runner: `/home/etcom-hub/build/gps-report-design-20261023`.
- Local evidence: `C:/Users/msb/AppData/Local/GPS-Builds/report-design-20261023` (`build.log`, `manifest.json`, `web.tar.gz`, `production-report.jpg`).
- Archive SHA-256: `225317d70786e3e39c4820b43b755b6579af734395d0477cbfcc35587d49e915`.
- Production target: `/home/mmm/releases/web-report-design-20261023-2126bd4/web`.
- Previous web: `/home/mmm/releases/web-directions-20261022-2f5c4c3/web`.
- API release retained: `dev-20261021-190449-d541456` (production environment; historical release name).
- No API restart, DB migration, firmware/APK update or dev-gps deployment.

The existing production APK uses the updated web screen after a page reload.
