# Hidden Crown

Two-player online chess with one secret crown per side. Capture the opposing crown to win. There is no check or checkmate. The browser only highlights server-supplied moves.

The production server now supports self-hosted **Docker + Nginx**, using Node.js 24, SQLite and WebSockets. It shares the same pure chess engine and room core with the retained Cloudflare adapter. See [DEPLOYMENT.md](DEPLOYMENT.md) for deployment, resource limits, admin credentials and GHCR publishing.

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

The home page displays only White and Black private links, with matching Copy/Open button styles. Creation responses omit observer links. Public observer-token authentication is disabled; only an authenticated administrator can open the live god view. The administrator can see both crowns, move times, player presence, JSON/CSV exports, and all rooms with pagination. End-game preserves the record and reveals crowns; Delete removes the room and logs after an explicit UI confirmation.

The seven-ply smoke game: White crowns `wK`, Black crowns `bBf`; play `e2-e4`, `g7-g5`, `Qd1-h5`, `a7-a6`, `Qh5xf7`, `a6-a5`, `Qf7xf8`. The normal pawn capture continues play, while capture of the crowned bishop wins.

## Validation

```powershell
npm test
npm run typecheck
npm run build
npm run test:selfhost
```

`test:selfhost` starts isolated local servers and checks actual HTTP/WebSocket behavior, administrator authentication/authorization, CSRF, live god views, force-end, deletion, restart persistence and resource-limit rejection. It writes only ignored test fixtures. It needs ports 8791–8793 available.

For the longer room and join suites against a running self-hosted server, explicitly provide the test administrator credentials:

```powershell
$env:HIDDEN_CROWN_URL = 'http://127.0.0.1:8787'
$env:HIDDEN_CROWN_ADMIN_USERNAME = 'admin'
$env:HIDDEN_CROWN_ADMIN_PASSWORD = '<your local test password>'
npm run test:room
node scripts/join-smoke.mjs
```

These checks create test rooms. When running several suites from one IP, use a disposable server with appropriately raised creation limits. `scripts/persistence-smoke.mjs prepare`, a server restart, then `verify` provides an additional stored-state check; `test:selfhost` also performs a complete restart check itself.

CI repeats tests on native Linux AMD64 and ARM64 and validates the Docker runtime plus Nginx syntax. Tag releases publish a multi-platform GHCR image. The private repository is `KKazuhaK/hidden-crown`; private GHCR pulls require login with `read:packages` access. The image address becomes available after the first successful tag release.

See [VALIDATION.md](VALIDATION.md) for completed checks and remaining external validation. Automated games do not substitute for the recorded research session in `BUILD_SPEC.md`.

## Project layout

- `src/engine.ts`: pure chess movement/application/end detection.
- `src/room-core.ts`: shared room rules, role views, persistence and message handling.
- `server/`: self-hosted HTTP/WebSocket runtime, SQLite and bounded rate limiting.
- `public/`: vanilla JS board/game UI and administrator dashboard.
- `Dockerfile`, `docker-compose.yml`, `deploy/`: container and Nginx deployment.
- `.github/workflows/`: native architecture verification and GHCR releases.
- `src/room.ts`, `src/worker.ts`, `wrangler.jsonc`: retained Cloudflare adapter, without the self-hosted global admin/admission layer.
