# Hidden Crown — Chess Mod Build Spec

Oct 3, 2026 · @Fei Mo

## 0. Brief for the implementing AI

Build a two-player online chess variant called **Hidden Crown**, deployable to Cloudflare in one command. Follow this spec exactly; where it is silent, choose the simplest option and list the choice in `DECISIONS.md`.

**What it is for.** A class assignment (UCI GDIM 41 / ICS 60, Unit 1: Modding Chess). The game changes exactly one aspect of chess, **Uncertainty**. Two testers play remotely on their own devices while the researcher (the user) watches from an observer view and records the session.

**Hard constraints.**

- Only uncertainty changes. No clocks, no extra mechanics, no hints, no AI opponent.
- The server is authoritative: clients never validate moves alone, and a player's client never receives the opponent's crown.
- No external chess library. chess.js only exposes fully legal moves (it filters out moves that expose the king), which breaks this variant. Write a small pseudo-legal engine (Section 4).
- No frontend framework or build step. Plain HTML, CSS and ES modules served as static assets.
- Must run on the Cloudflare Workers **Free** plan.

**Deliverables.**

1. A repo matching the file tree in Section 2.
2. Unit tests for the engine (Section 7) that pass with `npm test`.
3. `README.md` with local run and deploy steps (Section 8).
4. `DECISIONS.md` listing any choice not fixed by this spec.

**Definition of done.** Every acceptance test in Section 7 passes, and two browsers on different networks can create a room, pick crowns, play to a crown capture, and see the reveal screen, while a third browser in observer mode sees both crowns live and can export the log.

## 1. Game design: final rules

Each player secretly crowns one of their eight non-pawn pieces; capturing the enemy crown wins. Everything else is standard chess, minus the rules that depend on check.

### Rules

1. **Setup.** Standard starting position. White moves first.
2. **Crown selection.** Before move 1, each player secretly picks one piece from: king, queen, both rooks, both bishops, both knights (8 options). Selection is simultaneous; play starts when both have locked in. The crown cannot change for the rest of the game.
3. **Movement.** All pieces move as in standard chess (FIDE movement rules), including castling, en passant and promotion, with the changes in rule 4.
4. **No check.** Check and checkmate do not exist. Any piece, including the king, may move onto or stay on an attacked square.
5. **Castling.** Allowed when the king and that rook have never moved and every square between them is empty. Squares the king passes through may be attacked.
6. **Promotion.** A pawn on the last rank promotes to queen, rook, bishop or knight (player chooses). A promoted piece is never a crown.
7. **Win.** Capturing the opponent's crown ends the game immediately; the capturer wins. Capturing any other piece only removes it. Neither side is told it was not the crown; the game simply continues.
8. **Draw.** The game is drawn if the side to move has no pseudo-legal moves, if both players agree to a draw, or if 100 consecutive plies pass with no capture and no pawn move.
9. **Resign.** Either player may resign once play has started (after both crowns are locked).
10. **Reveal.** When the game ends, both crowns are shown to both players.

### Why each decision

| Decision | Choice | Reason |
| --- | --- | --- |
| Crown candidates | 8 non-pawn pieces | 8 equal options gives 3 bits of hidden information. Pawns would add 8 weak, look-alike options and promotion edge cases. |
| Old king stays | Yes, as an ordinary piece that may be crowned | Players protect it by habit, which creates natural bluffs and misreads. |
| Win condition | Capture the crown, not checkmate | Forced by hiding the crown: if the server rejected a move for exposing the king, that rejection would leak which piece is the crown. |
| Crown fixed | Cannot switch mid-game | Keeps the uncertainty about reading behavior over time, not random reshuffling. |
| No "not the crown" message | Silence on decoy capture | The continuing game already tells the capturer; an explicit message adds nothing and stays out of the way. |
| No clock | None | Time is a separate aspect; changing it would make it two mods and muddy the test. |
| No extra mechanics | No guessing, scouting or reveal powers | One variable changed, so tester behavior can be attributed to hidden information. |

### Why this is still one modification

The modified aspect is **Uncertainty**: chess goes from perfect information to one hidden fact per side. Removing check, winning by capture, and the castling change are not a second modification. They are the minimum adjustments that keep the crown hidden, because check rules would force the game to reveal which piece is the crown. The report's Modification & Rationale section must say this explicitly, so the grader reads them as consequences of the Uncertainty change, not as Rules changes.

