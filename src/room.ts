import { DurableObject } from "cloudflare:workers";
import { RoomCore } from "./room-core";
import type { RoomContext } from "./room-core";

export class Room extends DurableObject<unknown> {
  private core: RoomCore;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.core = new RoomCore(ctx as unknown as RoomContext);
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
