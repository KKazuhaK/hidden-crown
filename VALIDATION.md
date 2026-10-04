# Validation record

Validated locally on October 3, 2026 (America/Los_Angeles), Windows, Node 24.19.0, Vitest 4.1.11. This record supersedes the earlier automatic-White/public-Observer workflow after the user's revisions.

## Automated checks

- Engine and board-motion tests: **32 passed** (26 engine and 6 motion cases), covering required chess cases, both-color special moves, crown capture, immutable inputs, message validation, player view redaction, castling's two moving pieces, en-passant capture location, promotion identity/type changes and suppression of initial/reconnect snapshot animation.
- TypeScript checks: both shared/Cloudflare code and the self-hosted server passed.
- Server bundle: built successfully with esbuild.
- Actual self-hosted WebSocket game smoke: **266 assertions passed**, covering turns, role authorization, draw/resignation, reconnect, private-link replacement, normal/crown capture, reveal and administrator exports. Frame-dependent assertion totals can vary slightly.
- Revised room-number smoke: **59 assertions passed**, including first-player color selection, second-player remaining seat, concurrent claims, invalid payloads, persistence, full-room handling and token-free logs.
- Isolated self-hosted integration smoke: **60 assertions passed**, including username/password login, HttpOnly sessions, CSRF/origin rejection, two simultaneous administrator views, god-view redaction, forced endings, deletion without resurrection, logout revocation, persistence across process restart, room/connection/message/login/creation limits and spoofed forwarding headers. Even the actual legacy observer token from a test fixture was rejected with close code 4001.
- Docker Compose and both GitHub Actions YAML files parsed successfully. This is syntax validation, not a container runtime check.
- Dependency audit: zero reported vulnerabilities at the tested lockfile.

## Actual browser checks

Used two player tabs in the same browser profile, an administrator tab and a god-view tab against the self-hosted preview on port 8790.

- Created a room: only White and Black invitation links appeared; Open controls were styled as buttons.
- First code join opened the White/Black picker. Selected Black. A second tab joined by the same room number and automatically received White. The first tab remained connected and usable; no replacement warning appeared.
- Both players locked crowns and started play. The authenticated admin god view showed both crowns; ordinary players retained their restricted views.
- Played e2-e4 through the board and observed the move and timing in the live god view.
- Logged in through /admin with username/password and checked the all-games dashboard, online flags, god-view link and export controls.
- Confirmed administrator force-end in the UI: both player screens displayed the administrator-ended result, revealed crowns and retained the move record.
- Opened the permanent-deletion confirmation and canceled it; actual deletion was exercised by the isolated integration tests.
- At 390 x 844, the public page had no horizontal document overflow, displayed only the two player roles and retained 20 px gaps between cards. Temporary viewport overrides were reset.
- Checked administrator browser console: no warnings/errors.

Screenshots in the ignored test-artifacts directory: choose-side.png, admin-dashboard.png and manual-join-mobile.png. Older screenshots show the superseded public-Observer workflow.

Follow-up presentation changes: explicit Cascadia Mono/Consolas/Liberation Mono/Courier New font stack and a code badge for room numbers; local SVG icons accompany action labels across the player and admin UI. Module syntax, server typecheck and bundle passed. Actual desktop/390-pixel browser checks confirmed no horizontal page overflow, working copy feedback, color-picker labels, unchanged accessible action names and no console warnings/errors. Administrator actions all loaded their icons. Screenshots: room-font-icons.png and room-font-icons-mobile.png.

Piece/movement revision: original SVG pieces replace Unicode glyphs in the board, capture trays and promotion picker. An independent actual-browser game played e2-e4, d7-d5, e4xd5 and Ng8-f6. Both player tabs showed live moving elements and capture ghosts; sampled transforms had opposite signs for the flipped Black board. After animation, moving elements/ghosts were cleared, 31 SVG pieces remained, and a player still saw only their own crown badge. The 390-pixel layout had 64 squares and no horizontal overflow. Console warnings/errors were empty.

The user requested a simple last-move indicator and then asked for a Chess.com reference. Inspected the actual Chess.com analysis board after loading a sample PGN: its two last-move highlights use yellow at 50% opacity. Adopted the same overlay approach to preserve the underlying light/dark colors. Verified precisely two highlighted squares (g8/f6), with no extra arrow or text panel, in the updated local browser. Screenshots: chess-style-last-move.png and vector-pieces-last-move.png. The earlier gray-highlight screenshots are superseded.

## GitHub CI

The CI result below covers the initial published source commit. Subsequent local replay and expiry changes have their own checks recorded below.

