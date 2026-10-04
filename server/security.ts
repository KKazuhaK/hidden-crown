import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

// Bounded token buckets. A full table denies new keys rather than evicting throttled attackers.
export class Limiter {
  private entries = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private windowMs: number, private maxKeys = 4096) {}
  take(key: string, now = Date.now()) {
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) {
        for (const [id, old] of this.entries) if (now - old.at >= this.windowMs) this.entries.delete(id);
        if (this.entries.size >= this.maxKeys) return false;
      }
      entry = { tokens: this.capacity, at: now }; this.entries.set(key, entry);
    }
    entry.tokens = Math.min(this.capacity, entry.tokens + (now - entry.at) * this.capacity / this.windowMs);
    entry.at = now;
    if (entry.tokens < 1) return false;
    entry.tokens--; return true;
  }
  retryAfter(key: string, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return Math.ceil(this.windowMs / 1000);
    const tokens = Math.min(this.capacity, entry.tokens + (now - entry.at) * this.capacity / this.windowMs);
    return Math.max(1, Math.ceil((1 - tokens) * this.windowMs / this.capacity / 1000));
  }
}
export function proxyInfo(request: IncomingMessage, proxies: Set<string>) {
  const normalize = (ip: string) => ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const peerIp = normalize(request.socket.remoteAddress ?? 'unknown');
  const forwarded = request.headers['x-forwarded-for'];
  const proxyTrusted = proxies.has(peerIp);
  const forwardedAccepted = proxyTrusted && typeof forwarded === 'string' && !!isIP(forwarded.trim());
  return { peerIp, clientIp: forwardedAccepted ? normalize((forwarded as string).trim()) : peerIp,
    proxyTrusted, forwardedHeaderPresent: forwarded !== undefined, forwardedAccepted };
}
export function clientIp(request: IncomingMessage, proxies: Set<string>) {
  // Only an explicitly trusted peer may supply the single address overwritten by Nginx.
  return proxyInfo(request, proxies).clientIp;
}
