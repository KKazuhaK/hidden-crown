import { applyMove, initialPosition, opposite, pseudoLegalMoves } from "./engine";
import { linksFor, parseMessage, viewFor } from "./protocol";
import type { ServerMessage } from "./protocol";
import type { GameState, LogEvent, Role, View } from "./types";

export interface Attachment { role?: Role; active: boolean; openedAt: number; admin?: boolean }
export interface RoomSocket {
  readyState: number;
  serializeAttachment(value: Attachment): void;
  deserializeAttachment(): Attachment | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export interface RoomContext {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    transaction<T>(callback: (txn: { put(values: Record<string, unknown>): Promise<void> }) => Promise<T>): Promise<T>;
    setAlarm(at: number): Promise<void>;
  };
  getWebSockets(): RoomSocket[];
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
export class RoomCore {
  private state: GameState | undefined;
  private log: LogEvent[] = [];

  constructor(private ctx: RoomContext, private allowObserverToken = false) {
    ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get<GameState>("state");
      if (this.state && !this.state.claimed) this.state.claimed = { ...this.state.joined };
      this.log = await ctx.storage.get<LogEvent[]>("log") ?? [];
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/init" && request.method === "POST") {
      return this.ctx.blockConcurrencyWhile(async () => {
        if (this.state) return new Response("Room exists", { status: 409 });
        const { roomId, tokens } = await request.json() as { roomId: string; tokens: GameState["tokens"] };
        const now = Date.now();
        const state: GameState = {
          ...initialPosition(), roomId, tokens, createdAt: now, phase: "lobby", moves: [], drawOffer: null,
          joined: { w: false, b: false }, claimed: { w: false, b: false }, playStartedAt: null, lastMoveAt: null, result: null, crowns: { w: null, b: null }
        };
        await this.commit(state, [{ t: now, actor: "system", type: "room_created" }]);
        const links = linksFor(state);
        return Response.json({ roomId, links: { white: links.white, black: links.black } });
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
    else await this.ctx.storage.setAlarm(Math.min(...this.ctx.getWebSockets().filter(socket => !this.attachment(socket).role).map(socket => this.attachment(socket).openedAt + 15000), Date.now() + 15000));
  }
  pendingCount() { return this.ctx.getWebSockets().filter(ws => !this.attachment(ws).role).length; }
  async adminEnd() {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.state) return false;
      if (this.state.phase !== "ended") {
        const next = structuredClone(this.state); next.phase = "ended"; next.drawOffer = null;
        next.result = { winner: null, reason: "admin" };
        await this.commit(next, [{ t: Date.now(), actor: "admin", type: "game_ended", data: { winner: null, reason: "admin" } }]);
        this.broadcast();
      }
      return true;
    });
  }
  adminSnapshot() { return this.state ? { view: viewFor(this.state, "observer", this.connected()), events: this.log } : null; }

  private attachment(ws: RoomSocket): Attachment {
    return ws.deserializeAttachment() ?? { active: false, openedAt: 0 };
  }
  private send(ws: RoomSocket, message: ServerMessage) {
    try { ws.send(JSON.stringify(message)); } catch { /* Close handler reconciles presence. */ }
  }
  private error(ws: RoomSocket, code: string) { this.send(ws, { type: "error", code, message: code }); }
  private connected(): View["connected"] {
    const connected = { w: false, b: false };
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
    const log = [...this.log, ...events];
    await this.ctx.storage.transaction(async txn => { await txn.put({ state, log }); });
    this.state = state; this.log = log;
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
        if (!role) { this.error(ws, "bad_token"); ws.close(4001, "bad_token"); return; }
        const joinEvents: LogEvent[] = [];
        for (const old of this.ctx.getWebSockets()) {
          const oldA = this.attachment(old);
          if (old !== ws && oldA.active && oldA.role === role && !oldA.admin) {
            joinEvents.push({ t: Date.now(), actor: role, type: "left", data: { code: 4000, replaced: true } });
            old.serializeAttachment({ ...oldA, active: false }); old.close(4000, "replaced");
          }
        }
        ws.serializeAttachment({ ...a, role });
        const next = structuredClone(state);
        if (role !== "observer") { next.joined[role] = true; next.claimed[role] = true; }
        if (next.phase === "lobby" && next.joined.w && next.joined.b) next.phase = "crown_select";
        await this.commit(next, [...joinEvents, { t: Date.now(), actor: role, type: "joined" }]);
        this.send(ws, { type: "welcome", role }); this.broadcast(); return;
      }
      const role = a.role;
      if (m.type === "hello") { this.error(ws, "already_authenticated"); return; }
      if (m.type === "ping") { this.send(ws, { type: "pong" }); return; }
      if (m.type === "get_log" || m.type === "get_links") {
        if (role !== "observer") { this.error(ws, "observer_only"); return; }
        if (m.type === "get_log") this.send(ws, { type: "log", events: this.log, moves: state.moves, crowns: state.crowns });
        else this.send(ws, { type: "links", links: linksFor(state) });
        return;
      }
      if (role === "observer") { this.error(ws, "player_only"); return; }
      const now = Date.now(), events: LogEvent[] = [];
      let next = structuredClone(state);
      const event = (type: LogEvent["type"], data?: Record<string, unknown>) => events.push({ t: now, actor: role, type, ...(data ? { data } : {}) });
      if (m.type === "select_crown") {
        if (state.phase !== "crown_select") { this.error(ws, "wrong_phase"); return; }
        const piece = state.pieces[m.pieceId];
        if (state.crowns[role] || !piece || piece.color !== role || piece.type === "P" || piece.promoted || piece.square === null) { this.error(ws, "invalid_crown"); return; }
        next.crowns[role] = piece.id; event("crown_locked", { pieceId: piece.id });
        if (next.crowns.w && next.crowns.b) {
          next.phase = "playing"; next.playStartedAt = now;
          events.push({ t: now, actor: "system", type: "play_started" });
        }
      } else {
        if (state.phase !== "playing") { this.error(ws, "wrong_phase"); return; }
        switch (m.type) {
          case "move": {
            if (role !== state.turn) { this.error(ws, "not_your_turn"); return; }
            const move = pseudoLegalMoves(state, state.turn).find(candidate => candidate.from === m.from && candidate.to === m.to && candidate.promotion === m.promotion);
            if (!move) { this.error(ws, "illegal_move"); return; }
            const applied = applyMove(state, move, now); next = applied.state;
            event("move", { ...applied.record }); break;
          }
          case "offer_draw":
            if (state.drawOffer) { this.error(ws, "draw_already_open"); return; }
            next.drawOffer = role; event("draw_offered"); break;
          case "respond_draw":
            if (!state.drawOffer || state.drawOffer === role) { this.error(ws, "no_opponent_offer"); return; }
            next.drawOffer = null; event(m.accept ? "draw_accepted" : "draw_declined");
            if (m.accept) next.result = { winner: null, reason: "agreement" }; break;
          case "resign": next.result = { winner: opposite(role), reason: "resign" }; event("resign"); break;
        }
      }
      if (next.result) {
        next.phase = "ended"; next.drawOffer = null;
        events.push({ t: now, actor: "system", type: "game_ended", data: { ...next.result } });
      }
      await this.commit(next, events); this.broadcast();
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
    if (pending) await this.ctx.storage.setAlarm(Date.now() + 15000);
  }
}
