import { ruleRegistry } from './rules/registry';
import type { RoomPersistence } from './persistence';
import { linksFor, playerLinksFor, parseMessage, viewFor } from "./protocol";
import { opposite } from './engine';
import type { ComputerInput } from './computer/engine';
import { difficulties } from './computer/config';
import type { ServerMessage } from "./protocol";
import type { ComputerConfig, GameCommand, GameState, LogEvent, Role, View } from "./types";

export interface Attachment { role?: Role; active: boolean; openedAt: number; admin?: boolean }
export interface RoomSocket {
  readyState: number;
  serializeAttachment(value: Attachment): void;
  deserializeAttachment(): Attachment | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export interface RoomContext {
  onStateChanged?(): void;
  persistence: RoomPersistence;
  setAlarm(at: number): Promise<void>;
  getWebSockets(): RoomSocket[];
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
export class RoomCore {
  readonly ready: Promise<void>;
  private state: GameState | undefined;
  private log: LogEvent[] = [];

  constructor(private ctx: RoomContext, private allowObserverToken = false) {
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.persistence.load();
      this.state = saved?.state;
      if (this.state && !this.state.claimed) this.state.claimed = { ...this.state.joined };
      this.log = saved?.events ?? [];
      if (this.state) ruleRegistry.resolve(this.state.ruleset);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/init" && request.method === "POST") {
      return this.ctx.blockConcurrencyWhile(async () => {
        if (this.state) return new Response("Room exists", { status: 409 });
        const { roomId, tokens, ruleset: input, computer } = await request.json() as { roomId: string; tokens: GameState["tokens"]; ruleset?: unknown; computer?: ComputerConfig };
        if (computer && (!['w', 'b'].includes(computer.color) || !difficulties.includes(computer.difficulty))) throw new Error('invalid_computer');
        const now = Date.now();
        const ruleset = ruleRegistry.selectionForCreation(input), position = ruleRegistry.resolve(ruleset).initialize(ruleset);
        const state: GameState = {
          ...position, revision: 0, ruleset, initialPosition: structuredClone({ pieces: position.pieces, board: position.board, turn: position.turn }),
          roomId, tokens, ...(computer ? { computer } : {}), createdAt: now, phase: "lobby", moves: [], drawOffer: null,
          joined: { w: false, b: false }, claimed: { w: false, b: false }, playStartedAt: null, lastMoveAt: null, result: null, crowns: { w: null, b: null }
        };
        if (computer) { state.joined[computer.color] = true; state.claimed = { w: true, b: true }; }
        await this.commit(state, [{ t: now, actor: "system", type: "room_created", data: { ruleset, ...(computer ? { computer } : {}) } }]);
        return Response.json({ roomId, ruleset, links: playerLinksFor(state), ...(computer ? { computer, role: opposite(computer.color), link: linksFor(state)[opposite(computer.color) === 'w' ? 'white' : 'black'] } : {}) });
      });
    }
    if (path === "/join" && request.method === "POST") {
      const payload = await request.json().catch(() => ({})) as { color?: "w" | "b" };
      return this.ctx.blockConcurrencyWhile(async () => {
        if (!this.state) return Response.json({ code: "room_not_found" }, { status: 404 });
        if (this.state.phase === "ended") return Response.json({ code: "room_ended" }, { status: 409 });
        if (this.state.phase === "playing") return Response.json({ code: "room_started" }, { status: 409 });
        const available = (["w", "b"] as const).filter(color => !this.state!.claimed[color] && !this.state!.joined[color]);
        if (available.length === 2 && !payload.color) return Response.json({ code: "choose_side" }, { status: 409 });
        const role = available.length === 2 ? payload.color : available[0];
        if (!role) return Response.json({ code: "room_full" }, { status: 409 });
        const next = structuredClone(this.state);
        next.claimed[role] = true;
        await this.commit(next, [{ t: Date.now(), actor: role, type: "seat_claimed", data: { via: "room_number" } }]);
        return Response.json({ roomId: next.roomId, role, link: linksFor(next)[role === "w" ? "white" : "black"] });
      });
    }
    if (!this.state) return new Response("Room not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    return new Response(null, { status: 204 });
  }

  async accept(ws: RoomSocket, admin = false) {
    ws.serializeAttachment({ active: true, openedAt: Date.now(), ...(admin ? { role: "observer", admin: true } : {}) });
    if (admin) { this.send(ws, { type: "welcome", role: "observer" }); this.broadcast(); }
    else await this.ctx.setAlarm(Math.min(...this.ctx.getWebSockets().filter(socket => !this.attachment(socket).role).map(socket => this.attachment(socket).openedAt + 15000), Date.now() + 15000));
  }
  pendingCount() { return this.ctx.getWebSockets().filter(ws => !this.attachment(ws).role).length; }
  async adminEnd() {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.state) return false;
      if (this.state.phase !== "ended") {
        const next = structuredClone(this.state); next.phase = "ended"; next.drawOffer = null; next.undoRequest = null;
        next.result = { winner: null, reason: "admin" };
        await this.commit(next, [{ t: Date.now(), actor: "admin", type: "game_ended", data: { winner: null, reason: "admin" } }]);
        this.broadcast();
      }
      return true;
    });
  }
  adminSnapshot() { return this.state ? { view: viewFor(this.state, "observer", this.connected()), events: this.log } : null; }

  computerTurn(): { revision: number; computer: ComputerConfig; phase: 'crown_select' | 'playing'; input: ComputerInput; drawOffer: GameState['drawOffer']; undoRequest: GameState['undoRequest'] } | undefined {
    const state = this.state, computer = state?.computer;
    if (!state || !computer || !this.connected()[opposite(computer.color)]) return;
    const selecting = state.phase === 'crown_select' && !state.crowns[computer.color];
    const playing = state.phase === 'playing' && (state.turn === computer.color || state.drawOffer === opposite(computer.color) || state.undoRequest?.color === opposite(computer.color));
    if (!selecting && !playing) return;
    // Explicit player-information projection. The worker cannot access RoomCore/state.
    const input: ComputerInput = structuredClone({ color: computer.color, difficulty: computer.difficulty,
      ruleset: state.ruleset, pieces: state.pieces, board: state.board, turn: state.turn,
      enPassant: state.enPassant, halfmoveClock: state.halfmoveClock, ownCrown: state.crowns[computer.color] });
    const rules = ruleRegistry.resolve(state.ruleset);
    if (rules.status) input.drawClaim = rules.status(state).drawClaim;
    if (rules.interrogationTargets) {
      input.interrogationTargets = rules.interrogationTargets(state, computer.color);
      input.interrogationKnowledge = Object.fromEntries(state.moves.filter(m => m.kind === 'interrogation' && m.color === computer.color).map(m => [m.targetId!, m.answer!]));
    }
    return { revision: state.revision, computer, phase: state.phase as 'crown_select' | 'playing', input, drawOffer: state.drawOffer, undoRequest: state.undoRequest };
  }
  async computerAction(command: GameCommand, revision: number) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const turn = this.computerTurn();
      if (!turn || turn.revision !== revision) return false;
      const result = ruleRegistry.resolve(this.state!.ruleset).applyCommand(this.state!, turn.computer.color, command, Date.now());
      if ('error' in result) return false;
      await this.commit(result.state, result.events); this.broadcast(); return true;
    });
  }

  private attachment(ws: RoomSocket): Attachment {
    return ws.deserializeAttachment() ?? { active: false, openedAt: 0 };
  }
  private send(ws: RoomSocket, message: ServerMessage) {
    try { ws.send(JSON.stringify(message)); } catch { /* Close handler reconciles presence. */ }
  }
  private error(ws: RoomSocket, code: string) { this.send(ws, { type: "error", code, message: code }); }
  private connected(): View["connected"] {
    const connected = { w: false, b: false };
    if (this.state?.computer) connected[this.state.computer.color] = true;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws);
      if (a.active && (a.role === "w" || a.role === "b") && ws.readyState === 1) connected[a.role] = true;
    }
    return connected;
  }
  private broadcast() {
    if (!this.state) return;
    const connected = this.connected(), now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws);
      if (a.active && a.role) this.send(ws, { type: "state", view: viewFor(this.state, a.role, connected, now) });
    }
  }
  private async commit(state: GameState, events: LogEvent[]) {
    const expectedRevision = this.state?.revision ?? 0;
    const next = { ...state, revision: expectedRevision + 1 };
    await this.ctx.persistence.commit(next, events, expectedRevision);
    this.state = next; this.log.push(...events);
    this.ctx.onStateChanged?.();
  }

  async webSocketMessage(ws: RoomSocket, raw: string | ArrayBuffer) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const a = this.attachment(ws);
      if (!a.active) return;
      const m = parseMessage(raw);
      if (!m) { this.error(ws, "bad_message"); if (!a.role) ws.close(4001, "hello_required"); return; }
      const state = this.state!;
      if (!a.role) {
        if (m.type !== "hello") { this.error(ws, "hello_required"); ws.close(4001, "hello_required"); return; }
        const role = (["w", "b", ...(this.allowObserverToken ? ["observer"] : [])] as Role[]).find(role => state.tokens[role] === m.token);
        if (!role || role === state.computer?.color) { this.error(ws, "bad_token"); ws.close(4001, "bad_token"); return; }
        const joinEvents: LogEvent[] = [];
        const replaced: { socket: RoomSocket; attachment: Attachment }[] = [];
        for (const old of this.ctx.getWebSockets()) {
          const oldA = this.attachment(old);
          if (old !== ws && oldA.active && oldA.role === role && !oldA.admin) {
            joinEvents.push({ t: Date.now(), actor: role, type: "left", data: { code: 4000, replaced: true } });
            replaced.push({ socket: old, attachment: oldA });
          }
        }
        const next = structuredClone(state);
        if (role !== "observer") { next.joined[role] = true; next.claimed[role] = true; }
        ruleRegistry.resolve(next.ruleset).onPlayersJoined(next, Date.now());
        if (state.phase !== 'playing' && next.phase === 'playing') joinEvents.push({ t: Date.now(), actor: 'system', type: 'play_started' });
        await this.commit(next, [...joinEvents, { t: Date.now(), actor: role, type: "joined" }]);
        for (const old of replaced) { old.socket.serializeAttachment({ ...old.attachment, active: false }); old.socket.close(4000, 'replaced'); }
        ws.serializeAttachment({ ...a, role });
        this.send(ws, { type: "welcome", role }); this.broadcast(); this.ctx.onStateChanged?.(); return;
      }
      const role = a.role;
      if (m.type === "hello") { this.error(ws, "already_authenticated"); return; }
      if (m.type === "ping") { this.send(ws, { type: "pong" }); return; }
      if (m.type === "get_log" || m.type === "get_links") {
        if (role !== "observer") { this.error(ws, "observer_only"); return; }
        if (m.type === "get_log") this.send(ws, { type: "log", events: this.log, moves: state.moves, crowns: state.crowns });
        else this.send(ws, { type: "links", links: state.computer ? playerLinksFor(state) : linksFor(state) });
        return;
      }
      if (role === "observer") { this.error(ws, "player_only"); return; }
      if (state.computer && (m.type === 'offer_draw' || m.type === 'respond_draw')) {
        this.error(ws, 'computer_draw_offer_disabled'); return;
      }
      const transition = ruleRegistry.resolve(state.ruleset).applyCommand(state, role, m, Date.now());
      if ('error' in transition) { this.error(ws, transition.error); return; }
      await this.commit(transition.state, transition.events); this.broadcast();
    });
  }

  async webSocketClose(ws: RoomSocket, code: number, reason: string, wasClean: boolean) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const a = this.attachment(ws);
      ws.serializeAttachment({ ...a, active: false });
      if (a.role && a.active && !a.admin && this.state) {
        await this.commit(this.state, [{ t: Date.now(), actor: a.role, type: "left", data: { code, wasClean } }]);
        this.broadcast();
      }
      try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed"); } catch { /* Already closed. */ }
    });
  }
  async webSocketError(ws: RoomSocket) { await this.webSocketClose(ws, 1011, "socket_error", false); }
  async alarm() {
    let pending = false;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws);
      if (a.active && !a.role) {
        if (Date.now() - a.openedAt >= 15000) { ws.serializeAttachment({ ...a, active: false }); ws.close(4001, "hello_timeout"); }
        else pending = true;
      }
    }
    if (pending) await this.ctx.setAlarm(Date.now() + 15000);
  }
}