### Expected dynamics (to watch for in testing)

- Players reading opponent protection patterns to infer the crown (yomi).
- Deliberate bluffing: guarding a decoy, leaving the real crown exposed.
- Hesitation before trading pieces, since any trade might lose or win the game.
- Early aggression to test reactions, or very defensive play everywhere.

## 2. Tech stack and architecture

One Cloudflare Worker serves the static frontend and routes each game room to its own SQLite-backed Durable Object, which holds the authoritative state and the WebSocket connections.

| Layer | Choice |
| --- | --- |
| Runtime | Cloudflare Workers (Free plan), TypeScript |
| Room state | One Durable Object per room, SQLite-backed (`new_sqlite_classes` migration; the only kind the Free plan allows) |
| Realtime | WebSocket Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`, `webSocketClose`), so idle rooms cost nothing |
| Frontend | Static `public/` folder served through Workers static assets; plain HTML/CSS/ES modules, no build step |
| Tests | Vitest, engine only (`npm test`) |
| Deploy | `npx wrangler deploy` |

**Request routing in `src/worker.ts`:**

- `POST /api/rooms` creates a room and returns its id plus three tokens (white, black, observer).
- `GET /ws/:roomId` upgrades to a WebSocket and forwards to the room's Durable Object (`env.ROOM.idFromName(roomId)`).
- Everything else falls through to static assets (`index.html` handles all screens via query string).

**The client has no chess engine.** The server sends the side to move its list of pseudo-legal moves; the client only highlights them. One engine, one source of truth.

### File tree

```
hidden-crown/
  package.json          # scripts: dev, deploy, test
  wrangler.jsonc
  tsconfig.json
  README.md
  DECISIONS.md
  src/
    worker.ts           # router
    room.ts             # Durable Object class Room
    engine.ts           # pseudo-legal move engine (pure functions)
    types.ts            # shared types
    protocol.ts         # message type definitions + validation
  public/
    index.html
    styles.css
    js/
      app.js            # screen routing, WebSocket client
      board.js          # board rendering + click-to-move
      i18n.js           # en / zh strings
  test/
    engine.test.ts
```

### `wrangler.jsonc` (essentials)

```json
{
  "name": "hidden-crown",
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "./public" },
  "durable_objects": {
    "bindings": [{ "name": "ROOM", "class_name": "Room" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }]
}
```

Verify field names against the current Wrangler configuration docs before deploying.

## 3. Data model

Every piece has a permanent id, so a crown stays attached to the same physical piece as it moves, castles or survives trades. State lives in Durable Object storage under one key (`state`) plus an append-only event log (`log`), and is reloaded on every wake from hibernation.

### Piece ids

Format: color + type + starting file. Ids never change, including after promotion.

- White: `wK`, `wQ`, `wRa`, `wRh`, `wBc`, `wBf`, `wNb`, `wNg`, pawns `wPa` … `wPh`
- Black: same with `b` prefix
- Crown candidates: the 8 non-pawn ids of each color

### Types (`src/types.ts`)

```ts
type Color = "w" | "b";
type PieceType = "K" | "Q" | "R" | "B" | "N" | "P";
type Square = number;            // 0 = a1, 7 = h1, 56 = a8, 63 = h8

interface Piece {
  id: string;
  color: Color;
  type: PieceType;               // changes on promotion
  square: Square | null;         // null = captured
  hasMoved: boolean;             // for castling
  promoted: boolean;
}

interface MoveRecord {
  ply: number;
  color: Color;
  pieceId: string;
  from: Square;
  to: Square;
  captured?: string;             // captured piece id
  promotion?: "Q" | "R" | "B" | "N";
  castle?: "K" | "Q";
  enPassant?: boolean;
  notation: string;              // long algebraic, e.g. "Ng1-f3", "Qd1xh5", "O-O"
  at: number;                    // epoch ms (server clock) when the move was applied
  thinkMs: number;               // ms since previous move (or since play began)
}

type Phase = "lobby" | "crown_select" | "playing" | "ended";

