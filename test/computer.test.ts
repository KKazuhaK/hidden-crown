import { describe, expect, it } from 'vitest';
import { initialPosition, advancePosition, pseudoLegalMoves } from '../src/engine';
import { advanceSearch, chooseComputerMove, searchLimits, type ComputerInput } from '../src/computer/engine';
import { computerRequest } from '../src/computer/config';
import { ruleRegistry } from '../src/rules/registry';
import { RoomCore, type RoomContext, type RoomSocket, type Attachment } from '../src/room-core';
import type { GameState, Piece } from '../src/types';
import { ComputerPool } from '../server/computer-pool';

function game(): GameState {
  const p = initialPosition();
  return { ...p, turn: 'b', computer: { color: 'b', difficulty: 'medium' }, revision: 1, ruleset: ruleRegistry.selection(),
    initialPosition: structuredClone(p), ruleState: { private: 'never-search-this' }, roomId: 'BOTROOM1', createdAt: 0,
    phase: 'playing', moves: [], drawOffer: null, joined: { w: true, b: true }, claimed: { w: true, b: true },
    playStartedAt: 0, lastMoveAt: null, result: null, crowns: { w: 'wRa', b: 'bQ' },
    tokens: { w: 'human-private', b: 'computer-private', observer: 'admin-private' } };
}
function context(state: GameState, online = true) {
  const frames: unknown[] = []; let attachment: Attachment = { active: true, openedAt: 0, role: 'w' };
  const socket: RoomSocket = { readyState: 1, deserializeAttachment: () => attachment, serializeAttachment: a => { attachment = a; }, send: s => frames.push(JSON.parse(s)), close: () => {} };
  let tail: Promise<unknown> = Promise.resolve();
  const ctx: RoomContext = { persistence: { load: async () => ({ state, events: [] }), commit: async () => {} },
    setAlarm: async () => {}, getWebSockets: () => online ? [socket] : [],
    blockConcurrencyWhile: fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; } };
  return { ctx, socket, frames };
}
function input(g: GameState): ComputerInput {
  return { color: 'b', difficulty: 'medium', ruleset: g.ruleset, pieces: g.pieces, board: g.board, turn: g.turn,
    enPassant: g.enPassant, halfmoveClock: g.halfmoveClock, ownCrown: g.crowns.b };
}
function tactical() {
  const g = game(); g.board.fill(null); g.pieces = {};
  for (const [id, type, color, square] of [['bK', 'K', 'b', 63], ['bQ', 'Q', 'b', 27], ['wK', 'K', 'w', 4], ['wQ', 'Q', 'w', 28]] as const) {
    const p: Piece = { id, type, color, square, hasMoved: true, promoted: false }; g.pieces[id] = p; g.board[square] = id;
  }
  return g;
}
describe('hidden-information computer player', () => {
  it('keeps a computer interrogation private and follows it with a move on the same turn', async () => {
    const state = game(); state.board[0] = null; state.pieces.wRa.square = 52; state.board[52] = 'wRa'; state.pieces.bPe.square = null;
    const h = context(state), core = new RoomCore(h.ctx); await core.ready;
    const before = core.computerTurn()!;
    expect(before.input.interrogationTargets).toContain('wRa');
    expect(await core.computerAction({ type: 'interrogate', targetId: 'wRa' }, before.revision)).toBe(true);
    expect(h.frames).toEqual([]);
    const after = core.computerTurn()!;
    expect(after.revision).toBe(before.revision + 1); expect(after.input.turn).toBe('b');
    expect(after.input.interrogationKnowledge).toEqual({ wRa: 'crown' });
    expect(after.input.interrogationTargets).not.toContain('wRa');
    expect(await core.computerAction({ type: 'interrogate', targetId: 'wRa' }, before.revision)).toBe(false);
    const move = chooseComputerMove({ ...after.input, interrogationTargets: [] }, () => 0).move!;
    expect(await core.computerAction({ type: 'move', from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) }, after.revision)).toBe(true);
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({ type: 'state', view: { moves: [expect.objectContaining({ color: 'b' })], interrogations: [], interrogationsRemaining: { w: 2 }, revision: before.revision + 1 } });
  });
  it('rejects player draw negotiation in both computer rulesets without changing the game', async () => {
    for (const selection of [ruleRegistry.selection(), ruleRegistry.selection({ id: 'standard-chess', version: 1 })]) {
      const state = game(); state.ruleset = selection; state.ruleState = ruleRegistry.resolve(selection).initialize(selection).ruleState;
      const h = context(state), core = new RoomCore(h.ctx); await core.ready;
      const before = core.computerTurn();
      for (const command of [{ type: 'offer_draw' }, { type: 'respond_draw', accept: true }, { type: 'respond_draw', accept: false }]) {
        await core.webSocketMessage(h.socket, JSON.stringify(command));
        expect(h.frames.at(-1)).toMatchObject({ type: 'error', code: 'computer_draw_offer_disabled' });
        expect(core.computerTurn()).toEqual(before);
      }
    }
  });
  it('keeps draw negotiation available between friends', async () => {
    const state = game(); delete state.computer;
    const h = context(state), core = new RoomCore(h.ctx); await core.ready;
    await core.webSocketMessage(h.socket, JSON.stringify({ type: 'offer_draw' }));
    expect(h.frames.at(-1)).toMatchObject({ type: 'state', view: { drawOffer: 'w', phase: 'playing' } });
  });
  it('validates difficulty and color before reserving a computer seat', () => {
    expect(computerRequest({ humanColor: 'w', difficulty: 'hard' }, ruleRegistry.selection(), () => 0)).toEqual({ color: 'b', difficulty: 'hard' });
    expect(computerRequest({ humanColor: 'random', difficulty: 'easy' }, ruleRegistry.selection(), () => 1).color).toBe('w');
    for (const value of [null, [], {}, { humanColor: 'observer', difficulty: 'hard' }, { humanColor: 'w', difficulty: 'impossible' }, { humanColor: 'b', difficulty: 'easy', script: true }]) expect(() => computerRequest(value, ruleRegistry.selection(), () => 0)).toThrow('invalid_computer');
  });
  it('projects identical search input for different enemy crowns, without credentials or private rule data', async () => {
    const a = game(), b = structuredClone(a); b.crowns.w = 'wQ';
    const ca = new RoomCore(context(a).ctx), cb = new RoomCore(context(b).ctx); await Promise.all([ca.ready, cb.ready]);
    const pa = ca.computerTurn()!.input, pb = cb.computerTurn()!.input;
    expect(pa).toEqual(pb); expect(pa.ownCrown).toBe('bQ');
    expect(Object.keys(pa).sort()).toEqual(['color','difficulty','ruleset','pieces','board','turn','enPassant','halfmoveClock','ownCrown','interrogationTargets','interrogationKnowledge'].sort());
    expect(JSON.stringify(pa)).not.toMatch(/human-private|computer-private|admin-private|never-search-this/);
    expect(chooseComputerMove(pa, () => 0).move).toEqual(chooseComputerMove(pb, () => 0).move);
  });
  it('uses genuine legal moves and bounded, distinct difficulty budgets', () => {
    const g = tactical(), original = structuredClone(g);
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const result = chooseComputerMove({ ...input(g), difficulty }, () => 0);
      expect(pseudoLegalMoves(g, 'b')).toContainEqual(result.move);
      expect(result.nodes).toBeLessThanOrEqual(searchLimits[difficulty].nodes);
    }
    expect(searchLimits.hard.nodes).toBeGreaterThan(searchLimits.medium.nodes);
    expect(searchLimits.medium.depth).toBeGreaterThan(searchLimits.easy.depth); expect(g).toEqual(original);
    expect(chooseComputerMove(input(g)).move?.to).toBe(28); // Unprotected queen remains a valuable capture.
  });
  it('escapes an immediate threat to its own crown without imposing chess check restrictions', () => {
    const g = tactical(); g.ruleset = ruleRegistry.selection({ id: 'hidden-crown', version: 1 }); g.crowns.b = 'bK'; delete g.pieces.bQ; g.board[27] = null; delete g.pieces.wQ; g.board[28] = null;
    g.pieces.wRh = { id: 'wRh', color: 'w', type: 'R', square: 7, hasMoved: true, promoted: false }; g.board[7] = 'wRh';
    const move = chooseComputerMove(input(g)).move!; expect(move.pieceId).toBe('bK');
    const next = advanceSearch(input(g), move);
    expect(pseudoLegalMoves(next as GameState, 'w').some(m => m.to === next.pieces.bK.square)).toBe(false);
  });
  it('matches the authoritative engine for castling, promotion and en passant', () => {
    const fixtures: GameState[] = [];
    const castle = game(); for (const s of [57,58,59,61,62]) { castle.pieces[castle.board[s]!].square = null; castle.board[s] = null; } fixtures.push(castle);
    const promotion = game(); const pawn = promotion.pieces.bPa; promotion.board[pawn.square!] = null; pawn.square = 8; promotion.board[8] = pawn.id;
    for (const s of [0,1]) { if (promotion.board[s]) promotion.pieces[promotion.board[s]!].square = null; promotion.board[s] = null; } fixtures.push(promotion);
    const ep = game(); for (const [id,square] of [['bPd',27],['wPe',28]] as const) { const p = ep.pieces[id]; ep.board[p.square!] = null; p.square = square; p.hasMoved = true; ep.board[square] = id; } ep.enPassant = 20; fixtures.push(ep);
    expect(fixtures.flatMap(g => pseudoLegalMoves(g,'b')).some(m => m.enPassant)).toBe(true);
    for (const g of fixtures) for (const move of pseudoLegalMoves(g, 'b')) {
      const actual = advancePosition(g, move, 100).state;
      expect(advanceSearch(input(g), move)).toEqual({ pieces: actual.pieces, board: actual.board, turn: actual.turn, enPassant: actual.enPassant, halfmoveClock: actual.halfmoveClock });
    }
  });
  it('pauses offline, rejects takeover, stale results and results after administrative termination', async () => {
    const offline = new RoomCore(context(game(), false).ctx); await offline.ready; expect(offline.computerTurn()).toBeUndefined();
    const h = context(game()), core = new RoomCore(h.ctx); await core.ready;
    const move = chooseComputerMove(core.computerTurn()!.input).move!;
    expect(await core.computerAction({ type: 'move', from: move.from, to: move.to }, 0)).toBe(false);
    const intruder = context(game()).socket; intruder.serializeAttachment({ active: true, openedAt: 0 });
    await core.webSocketMessage(intruder, JSON.stringify({ type: 'hello', token: 'computer-private' })); expect(intruder.deserializeAttachment()?.role).toBeUndefined();
    await core.adminEnd(); expect(await core.computerAction({ type: 'move', from: move.from, to: move.to }, 1)).toBe(false);
  });
  it('runs searches in the bounded worker pool and shuts down pending jobs', async () => {
    const pool = new ComputerPool(1, new URL('../dist/computer-worker.mjs', import.meta.url).href);
    try {
      const moves = await Promise.all([pool.search(input(tactical())), pool.search({ ...input(tactical()), difficulty: 'hard' })]);
      for (const result of moves) expect(result.move?.to).toBe(28);
    } finally { await pool.close(); }
    await expect(pool.search(input(game()))).rejects.toThrow('computer_busy');
  });
  it('rejects excess queued jobs and cancels every pending promise on shutdown', async () => {
    const pool = new ComputerPool(1, new URL('../dist/computer-worker.mjs', import.meta.url).href);
    const pending = Array.from({ length: 65 }, () => pool.search(input(game())).then(() => 'done', e => e.message));
    await expect(pool.search(input(game()))).rejects.toThrow('computer_busy');
    await pool.close(); expect(await Promise.all(pending)).toEqual(Array(65).fill('computer_stopped'));
  });
});
