import { clientIdOf } from './dhanBot';
import { syncSlmStops } from './slmStops';
import { log, shared } from './te';

/**
 * Dhan's live order-update stream (wss://api-order-update.dhan.co): Dhan pushes a message whenever any order on the
 * account changes. Nothing here polls. Each message (a few together count once) runs one SL-M sync
 * (src/lib/slmStops.ts: three REST reads, plus orders only when something must change). Dhan sometimes sends a message
 * with no fields, so the message is only the cue to look, never trusted for the details.
 *
 * It connects with the Dhan token tradereye last sent (kept in memory), reconnects when it drops or the token changes,
 * and runs one sync on every (re)connect in case something changed while it was down. Needs Node 22+ (built-in WebSocket).
 */

const URL = 'wss://api-order-update.dhan.co';
type WS = { readyState: number; send(d: string): void; close(): void; onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: ((e: unknown) => void) | null };

interface StreamState { ws: WS | null; token: string | null; up: boolean; retry: number; timer: ReturnType<typeof setTimeout> | null; syncing: boolean; again: boolean; debounce: ReturnType<typeof setTimeout> | null }
const g = globalThis as unknown as { __teStream?: StreamState };
const st: StreamState = (g.__teStream ??= { ws: null, token: null, up: false, retry: 0, timer: null, syncing: false, again: false, debounce: null });

/** is the stream connected (Add stop refuses without it: nothing would cancel the other order) */
export const streamUp = () => st.up;

async function sync() {
  if (!shared.token) return;
  if (st.syncing) { st.again = true; return; }
  st.syncing = true;
  try { await syncSlmStops(shared.token); } catch (e) { log(`order stream sync: ${(e as Error).message}`); }
  finally {
    st.syncing = false;
    if (st.again) { st.again = false; void sync(); }
  }
}
/** a burst of messages (one fill can bring several) runs one sync */
const cue = () => { if (st.debounce) clearTimeout(st.debounce); st.debounce = setTimeout(() => { st.debounce = null; void sync(); }, 300); };

function connect() {
  const token = shared.token;
  if (!token) return;
  const W = (globalThis as unknown as { WebSocket?: new (url: string) => WS }).WebSocket;
  if (!W) { log('order stream: this Node has no built-in WebSocket (needs Node 22+): SL-M stops are off, Algo Live keeps its super-order stop leg'); return; }
  st.token = token;
  const ws = new W(URL);
  st.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ LoginReq: { MsgCode: 42, ClientId: clientIdOf(token), Token: token }, UserType: 'SELF' }));
    st.up = true; st.retry = 0;
    log('order stream: connected');
    cue();
  };
  ws.onmessage = (e) => {
    let m: { Type?: string } | null = null;
    try { m = JSON.parse(String(e.data)); } catch { /* not JSON */ }
    if (m?.Type === 'order_alert') cue();
  };
  ws.onerror = () => { /* onclose follows */ };
  ws.onclose = () => {
    if (st.ws !== ws) return; // replaced on purpose
    st.up = false; st.ws = null;
    const wait = Math.min(60_000, 1000 * 2 ** st.retry++);
    if (st.retry <= 1) log(`order stream: disconnected, reconnecting in ${wait / 1000} s`);
    st.timer = setTimeout(() => { st.timer = null; connect(); }, wait);
  };
}

/** called whenever tradereye sends a token: connects the first time, reconnects when the token changed */
export function ensureStream() {
  if (!shared.token || (st.ws && st.token === shared.token) || st.timer) return;
  if (st.ws) { const old = st.ws; st.ws = null; st.up = false; try { old.close(); } catch { /* gone */ } }
  connect();
}
