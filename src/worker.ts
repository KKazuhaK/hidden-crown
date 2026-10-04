import type { Room } from "./room";
export { Room } from "./room";
interface Env { ROOM: DurableObjectNamespace<Room>; ASSETS: Fetcher }
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const roomPattern = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return new Response("Origin denied", { status: 403 });
    }
    if (url.pathname === "/api/rooms") {
      if (request.method !== "POST") return new Response("POST required", { status: 405, headers: { Allow: "POST" } });
      for (let attempt = 0; attempt < 3; attempt++) {
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        const roomId = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
        const tokens = { w: crypto.randomUUID(), b: crypto.randomUUID(), observer: crypto.randomUUID() };
        const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
        const response = await stub.fetch("https://room.internal/init", { method: "POST", body: JSON.stringify({ roomId, tokens }) });
        if (response.status === 409) continue;
        return new Response(response.body, { status: response.ok ? 201 : response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
      return new Response("Please retry", { status: 503 });
    }
    const joinPath = /^\/api\/rooms\/([^/]+)\/join$/.exec(url.pathname);
    if (joinPath) {
      const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
      if (request.method !== "POST") return Response.json({ code: "bad_request" }, { status: 405, headers: { ...headers, Allow: "POST" } });
      const roomId = joinPath[1].toUpperCase();
      if (!roomPattern.test(roomId)) return Response.json({ code: "invalid_room_number" }, { status: 400, headers });
      // The first player chooses a color; the second receives the remaining seat.
      const body = await request.text();
      let payload: Record<string, unknown> = {};
      if (body) {
        let value: unknown;
        try { value = body.length <= 128 ? JSON.parse(body) : null; } catch { value = null; }
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "color") || ('color' in value && !['w', 'b'].includes(String(value.color)))) {
          return Response.json({ code: "bad_request" }, { status: 400, headers });
        }
        payload = value as Record<string, unknown>;
      }
      const response = await env.ROOM.get(env.ROOM.idFromName(roomId)).fetch("https://room.internal/join", { method: "POST", body: JSON.stringify(payload) });
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.pathname.startsWith("/ws/")) {
      const roomId = url.pathname.slice(4);
      if (!roomPattern.test(roomId)) return new Response("Invalid room", { status: 404 });
      if (request.method !== "GET") return new Response("GET required", { status: 405 });
      return env.ROOM.get(env.ROOM.idFromName(roomId)).fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
