# Hidden Crown

Two-player online chess with one secret crown per side. Capture the opposing crown to win. There is no check or checkmate. The browser only highlights server-supplied moves.

The production server now supports self-hosted **Docker + Nginx**, using Node.js 24, SQLite or PostgreSQL, and WebSockets. It shares the same pure chess engine and room core with the retained Cloudflare adapter. See [DEPLOYMENT.md](DEPLOYMENT.md) for deployment, resource limits, admin credentials and GHCR publishing.

## Compose deployment

Download `hidden-crown-compose.zip` from [Releases](https://github.com/KKazuhaK/hidden-crown/releases). Copy `.env.example` to `.env`, set `PUBLIC_ORIGIN`, `ADMIN_USERNAME` and your own `ADMIN_PASSWORD` (16–256 characters), then run:

```bash
docker compose pull
docker compose up -d
```

No source checkout or server-side build is required. The package includes Nginx snippets; The root Compose template uses a named Docker volume; `docker-compose.bind.yml` and `install.sh` use `/opt/hidden-crown/data` when installed there. The optional `docker-compose.secrets.yml` uses a password file instead. See [DEPLOYMENT.md](DEPLOYMENT.md) for complete steps.

## Local development

```powershell
npm install
npm run build
$env:ADMIN_USERNAME = 'admin'
# Set your local administrator password in your terminal or use ADMIN_PASSWORD_FILE.
$env:ADMIN_PASSWORD = '<at least 16 characters>'
npm start
```

Open `http://127.0.0.1:8787`; `/admin` is the account/password login page. `PORT` and `PUBLIC_ORIGIN` can select a separate local preview port. The application refuses to start without an administrator password. Credentials are not embedded in the source or Docker image.

When npm is missing from PATH in the Codex workspace, its bundled pnpm can invoke npm:

```powershell
& "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" dlx npm install
```

## Join and play

Create a room and share its eight-character number. The first person entering it chooses White or Black; the next person receives the other side. Joining never automatically reuses a browser-wide credential. Each tab keeps its current token in sessionStorage; optional resume buttons use separately stored White/Black credentials. Opening the same private role link still intentionally replaces the earlier connection to that role.

The header opens the dedicated `/create` page. Friend-room results display immediately there, with White and Black private links and matching Copy/Open button styles. Refreshing restores links within the same browser session. `/rules` and the in-game Rules dialog describe gameplay. Creation responses omit observer links. Public observer-token authentication is disabled; only an authenticated administrator can open the live god view. The administrator can see both crowns, move times, player presence, JSON/CSV exports, and all rooms with pagination. End-game preserves the record and reveals crowns; Delete removes the room and logs after an explicit UI confirmation.

The seven-ply smoke game: White crowns `wQ`, Black crowns `bBf`; play `e2-e4`, `g7-g5`, `Qd1-h5`, `a7-a6`, `Qh5xf7`, `a6-a5`, `Qf7xf8`. The normal pawn capture continues play, while capture of the crowned bishop wins.

## King interrogation (2.3.1)

New rooms use `hidden-crown@3`. Pick a crown from the seven original pieces: queen, two rooks, two bishops or two knights. The king cannot be crowned. Each side may spend two whole turns interrogating with its surviving king. Targets must be original enemy crown candidates on the same rank, file or diagonal; blockers do not matter. Pawns, kings, promoted pieces, captured pieces and targets already interrogated by that side are excluded. Capturing a king does not end the game, but removes that side's interrogation ability.

An interrogation consumes a turn without moving or capturing. Only its actor receives the answer; opponents see the king and target, and authenticated administrator observers receive every answer. Identifying a crown does not win. Player state frames never contain the opponent’s interrogation answers, even after the game ends. JSON/CSV administrator exports include action type, target ID/square, answer and thinking time. Notation identifies the king, for example `Ke2 ? bQ@e7`. Replays include interrogation turns without changing the board or castling rights.

Interrogations expire en passant, clear draw offers and count as non-capture, non-pawn turns for the existing draw limit. No-action draws require that neither a move nor interrogation is available. Undo may withdraw ordinary moves after the latest interrogation, but cannot withdraw or cross an interrogation because knowledge cannot be revoked. Computer opponents use only their own interrogation results.

Existing `hidden-crown@1` and `hidden-crown@2` rooms retain their original rules and matching UI text, without a schema migration or database reset. New rooms use the corrected king-interrogation rules.

新房间使用 `hidden-crown@3`：后、双车、双象、双马可成为王冠，王不能加冕。只有王能审问，每局两次，消耗整个回合，可穿透棋子审问同横线、竖线或斜线上的对方候选。王被吃掉后对局继续，但该方无法再审问。规则、提示、操作、观察者界面、记录和导出均同步中英文。审问答案只属于发起方和管理员观察者，发现王冠后仍需吃掉它。审问无法悔棋，后续普通走棋仍可申请悔棋。已有 v1、v2 房间沿用创建时的规则，无需清空数据库。

## Human vs computer (2.1)

Select Computer on `/create`, then Easy, Medium or Hard and White, Black or Random. A computer game reserves both seats and returns only the human's private link. Room-number joining cannot take over either seat. Returning through that link resumes the game after disconnects or a server restart.

The computer chooses its own secret crown and searches only a projection of public pieces, board, rule options and its own crown. It never receives the human's crown, credentials or private logs. Easy usually chooses a random legal move; Medium and Hard use bounded iterative alpha-beta search with larger depth/node/time budgets. This is an engine for this variant, without an Elo rating. The authoritative rule engine revalidates every returned move, including promotions, castling and en passant. The computer declines draw offers.

Searches run in a shared worker pool, default two workers, with bounded queue, memory and execution time. Default admission allows 50 unfinished computer rooms. Computation pauses while the human is disconnected. Revision checks discard stale results after a new state, administrative termination or deletion. Both SQLite and PostgreSQL persist computer configuration and moves. Version 2.1 automatically migrates 2.0 databases; retain the same database path/URL and back up before upgrading. The retained Cloudflare adapter currently supports friend games only.

Run `npm run test:computer` for isolated real HTTP/WebSocket tests, with `TEST_DATABASE_URL` set for PostgreSQL. Against a disposable deployed container, provide `HIDDEN_CROWN_URL` and test administrator credentials; the suite creates and deletes only its own rooms.

## Validation commands

```powershell
npm test
npm run typecheck
npm run build
npm run test:selfhost
```

`test:selfhost` starts isolated local servers and checks actual HTTP/WebSocket behavior, administrator authentication/authorization, CSRF, live god views, force-end, deletion, restart persistence and resource-limit rejection. It writes only ignored test fixtures. It needs ports 8791–8793, 8803 and (for PostgreSQL) 8805 available. Without TEST_DATABASE_URL it uses SQLite. Set TEST_DATABASE_URL to an isolated PostgreSQL test server with CREATE DATABASE permission to repeat the same suite against PostgreSQL; the suite creates and removes only its own UUID-named test databases.

For the longer room and join suites against a running self-hosted server, explicitly provide the test administrator credentials:

```powershell
$env:HIDDEN_CROWN_URL = 'http://127.0.0.1:8787'
$env:HIDDEN_CROWN_ADMIN_USERNAME = 'admin'
$env:HIDDEN_CROWN_ADMIN_PASSWORD = '<your local test password>'
npm run test:room
node scripts/join-smoke.mjs
```

These checks create test rooms. When running several suites from one IP, use a disposable server with appropriately raised creation limits. `scripts/persistence-smoke.mjs prepare`, a server restart, then `verify` provides an additional stored-state check; `test:selfhost` also performs a complete restart check itself.

CI repeats tests on native Linux AMD64 and ARM64 and validates the Docker runtime plus Nginx syntax. Tag releases publish a multi-platform GHCR image. The private repository is `KKazuhaK/hidden-crown`; the deployment image is public for anonymous pulls. The image address becomes available after the first successful tag release.

See [VALIDATION.md](VALIDATION.md) for completed checks and remaining external validation. Automated games do not substitute for the recorded research session in `BUILD_SPEC.md`.

## Project layout

- `src/engine.ts`: pure chess movement/application/end detection.
- `src/rules/`: versioned rules, lifecycle, legal moves, command validation and win conditions.
- `src/room-core.ts`: transport-neutral room lifecycle, authentication, redacted views and transactional commits.
- `src/persistence.ts`: asynchronous room repository contract.
- `server/`: self-hosted HTTP/WebSocket runtime, room ownership/cache and bounded rate limiting.
- `server/database/`: PostgreSQL pool, SQLite worker, common transaction API and versioned migrations.
- `server/storage.ts`: normalized snapshots, active move history and append-only events, sessions/settings/audit repository.
- `public/`: vanilla JS board/game UI and administrator dashboard.
- `Dockerfile`, `docker-compose.yml`, `deploy/`: container and Nginx deployment.
- `.github/workflows/`: native architecture verification and GHCR releases.
- `src/room.ts`, `src/worker.ts`, `wrangler.jsonc`: retained Cloudflare adapter, without the self-hosted global admin/admission layer.

## Storage and extension interfaces (2.0)

Empty `DATABASE_URL` selects SQLite for immediate local testing; a PostgreSQL URL selects an asynchronous pool. Production Compose can connect to an existing PostgreSQL with `docker-compose.postgres.yml`. No Redis/MySQL service is required. This major version uses fresh `hc_` tables and defaults to `hidden-crown-v2.sqlite`; 1.x records are not automatically imported, and the original SQLite file is preserved.

A commit atomically replaces a position snapshot and appends new move/event rows. An approved undo atomically trims the active move history; original moves remain in the event audit together with the undo decision. History is not serialized into the snapshot. A revision check rejects stale concurrent writes and callbacks after deletion; foreign keys cascade deletion. Schema migrations run transactionally and retain a version record.

`RuleSet` is a pure, trusted-code interface for the existing 8x8 chess board/protocol family. Register an implementation in `src/rules/registry.ts` with a unique ID/version, option validation, an initial position, join/setup lifecycle, legal move generation, and `applyCommand`. The latter returns a new state plus private log events, or a safe public error. All built-in gameplay decisions now dispatch through this interface. `rule_action` provides a bounded JSON command envelope for future actions. Hidden rule data belongs in `state.ruleState`, which is never included in player or admin view payloads. Explicitly add any new public presentation fields to the protocol rather than exposing the entire rule state. New non-chess board types require a separate renderer/protocol contract.

Rooms retain their ID, version and normalized options; register changed semantics under a new version rather than altering an existing implementation. Removing a version still used by stored rooms prevents loading those rooms. Replay uses the persisted public initial position, not an assumption about the original piece layout. Plugins must not put hidden information into initial-position metadata, public options, or error-dependent behavior.

```http
GET /api/rules
POST /api/rooms
Content-Type: application/json

{"ruleset":{"id":"hidden-crown","version":2,"options":{"castling":false,"enPassant":true,"drawPlyLimit":100}}}
```

Omitting the body keeps the original default game. The shipped UI continues to create that default; additional mode selection UIs can consume `/api/rules`. Existing frontend authentication and private-link behavior remains unchanged.

`RoomManager` owns room loading, per-room command queues, presence, expiration and bounded caches. A future distributed implementation must add a room-owner directory/router and cross-instance broadcast before scaling application instances; changing database alone is insufficient. PostgreSQL currently enforces one application owner per database. Redis may provide shared limits/broadcast later.

`npm run test:capacity` creates 100 simulated players in 50 isolated games and writes timings to ignored test artifacts. Set `TEST_DATABASE_URL` to select a disposable PostgreSQL database. The tests use real database engines and real HTTP/WebSocket connections; the local timings are not a production capacity promise.

## Undo, turn timing and sound

Players can request undoing their most recent move; if the opponent has replied, both plies are withdrawn. The opponent must accept or decline, and moves pause until the decision. The computer automatically accepts. Crowns remain locked; ended games cannot be undone because crowns have been revealed. Undo restores captures, promotion, castling rights, en-passant, turn and draw counters through the rules engine. Pending requests survive restart; active moves and append-only audit events are committed together in either database. RuleSet implementations can expose `canRequestUndo` and handle `request_undo`/`respond_undo` in `applyCommand`.

The board shows elapsed time in the current turn and history shows each move’s think time, using server timestamps with client clock correction. Accepted undo restarts the turn timer. This is informational timing, with no clock or timeout defeat. A quiet turn chime plays on actual transitions to the player’s turn, with a persistent mute control. Browsers require an initial click or keypress to enable audio; reload and presence updates do not replay the chime.

Replay is available to players after the game ends, and to administrators during observation. The selected move stays centered in the scrollable history list while dragging the timeline, clamped at the beginning and end. During play, history is informational without replay links. Source, deployment templates and `install.sh` are maintained together in this public repository.
