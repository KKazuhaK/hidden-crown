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

## Pending external checks

Docker and WSL are not installed on this machine. Real Docker/Nginx runtime checks and native AMD64/ARM64 builds are included in CI; their remote results are reported separately from the local checks above. The user's private GitHub repository is `KKazuhaK/hidden-crown`. This validation record does not claim a GHCR image release or remote application deployment.

The self-hosted server is tested locally. Production HTTPS, the user's server configuration, different-network play, real phone hardware and the researcher-run recorded session remain unverified. The retained Cloudflare adapter has a separate preview runtime and does not provide the Node administrator/global admission layer; existing Cloudflare data is not automatically migrated into SQLite.
