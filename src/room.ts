import { DurableObject } from "cloudflare:workers";
import { RoomCore } from "./room-core";
import type { RoomContext } from "./room-core";
import type { GameState, LogEvent } from './types';
import { ruleRegistry } from './rules/registry';
import { initialPosition } from './engine';

export class Room extends DurableObject<unknown> {
  private core: RoomCore;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const context: RoomContext = {
      getWebSockets: () => ctx.getWebSockets(),
      blockConcurrencyWhile: callback => ctx.blockConcurrencyWhile(callback),
      setAlarm: async at => { await ctx.storage.setAlarm(at); },
      persistence: {
        load: async () => {
          const state = await ctx.storage.get<GameState>('state');
          if (!state) return undefined;
          state.revision ??= 0; state.ruleset ??= ruleRegistry.selection({ id: 'hidden-crown', version: 1 });
          state.initialPosition ??= initialPosition(); state.ruleState ??= {};
          return { state, events: await ctx.storage.get<LogEvent[]>('log') ?? [] };
        },
        commit: async (state, events, expectedRevision) => {
          await ctx.storage.transaction(async txn => {
            const saved = await txn.get<GameState>('state');
            if ((saved?.revision ?? 0) !== expectedRevision) throw new Error('room_conflict');
            const log = await txn.get<LogEvent[]>('log') ?? [];
            await txn.put({ state, log: [...log, ...events] });
          });
        }
      }
    };
    this.core = new RoomCore(context);
  }
  async fetch(request: Request): Promise<Response> {
    const response = await this.core.fetch(request);
    if (response.status !== 204) return response;
    if (this.core.pendingCount() >= 8) return new Response("Too many pending connections", { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    await this.core.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) { return this.core.webSocketMessage(ws, raw); }
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) { return this.core.webSocketClose(ws, code, reason, wasClean); }
  webSocketError(ws: WebSocket) { return this.core.webSocketError(ws); }
  alarm() { return this.core.alarm(); }
}
