import { createDecipheriv, createHash } from 'node:crypto';

/**
 * The bridge from tradereye (its Algo Live page). Every call arrives sealed with AES-256-GCM under a key derived from
 * TE_SHARED_SECRET (the same secret is set on Vercel for tradereye): nobody without it can read a call (it carries the
 * Dhan token) or forge one, even over plain HTTP. A call older than a minute, or one seen before, is refused.
 * (tradereye's side: lib/algoLive/scaler.ts.)
 */

const AAD = Buffer.from('tradereye-scaler-v1');
export interface Sealed { v: 1; iv: string; tag: string; data: string }

export function openSealed<T>(secret: string, s: Sealed): T & { ts: number; nonce: string } {
  const key = createHash('sha256').update(secret, 'utf8').digest();
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8'));
}

/** state shared by the route and the 15:15 timer (one Node process under pm2; globalThis survives separate bundles) */
interface Shared { token: string | null; tokenAt: number; seen: Map<string, number>; squaredOff: string | null; squaring: boolean; log: string[] }
const g = globalThis as unknown as { __te?: Shared };
export const shared: Shared = (g.__te ??= { token: null, tokenAt: 0, seen: new Map(), squaredOff: null, squaring: false, log: [] });

export function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(`[te] ${line}`);
  shared.log.push(line);
  if (shared.log.length > 200) shared.log.shift();
}

/** opens a call: right key, fresh (60 s), never seen before */
export function accept<T>(body: unknown): (T & { ts: number; nonce: string }) | string {
  const secret = process.env.TE_SHARED_SECRET;
  if (!secret || secret.length < 24) return 'TE_SHARED_SECRET is not set (at least 24 characters) on this server';
  let m: T & { ts: number; nonce: string };
  try { m = openSealed<T>(secret, body as Sealed); } catch { return 'not sealed with the shared secret'; }
  const now = Date.now();
  if (!(Math.abs(now - m.ts) < 60_000)) return 'too old (check both clocks)';
  for (const [n, at] of shared.seen) if (now - at > 120_000) shared.seen.delete(n);
  if (shared.seen.has(m.nonce)) return 'replayed';
  shared.seen.set(m.nonce, now);
  return m;
}

export const istNow = (ms = Date.now()) => { const t = new Date(ms + 19800_000); return { date: t.toISOString().slice(0, 10), min: t.getUTCHours() * 60 + t.getUTCMinutes() }; };