The first source commit, `8bd7e39a3f773b07eba1752fe7913e62eb2aceaa`, passed [GitHub Actions run 37174951859](https://github.com/KKazuhaK/hidden-crown/actions/runs/37174951859) on October 3, 2026 (America/Los_Angeles). Both `ubuntu-latest` (AMD64) and `ubuntu-24.04-arm` (ARM64) passed type checks, unit tests, the server build, self-hosted integration tests, actual Docker container games and room joins, persistence across container restart using a named volume, and Nginx configuration syntax checks. Docker and WSL are not installed locally; these container checks ran on GitHub's native runners.

## Remaining deployment checks

The user's private GitHub repository is `KKazuhaK/hidden-crown`. The first GHCR release is now complete (see the Compose release checks below). Deployment on the user's server remains unverified.

The self-hosted server is tested locally. Production HTTPS, the user's server configuration, different-network play, real phone hardware and the researcher-run recorded session remain unverified. The retained Cloudflare adapter has a separate preview runtime and does not provide the Node administrator/global admission layer; existing Cloudflare data is not automatically migrated into SQLite.

## Replay and waiting-room revision

- 36 unit tests pass, including four replay tests that compare public reconstructed positions against engine states, captures, both-color castling, en passant, promotion, preserved permanent IDs and crown redaction.
- 81 self-hosted assertions pass, adding authenticated player-link retrieval, settings authentication/CSRF/range validation, persisted settings across restart, periodic cleanup without HTTP requests, overdue crown-selection rejection, expired-room HTTP/WebSocket denial and retention of playing/ended games.
- Actual browser checks: slider keyboard traversal, clickable notation, restored captured pawn, disabled game controls while viewing history, Return to live, and exactly one crown badge for a player in an unfinished game. An independent two-player game received a new capture while replay stayed at ply zero; the slider maximum advanced to three and Return to live displayed the latest capture.
- Admin checks: manual refresh updates its timestamp, persisted timeout save shows success, White link copying matches the input value, buttons read “删除”, and confirmation actions have computed alignment `flex-end`; the deletion dialog was canceled. Console warnings/errors were empty.
- At an actual 390-pixel browser viewport the replay page document width was 375 pixels, without horizontal overflow. Temporary viewport overrides were reset. Local proof screenshot: ignored `test-artifacts/replay-timeline.png`.
- The updated local Node preview remains available on port 8790. These changes are included in source commit `a99a41d` and Docker release `v1.0.0`.

Administrator authorization follow-up: 82 self-hosted assertions passed. An isolated localhost browser check showed a specific authorization alert and login button without starting a WebSocket when signed out. Signing in returned to the original watch URL. Logging out from a second tab removed the watch board and displayed the expired-session alert, without reconnecting. Screenshot: ignored `test-artifacts/admin-authorization-required.png`. Return URLs are restricted to same-origin `/admin/watch` with a valid room number.

## Compose release checks — October 4, 2026

- Source commit `a99a41dc7e79aea72c4f61425dac5121c69a506b` passed [main CI](https://github.com/KKazuhaK/hidden-crown/actions/runs/37188169350) and [Release CI](https://github.com/KKazuhaK/hidden-crown/actions/runs/37188172528). Both native architectures passed type checks, 36 unit tests, 82 integration assertions, actual Docker games/joins, volume restart persistence, Nginx syntax, and Compose startup with environment-configured administrator login.
- [v1.0.0](https://github.com/KKazuhaK/hidden-crown/releases/tag/v1.0.0) publishes `ghcr.io/kkazuhak/hidden-crown:1.0.0`, `latest` and `beta`, plus the configuration-only `hidden-crown-compose.zip`. The ZIP was downloaded from the actual release and inspected: version 1.0.0 selected, administrator password blank, optional secrets configuration and Nginx files included.
- The user authorized public image access. GitHub's package settings confirm Public while the source repository remains private. All three registry manifests were read with an anonymous registry bearer token, without GitHub credentials; they contain Linux AMD64/ARM64 and their attestations. Manifest digest: `sha256:e09b5902cf9e09f198f89ee835ef7dc9bce3a8e55d2a9d7afcf265894912b71a`.
- Screenshot: ignored `test-artifacts/public-container-package.png`. No deployment on the user's production server has been performed.


## Public homepage and bilingual admin update (v1.0.2)

- Homepage prioritizes room-number joining; creation is a secondary header action and hidden during a game. Tested header creation, invalid-code feedback and joining with side selection in the browser.
- Headline uses smaller system typography with two sentence-level lines in English and Chinese. Verified mobile homepage and admin at 390px without document overflow. Earlier join-first layout was also verified at 320px.
- Removed tester/researcher copy and the public admin-view prompt from invitations. Browser creation exposes exactly two player links and no tester caption.
- Administrator UI shares the existing saved language preference and defaults to English without a preference. Verified English login, Chinese/English lists, settings-save success, player-link modal and delete confirmation without submitting deletion. All 69 admin translation keys match across languages.
- Refresh uses a single circular-arrow icon and a fixed 160px button width. Verified the glyph and width in the browser and a successful manual refresh.
- Type checks, JavaScript syntax checks and 82 self-host assertions passed locally. The new admin translation module is served successfully by the self-hosted asset allowlist.
