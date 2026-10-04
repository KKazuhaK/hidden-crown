import { ruleRegistry } from './rules/registry';
import type { GameCommand, GameState, Links, LogEvent, Role, View } from "./types";

export type ClientMessage =
  | GameCommand
  | { type: "hello"; token: string }
  | { type: 'get_log' }
  | { type: 'get_links' }
  | { type: 'ping' };
export type ServerMessage =
  | { type: "welcome"; role: Role }
  | { type: "state"; view: View }
  | { type: "log"; events: LogEvent[]; moves: GameState["moves"]; crowns: GameState["crowns"] }
  | { type: "links"; links: Partial<Links> }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

export function parseMessage(raw: string | ArrayBuffer): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m !== "object" || Array.isArray(m)) return null;
    let allowed: string[];
    switch (m.type) {
      case "hello": if (typeof m.token !== "string" || m.token.length > 128) return null; allowed = ["token"]; break;
      case "select_crown": if (typeof m.pieceId !== "string" || m.pieceId.length > 16) return null; allowed = ["pieceId"]; break;
      case "move":
        if (![m.from, m.to].every(s => Number.isInteger(s) && s >= 0 && s < 64) || (m.promotion !== undefined && !["Q", "R", "B", "N"].includes(m.promotion))) return null;
        allowed = ["from", "to", "promotion"]; break;
      case "respond_draw": case 'respond_undo': if (typeof m.accept !== "boolean") return null; allowed = ["accept"]; break;
      case 'rule_action':
        if (typeof m.action !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(m.action) || !m.payload || typeof m.payload !== 'object' || Array.isArray(m.payload)) return null;
        allowed = ['action', 'payload']; break;
      case "offer_draw": case 'request_undo': case "resign": case "get_log": case "get_links": case "ping": allowed = []; break;
      default: return null;
    }
    if (Object.keys(m).some(key => key !== "type" && !allowed.includes(key))) return null;
    return m as ClientMessage;
  } catch { return null; }
}

export function viewFor(state: GameState, role: Role, connected: View["connected"], now = Date.now()): View {
  // Explicit allowlist: adding server-only state fields cannot accidentally disclose them.
  const view: View = {
    undoRequest: state.undoRequest ?? null,
    ...(state.turnStartedAt === undefined ? {} : { turnStartedAt: state.turnStartedAt }),
    ...(state.computer ? { computer: state.computer } : {}),
    revision: state.revision, ruleset: state.ruleset, initialPosition: state.initialPosition,
    role, phase: state.phase, pieces: state.pieces, board: state.board, turn: state.turn, moves: state.moves,
    connected, playStartedAt: state.playStartedAt, lastMoveAt: state.lastMoveAt, serverNow: now,
    crownLocked: { w: !!state.crowns.w, b: !!state.crowns.b }, drawOffer: state.drawOffer, result: state.result
  };
  if (role !== "observer" && state.crowns[role]) view.yourCrown = state.crowns[role]!;
  if (role === "observer" || state.phase === "ended") view.crowns = state.crowns;
  const rules = ruleRegistry.resolve(state.ruleset);
  if (role !== 'observer') view.canRequestUndo = rules.canRequestUndo?.(state, role) ?? false;
  if (role === state.turn && state.phase === "playing") view.legalMoves = state.undoRequest ? [] : rules.legalMoves(state, state.turn);
  return view;
}

export function linksFor(state: GameState): Links {
  const link = (role: Role) => `/?room=${encodeURIComponent(state.roomId)}#t=${encodeURIComponent(state.tokens[role])}`;
  return { white: link("w"), black: link("b"), observer: link("observer") };
}
export function playerLinksFor(state: GameState): Partial<Pick<Links, 'white' | 'black'>> {
  const links = linksFor(state);
  return { ...(state.computer?.color !== 'w' ? { white: links.white } : {}), ...(state.computer?.color !== 'b' ? { black: links.black } : {}) };
}
