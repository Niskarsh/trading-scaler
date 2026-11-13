import { clientIdOf } from './dhanBot';
import { syncSlmStops } from './slmStops';
import { log, shared } from './te';

/**
 * Dhan's live order-update stream (wss://api-order-update.dhan.co): Dhan pushes a message whenever any order on the
 * account changes. Nothing here polls. Messages run the Add-stop sync (src/lib/slmStops.ts: two REST reads, plus
 * orders only when something must change), AT MOST once every MIN_GAP ms however many messages come: our own orders
 * raise messages too, and on 13 Nov 2026 a refused cancel re-raised one each time and looped. Dhan sometimes sends a
 * message with no fields, so a message is only the cue to look, never trusted for the details.
 *
 * It connects with the Dhan token tradereye last sent (kept in memory), reconnects when it drops or the token changes,
 * and runs one sync on every (re)connect in case something changed while it was down. Needs Node 22+ (built-in WebSocket).
 */

const URL = 'wss://api-order-update.dhan.co';
const MIN_GAP = 3000;
type WS = { readyState: number; send(d: string): void; close(): void; onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: ((e: unknown) => void) | null };

interface StreamState { ws: WS | null; token: string | null; up: boolean; retry: number; timer: ReturnType<typeof setTimeout> | null; syncing: boolean; again: boolean; debounce: ReturnType<typeof setTimeout> | null; lastSync: number }
const g = globalThis as unknown as { __teStream?: StreamState };
const st: StreamState = (g.__teStream ??= { ws: null, token: null, up: false, retry: 0, timer: null, syncing: false, again: false, debounce: null, lastSync: 0 });
st.lastSync ??= 0;

/** is the stream connected (Add stop refuses without it: nothing would cancel the other order) */
export const streamUp = () => st.up;

async function sync() {
  if (!shared.token) return;
  if (st.syncing) { st.again = true; return; }
  st.syncing = true;
  st.lastSync = Date.now();
  try { await syncSlmStops(shared.token); } catch (e) { log(`order stream sync: ${(e as Error).message}`); }
  finally {
    st.syncing = false;
    if (st.again) { st.again = false; cue(); }
  }
}
/** messages run one sync, no sooner than MIN_GAP after the last one (a burst, or our own orders' messages, count once) */
function cue() {
  if (st.debounce) return;
  const wait = Math.max(300, st.lastSync + MIN_GAP - Date.now());
  st.debounce = setTimeout(() => { st.debounce = null; void sync(); }, wait);
}

function connect() {
  const token = shared.token;
  if (!token) return;
  const W = (globalThis as unknown as { WebSocket?: new (url: string) => WS }).WebSocket;
  if (!W) { log('order stream: this Node has no built-in WebSocket (needs Node 22+): Add stop is off'); return; }
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