interface GameState {
  roomId: string;
  createdAt: number;
  phase: Phase;
  pieces: Record<string, Piece>;
  board: (string | null)[];      // 64 entries, piece id or null
  turn: Color;
  ply: number;
  halfmoveClock: number;         // plies since last capture or pawn move
  enPassant: Square | null;      // target square, set after a double pawn push
  moves: MoveRecord[];
  drawOffer: Color | null;
  joined: { w: boolean; b: boolean }; // set true on first valid hello; persisted
  playStartedAt: number | null;  // set when both crowns are locked
  lastMoveAt: number | null;
  result: null | {
    winner: Color | null;
    reason: "crown_captured" | "resign" | "no_moves" | "agreement" | "100_ply";
  };
  // SERVER-ONLY: never sent to a player
  crowns: { w: string | null; b: string | null };
  tokens: { w: string; b: string; observer: string };
}
```

### Event log

Append one entry for every meaningful event; it is the research record the user exports after the test.

```ts
interface LogEvent {
  t: number;                     // epoch ms, server clock
  actor: Color | "observer" | "system";
  type: "room_created" | "joined" | "left" | "crown_locked" | "play_started"
      | "move" | "draw_offered" | "draw_declined" | "draw_accepted"
      | "resign" | "game_ended";
  data?: Record<string, unknown>; // e.g. { pieceId } for crown_locked; MoveRecord for move
}
```

### Redaction

A player's view of the state removes `tokens` and the opponent's crown. The observer view removes only `tokens`. Build both through one function, `viewFor(state, role)`, and send nothing that bypasses it.

Piece ids are public and appear in the board, piece list and move history; that is fine. What must never reach a player before the game ends is *which* id the opponent crowned: no `crowns` field, no `crown_locked` event data, no log, and no error text or behavior that depends on the opponent's crown (for example, never reject or treat a move differently because of it). The end-of-game reveal is the only exception.

## 4. Move engine (`src/engine.ts`)

The engine generates **pseudo-legal** moves: every move a piece can physically make, with no check filtering at all. All functions are pure (input state in, new state out) so they can be unit tested without Workers.

### API

```ts
interface Move {
  pieceId: string;
  from: Square;
  to: Square;
  promotion?: "Q" | "R" | "B" | "N";
  castle?: "K" | "Q";
  enPassant?: boolean;
}

function initialPosition(): Pick<GameState, "pieces" | "board" | "turn" | "ply" | "halfmoveClock" | "enPassant">;
function pseudoLegalMoves(state: GameState, color: Color): Move[];
function applyMove(state: GameState, move: Move, now: number): { state: GameState; record: MoveRecord };
function checkEnd(state: GameState, record: MoveRecord): GameState["result"];
```

`applyMove` must throw unless `move` deep-equals an entry of `pseudoLegalMoves(state, state.turn)`. The server never trusts the client's move shape beyond `{from, to, promotion}`; it looks the full move up in the generated list.

### Movement per piece

| Piece | Moves |
| --- | --- |
| Knight | 8 L-shaped offsets; reject any that wraps around the board edge (check file distance is 1 or 2). |
| Bishop | Slide diagonally until the edge, an own piece (stop before) or an enemy piece (capture, stop). |
| Rook | Same, orthogonally. |
| Queen | Bishop + rook. |
| King | 1 square in any of 8 directions, plus castling. The king is an ordinary capturable piece. |
| Pawn | 1 forward if empty; 2 forward from its start rank if both squares empty; diagonal forward capture of an enemy piece; en passant onto `state.enPassant`. Reaching the last rank generates 4 moves, one per promotion type. |

### Castling

Generate `O-O` when all are true: piece `wK` (or `bK`) is on e1 (e8) with `hasMoved = false`; piece `wRh` (`bRh`) is on h1 (h8) with `hasMoved = false`; f1 and g1 (f8, g8) are empty. King goes to g1, rook to f1. `O-O-O` is the same with `wRa` on a1, b1, c1 and d1 empty, king to c1, rook to d1. **Never check whether squares are attacked.** If the original king or rook was captured, that castle is impossible.

### After every move

1. Move the piece; if the destination held an enemy piece, set its `square = null` and record it as `captured`. For en passant, the captured pawn is on the square behind the destination.
2. Set `hasMoved = true` on the moved piece (and the rook when castling).
3. On promotion, change `type` and set `promoted = true`; the id stays.
4. Set `enPassant` to the skipped square after a double pawn push, otherwise `null`.
5. Reset `halfmoveClock` to 0 on any capture or pawn move, otherwise add 1.
6. Increment `ply`, flip `turn`, set `lastMoveAt = now` and record.at = now, compute `thinkMs = now - (lastMoveAt or play start)`.
7. Clear any pending draw offer.

### End detection (`checkEnd`), in this order

1. `record.captured` equals the opponent's crown id: winner = mover, reason `crown_captured`.
2. `halfmoveClock >= 100`: draw, reason `100_ply`.
3. `pseudoLegalMoves(state, state.turn)` is empty: draw, reason `no_moves`.

Resign and draw by agreement are handled in the room, not the engine.

### Notation

Long algebraic: piece letter (none for pawns), from, `-` or `x`, to; suffix `=Q` on promotion and `  e.p. ` on en passant; castles as `O-O` and `O-O-O`. Never append `+` or `#`.

