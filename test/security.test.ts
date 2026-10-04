import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { Limiter, clientIp, proxyInfo } from '../server/security';
const req = (peer: string, forwarded?: string) => ({ socket: { remoteAddress: peer }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } }) as IncomingMessage;
describe('proxy identity and rate limits', () => {
  it('groups visitors when the proxy is not trusted and refuses spoofed headers', () => {
    expect(clientIp(req('::ffff:172.18.0.1', '198.51.100.1'), new Set())).toBe('172.18.0.1');
    expect(proxyInfo(req('172.18.0.1', '198.51.100.2'), new Set())).toMatchObject({ proxyTrusted: false, forwardedAccepted: false, clientIp: '172.18.0.1' });
  });
  it('separates visitors only through an exact trusted peer and one valid address', () => {
    const trusted = new Set(['172.18.0.1']);
    expect(clientIp(req('::ffff:172.18.0.1', '198.51.100.1'), trusted)).toBe('198.51.100.1');
    expect(clientIp(req('172.18.0.1', '198.51.100.2'), trusted)).toBe('198.51.100.2');
    for (const invalid of ['198.51.100.1, 198.51.100.2', 'invalid', '']) expect(clientIp(req('172.18.0.1', invalid), trusted)).toBe('172.18.0.1');
    expect(clientIp(req('172.18.0.2', '198.51.100.1'), trusted)).toBe('172.18.0.2');
  });
  it('reports when the next token becomes available without extending a denied request', () => {
    const limiter = new Limiter(5, 600000, 2);
    for (let i = 0; i < 5; i++) expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(false); expect(limiter.retryAfter('a', 0)).toBe(120);
    expect(limiter.take('a', 60000)).toBe(false); expect(limiter.retryAfter('a', 60000)).toBe(60);
    expect(limiter.take('b', 60000)).toBe(true); expect(limiter.take('a', 120000)).toBe(true);
    expect(limiter.take('c', 120000)).toBe(false);
  });
});
