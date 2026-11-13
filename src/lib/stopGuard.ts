import { ltps, orderList, positions, superOrders } from './dhanBot';
import { exitNow, bookOf, pick } from './symbolOrders';
import { istNow, log, shared } from './te';

/**
 * The stop guard: makes sure a stop that is hit actually closes the position.
 *
 * Dhan sends no API order to the exchange as a pure market order (since March 2026). When a stop triggers (a super
 * order's stop leg, or an SL order) the exit goes out as a LIMIT, and in a fast move that limit is left behind unfilled
 * while the loss keeps growing (13 Nov 2026: a ~₹300 stop turned into ~₹600 before he could close it by hand).
 *
 * Every GUARD_TICK_MS (2 s) in market hours, for every open NSE position:
 *  - it remembers the position's stop (the nearest stop order on the closing side; it follows a dragged / break-even stop);
 *  - if the stop order is gone and the price is NOT past it, he took it away himself: it is forgotten;
 *  - the moment the last price is past the stop with the position still open (GUARD_GRACE_MS, default 0, can add a
 *    wait), it closes it at market in effect (src/lib/symbolOrders.ts exitNow): cancels the stuck exit and every other
 *    working order of the stock, waits until they are gone, then a buy / sell priced EXIT_CHASE_PCT (2%) through the
 *    last price: it fills at once at the best prices there are, like a market order, re-priced until flat.
 * It uses the Dhan token tradereye last sent (the Charts page and Algo Live send it every few seconds). STOP_GUARD=off
 * turns it off.
 */

const TICK = Number(process.env.GUARD_TICK_MS ?? 2000);
const GRACE = Number(process.env.GUARD_GRACE_MS ?? 0);
let running = false, lastErr = '';

/** past the stop: a long's price at / below it, a short's at / above it */
export const pastStop = (ltp: number, stop: number, dir: 1 | -1) => (dir > 0 ? ltp <= stop : ltp >= stop);

/** one look at every open position (exported for tests) */
export async function guardTick(token: string, now = Date.now()) {
  const pos = (await positions(token)).filter((p) => p.netQty && (p.exchangeSegment ?? 'NSE_EQ') === 'NSE_EQ');
  if (!pos.length) { shared.guard.clear(); return; }
  const ids = [...new Set(pos.map((p) => String(p.securityId)))];
  const [sup, ord, last] = await Promise.all([superOrders(token), orderList(token), ltps(token, ids)]);
  for (const id of [...shared.guard.keys()]) if (!ids.includes(id)) shared.guard.delete(id);
  for (const id of ids) {
    if (shared.exiting.has(id)) continue;
    const b = bookOf(id, pick(id, sup, ord, pos));
    const p = b.position;
    if (!p) continue;
    const dir: 1 | -1 = p.netQty > 0 ? 1 : -1, exitSide = dir > 0 ? 'SELL' : 'BUY';
    const stops = b.working.filter((w) => w.role === 'stop' && w.side === exitSide && w.price > 0).map((w) => w.price);
    const ltp = last.get(id);
    let mem = shared.guard.get(id);
    if (stops.length) {
      // the stop hit first: a long's highest, a short's lowest
      const stop = dir > 0 ? Math.max(...stops) : Math.min(...stops);
      if (!mem || mem.stop !== stop || mem.dir !== dir) { mem = { stop, dir, beyondSince: null }; shared.guard.set(id, mem); }
    } else if (mem && !(ltp && pastStop(ltp, mem.stop, mem.dir))) {
      // the stop is gone and price never got there: he removed it himself
      shared.guard.delete(id); continue;
    }
    if (!mem || !ltp) continue;
    if (!pastStop(ltp, mem.stop, mem.dir)) { mem.beyondSince = null; continue; }
    if (mem.beyondSince === null) mem.beyondSince = now;
    if (now - mem.beyondSince < GRACE) continue;
    log(`stop guard: ${id} ${dir > 0 ? 'long' : 'short'} ${Math.abs(p.netQty)}, price ${ltp} past its stop ${mem.stop} for ${Math.round((now - mem.beyondSince) / 1000)} s and still open: closing it`);
    // not awaited: one stuck stock must not hold up the others
    void exitNow(token, id, `stop ${mem.stop} hit, price ${ltp}`).catch((e) => log(`stop guard exit ${id} failed: ${(e as Error).message}`));
  }
}

export function startStopGuard() {
  if (/^(off|0|false)$/i.test(process.env.STOP_GUARD ?? '')) { log('stop guard is OFF (STOP_GUARD)'); return; }
  const g = globalThis as unknown as { __teGuard?: ReturnType<typeof setInterval> };
  if (g.__teGuard) return;
  g.__teGuard = setInterval(() => {
    const n = istNow();
    const wd = new Date(Date.now() + 19800_000).getUTCDay();
    if (running || wd === 0 || wd === 6 || n.min < 9 * 60 + 15 || n.min > 15 * 60 + 30) return;
    if (!shared.token || Date.now() - shared.tokenAt > 20 * 3600_000) return;
    running = true;
    guardTick(shared.token)
      .then(() => { lastErr = ''; })
      .catch((e) => { const m = (e as Error).message; if (m !== lastErr) log(`stop guard: ${m}`); lastErr = m; })
      .finally(() => { running = false; });
  }, TICK);
  log(`stop guard is on (every ${TICK / 1000} s, ${GRACE / 1000} s grace)`);
}