## 5. Room lifecycle and WebSocket protocol

The researcher creates a room and gets three private links; each link carries a token that fixes its holder's role. After every state change the room sends each socket its own redacted view.

### Creating a room

1. `POST /api/rooms` (no body). The Worker makes an 8-character room id (letters and digits, no look-alikes such as 0/O, 1/l) and three tokens via `crypto.randomUUID()`.
2. The Worker calls the room's Durable Object to initialise it with those tokens (phase `lobby`) and logs `room_created`.
3. Response:

```json
{
  "roomId": "K7M2QX9P",
  "links": {
    "white": "/?room=K7M2QX9P#t=<whiteToken>",
    "black": "/?room=K7M2QX9P#t=<blackToken>",
    "observer": "/?room=K7M2QX9P#t=<observerToken>"
  }
}
```

Tokens sit in the URL fragment so they are never sent in HTTP requests or server logs; the client reads them from `location.hash` and stores them in `localStorage` keyed by room id for reconnects.

### Phases

| From | To | Trigger |
| --- | --- | --- |
| `lobby` | `crown_select` | joined.w and joined.b are both true (each set on that color's first valid hello and persisted) |
| `crown_select` | `playing` | Both crowns locked; log `play_started`, start the think timer |
| `playing` | `ended` | Crown captured, resignation, draw by agreement, 100-ply rule or no moves |

### Connection

Client opens `wss://<host>/ws/<roomId>`. Its first message must be `hello`; the room matches the token to a role, stores it with `serializeAttachment({ role })`, and replies `welcome`. A wrong token closes the socket with code 4001. A second socket for the same role replaces the first (close the old one with 4000). Live online status is never stored: compute it each time a view is built from ctx.getWebSockets() and each socket's role attachment, so it stays correct after hibernation. On socket close, rebroadcast views; the game never pauses.

### Client to server

| type | fields | allowed for | rule |
| --- | --- | --- | --- |
| `hello` | `token` | all | first message only |
| `select_crown` | `pieceId` | white, black | phase `crown_select`; own non-pawn piece; final once sent |
| `move` | `from`, `to`, `promotion?` | side to move | phase `playing`; must match a generated move |
| `offer_draw` | none | white, black | phase `playing`; one open offer at a time |
| `respond_draw` | `accept` | the other player | only while an offer is open |
| `resign` | none | white, black | phase `playing` |
| `get_log` | none | observer | any phase |
| `ping` | none | all | reply `pong`; client sends every 25 s |

### Server to client

| type | fields |
| --- | --- |
| `welcome` | `role` |
| `state` | `view` (below) |
| `log` | `events`, `moves`, `crowns` |
| `error` | `code`, `message` (illegal move, wrong phase, not your turn, bad token) |
| `pong` | none |

### The `view` object

```ts
interface View {
  role: Color | "observer";
  phase: Phase;
  pieces: Record<string, Piece>;
  board: (string | null)[];
  turn: Color;
  moves: MoveRecord[];
  connected: { w: boolean; b: boolean };     // live, computed from open sockets
  playStartedAt: number | null;
  lastMoveAt: number | null;
  serverNow: number;                         // server clock when this view was built
  crownLocked: { w: boolean; b: boolean };
  drawOffer: Color | null;
  result: GameState["result"];
  yourCrown?: string;                        // players: own crown only
  crowns?: { w: string | null; b: string | null }; // observer always; players only when phase is "ended"
  legalMoves?: Move[];                       // only to the side to move, only while playing
}
```

An invalid message gets an `error` reply and changes nothing. Every accepted message persists the state before broadcasting.

**Observer-only link retrieval.** Add client message `get_links` (observer only, any phase) and server reply `links` with `{ white, black, observer }` relative URLs built from the stored tokens. A player sending `get_links` gets an `error`. The observer view's Copy player links button uses this, so it works from any device that opens the observer link.

## 6. Frontend

One page, `public/index.html`, shows the right screen from the URL and the latest `view`. Clean, calm and readable on a laptop or phone; nothing on screen may hint at the opponent's crown.

### Screens

| Screen | When | Contents |
| --- | --- | --- |
| Home | No `room` in URL | Title, two-line description, "Create room" button. After creating: the three links with Copy buttons, white/black labelled "send to tester", observer labelled "keep for yourself". |
| Lobby | Player, phase `lobby` | "Waiting for your opponent", your color, the rules panel. |
| Crown select | Phase `crown_select` | Board in starting position. Own 8 candidate pieces are clickable; click one to preview, then "Lock in crown" with a confirm dialog ("This cannot be changed"). After locking: "Waiting for opponent to choose." |
| Play | Phase `playing` | Board, status line, captured-piece trays, move list, Offer draw, Resign, rules panel. |
| End | Phase `ended` | Result banner (e.g. "White wins: captured Black's crown, the bishop on f8"), both crowns marked on the board or in the captured trays, full move list. |
| Observer | Observer token, any phase | See below. |

### Board interaction

- 8x8 grid of `<button>` squares with file and rank labels; flipped for black.
- Pieces drawn with Unicode chess symbols followed by U+FE0E (text presentation, so phones do not render emoji). Font stack: `"Segoe UI Symbol", "Noto Sans Symbols 2", "DejaVu Sans", serif`.
- Click own piece: highlight its targets from `legalMoves` (dot for quiet moves, ring for captures). Click a target to send `move`; click elsewhere to cancel.
- When several moves share `from` and `to` (promotion), show a 4-button picker.
- Highlight the last move's two squares.
- Your crown carries a small gold crown badge visible only to you. No other piece is marked.
- Disable all input when it is not your turn and show "Opponent is thinking…".
- Draw offers appear as an inline Accept / Decline bar; Resign asks for confirmation.
- Show a disconnected banner and reconnect automatically with backoff (1, 2, 4, 8 s, then every 10 s), resending `hello` with the stored token.

### Rules panel

Collapsible, open by default during crown select. Five short lines: pick one secret crown; capture the enemy crown to win; no check or checkmate, the king is an ordinary piece unless crowned; castling and en passant work as usual but ignore attacks; draw by no moves, agreement or 100 plies without capture or pawn move.

### Language

An EN / 中文 toggle in the header, stored in `localStorage`. All UI strings live in `public/js/i18n.js`; the protocol and logs stay in English.

### Observer view

- A red banner across the top: "Observer view shows both crowns. Do not share this screen."
- Board from white's side with both crowns badged in each side's color.
- Live status: phase, whose turn, both connection dots, time the current player has been thinking (now minus lastMoveAt, or minus playStartedAt before the first move, using serverNow to correct the local clock).
- Move table: ply, color, notation, captured piece, think time in seconds.
- Buttons: Copy player links; Export JSON (full `log` reply); Export CSV of moves with columns `ply,color,notation,piece_id,captured_id,think_ms,timestamp_iso`. timestamp\_iso is MoveRecord.at as ISO 8601 UTC. Downloads use a Blob and a temporary `<a download>` link.

### Style

Neutral palette, light and dark mode via `prefers-color-scheme`, board `width: min(92vw, 560px)`, squares in two muted tones, system font for text. No animations beyond a 120 ms piece move.

## 7. Tests and acceptance criteria

Engine tests run automatically with `npm test`; room and UI behavior is checked by hand in two browsers plus an observer. Add a test helper `setup(pieces: Record<string, string>, turn)` that places pieces by id on named squares (for example `{ wK: "e1", wRh: "h1", bQ: "d8" }`).

### Engine unit tests (`test/engine.test.ts`)

1. Starting position: white has exactly 20 moves.
2. A king may move onto an attacked square (move is generated).
3. Castling is generated when the king's path is attacked, and not generated when a square between is occupied, the king has moved, or the rook has moved or been captured.
4. En passant is generated only on the ply right after the double push.
5. A pawn reaching the last rank generates 4 moves; after applying one, the id is unchanged, `type` changed and `promoted = true`.
6. A knight on h4 generates no moves onto the a or b files.
7. Capturing a non-crown piece, including the original king, leaves `result` null.
8. Capturing the crown sets `result = { winner: mover, reason: "crown_captured" }`.
9. `halfmoveClock` reaching 100 gives a `100_ply` draw; a capture or pawn move resets it.
10. No-moves draw: white bishop c1, white pawns b2 and d2, black pawns b3 and d3, nothing else white; with white to move, result is `no_moves`.
11. `applyMove` throws on a move not in the generated list and on a move by the wrong color.
12. Notation: `O-O`, `Qd1xh5`, `e7-e8=Q`, `e5xd6 e.p.`; never contains `+` or `#`.

### Manual acceptance checklist

- [ ] Create a room; three links appear and each opens the right role.
- [ ] With devtools open on the white client, no WebSocket frame reveals which piece black crowned before the game ends: no crowns field, no crown\_locked data, no error text that depends on it; piece ids themselves are expected everywhere, and the end-of-game reveal is the only exception (search frames for `crowns`).
- [ ] `select_crown` with a pawn, an opponent piece, or a second time is rejected with an `error`.
- [ ] Play starts only after both crowns are locked.
- [ ] Clicking a piece shows only its legal targets; a move appears on both boards in under 1 s.
- [ ] Closing and reopening a player tab reconnects to the same color and position.
- [ ] Draw offer, decline, accept, and resign all work and end the game correctly.
- [ ] Capturing the crown ends the game; both players see the reveal.
- [ ] Observer sees both crowns from the start and live think time.
- [ ] Observer JSON and CSV exports download and match the moves played.
- [ ] Board and buttons are usable on a phone in portrait.
- [ ] EN / 中文 toggle changes every visible string.

## 8. Deployment and user-test protocol

Deploy with Wrangler to a Cloudflare-hosted URL, then run one recorded remote session per tester pair using the script below. The protocol is for the researcher, not the implementing AI.

### Deploy

1. Node.js 20 or later; `npm install`.
2. `npx wrangler login` (Cloudflare account, Free plan is enough).
3. `npx wrangler dev`, then test locally with two normal windows and one private window.
4. `npx wrangler deploy` prints a `*.workers.dev` URL.
5. If any tester is in mainland China, `workers.dev` addresses can be unreliable there; attach a custom domain you already have on Cloudflare (e.g. a subdomain such as `chess.<your-domain>`) through the Worker's Custom Domains setting, and test that link from the tester's network before the session.

### Before the session

- Recruit at least one pair (two pairs if time allows) who know how chess pieces move. Neither tester can be you.
- Send each tester only their own link. Keep the observer link to yourself and **never share your screen**.
- Start a Zoom or Discord call with cameras on and start recording. Read aloud: "This is for a class assignment, not publication. I'm recording audio and video. You can stop at any time." Get a spoken yes from each tester on the recording.
- Ask two warm-up questions on the recording: how often they play chess, and their rough skill level.
- Ask them to think aloud: "Please say what you're thinking as you play, especially when you're guessing about your opponent."

### During play

- Let them read the rules panel; answer rule questions only, never strategy.
- Stay silent otherwise. In your notes record time, what happened, and exact words. Watch for: guarding a decoy, hesitating before a trade, sudden aggression to probe, comments guessing the crown, surprise at the reveal.
- Take a screenshot showing both testers on camera with the board in progress, and keep a 30–60 s clip from the recording as the test artifact.

### Debrief (right after, still recording)

1. Which piece did you crown, and why?
2. When did you think you knew your opponent's crown? What gave it away?
3. Did you try to mislead your opponent? How?
4. How did this feel compared with normal chess?
5. On a scale of 1 to 5, how tense did you feel compared with normal chess? Why that number?
6. What, if anything, felt frustrating or unfair?

### After

- Export JSON and CSV from the observer view.
- Transcribe the recording and pull verbatim quotes with timestamps; translate any Chinese quotes and note the translation in the report.
- Match quotes to moves in the CSV, for example think time on the move before a trade or right after a capture.
