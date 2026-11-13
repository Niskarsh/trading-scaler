import { cancelLeg, cancelOrder, limitOrder, modifyOrder, orderList, positions, stopLimitOrder, superOrders, type PlainOrder, type Position } from './dhanBot';
import { istNow, log, markGone, shared } from './te';

/**
 * Stop / target PAIRS: a stop-limit at the exchange plus a target LIMIT, for
 *  - Algo Live trades: the entry is a plain market order; once it fills, its stop and target go in (placePair), and
 *  - the Charts page's Add stop: a pair for a position already open.
 * Dhan's API takes no stop without a limit price (13 Nov 2026: an SL-M with price 0 was refused, DH-906), so the stop's
 * limit sits STOP_LIMIT_BUFFER_PCT (0.5%) past its trigger: once triggered it fills at the best price up to there.
 * Dragging the stop line (or Break-even) moves trigger and limit together (dhanBot modifyOrder keeps the gap).
 *
 * syncPairs runs (one at a time) when Dhan's order stream says an order changed, and every 20 s straight from Dhan while
 * a trade is managed (src/lib/orderStream.ts), so a dropped stream never leaves a pair unmanaged:
 *  - an Algo Live entry that filled gets its pair (placed once; whatever Dhan refuses is reported, not retried);
 *  - position flat (stop or target filled, or closed by hand): what is left is cancelled (not in the first 15 s
 *    after placing: the position list can lag; it looks again then);
 *  - the stop / target quantity follows the open quantity (an entry still filling, a target filled in part).
 *
 * Hard rules (13 Nov 2026, when a stop was cancelled before its replacement existed and a refused cancel looped):
 *  - nothing here ever cancels or changes a stop while the position it protects is open, except to match its quantity;
 *  - an order action Dhan refused is never retried by itself (`shared.failed`); the stream syncs at most every 3 s.
 */

const OPEN = ['PENDING', 'TRANSIT', 'PART_TRADED', 'TRIGGERED'];
const FRESH_MS = 15_000;
export const BUFFER_PCT = () => Number(process.env.STOP_LIMIT_BUFFER_PCT ?? 0.5);
const isOurStop = (o: PlainOrder) => /STOP_LOSS/.test(o.orderType) && (o.correlationId ?? '').startsWith('te-s') && OPEN.includes(o.orderStatus);
const isOurTarget = (o: PlainOrder) => o.orderType === 'LIMIT' && (o.correlationId ?? '').startsWith('te-t') && OPEN.includes(o.orderStatus);
const left = (o: PlainOrder) => o.remainingQuantity || o.quantity;
const tick = (v: number) => Number((Math.round(v * 20) / 20).toFixed(2));

/** the limit of a stop-limit: BUFFER_PCT past the trigger, on the side that fills */
export const stopLimitPrice = (trigger: number, side: 'BUY' | 'SELL') => {
  const b = BUFFER_PCT() / 100;
  return Number((side === 'BUY' ? Math.ceil((trigger * (1 + b)) / 0.05) * 0.05 : Math.floor((trigger * (1 - b)) / 0.05) * 0.05).toFixed(2));
};

/** runs an order action once: if Dhan refused it, it is logged and never tried again by itself */
async function once(key: string, what: string, f: () => Promise<unknown>): Promise<boolean> {
  if (shared.failed.has(key)) return false;
  try { await f(); return true; }
  catch (e) { shared.failed.add(key); log(`${what}: ${(e as Error).message} (not retried: act on it in Dhan or on the chart)`); return false; }
}

/** places a stop and / or a target (whichever is given) closing `qty` of a position; returns what was placed and what Dhan refused */
export async function placePair(token: string, o: { securityId: string; side: 'BUY' | 'SELL'; qty: number; stop?: number; target?: number; productType?: string; why: string }) {
  const date = istNow().date.replace(/-/g, ''), sid = o.securityId, done: string[] = [], errors: string[] = [];
  shared.pairAt.set(sid, Date.now());
  if (o.stop) try {
    const st = tick(o.stop), lim = stopLimitPrice(st, o.side);
    await stopLimitOrder(token, { securityId: sid, side: o.side, qty: o.qty, trigger: st, price: lim, productType: o.productType, correlationId: `te-s${date}-${sid}-${Date.now() % 10000}`.slice(0, 30) });
    done.push(`stop ${o.side} ${o.qty} at ${st} (fills up to ${lim})`);
    shared.slm.set(sid, st);
  } catch (e) { errors.push(`STOP NOT PLACED: ${(e as Error).message}. The position has no stop: add one on the chart or in Dhan`); }
  if (o.target) {
    try {
      await limitOrder(token, { securityId: sid, side: o.side, qty: o.qty, price: tick(o.target), productType: o.productType, correlationId: `te-t${date}-${sid}-${Date.now() % 10000}`.slice(0, 30) });
      done.push(`target ${o.side} ${o.qty} at ${tick(o.target)}`);
    } catch (e) { errors.push(`target not placed: ${(e as Error).message}`); }
  }
  log(`pair ${sid} (${o.why}): ${done.join(', ') || 'nothing placed'}${errors.length ? ` · ${errors.join('; ')}` : ''}`);
  return { done, errors };
}

/** keeps the open orders of one kind to exactly `qty` in total: extras cancelled, the first re-sized */
async function fitQty(token: string, sid: string, kind: 'stop' | 'target', list: PlainOrder[], qty: number) {
  const total = list.reduce((a, x) => a + left(x), 0);
  if (!list.length || total === qty) return;
  for (const x of list.slice(1)) await once(`cancel:${x.orderId}`, `${kind} ${sid}: cancel ${x.orderId}`, () => cancelOrder(token, x.orderId));
  if (await once(`modify:${list[0].orderId}:${qty}`, `${kind} ${sid}: resize ${list[0].orderId} to ${qty}`, () => modifyOrder(token, list[0], Number(kind === 'stop' ? list[0].triggerPrice : list[0].price), qty)))
    log(`${kind} ${sid}: quantity now ${qty} (the open position)`);
}

/** one look at the account; returns ms after which to look again (a fresh pair), or 0 */
async function syncOnce(token: string): Promise<number> {
  const [ord, pos] = await Promise.all([orderList(token), positions(token)]);
  const posOf = (sid: string, dir: number) => pos.find((x: Position) => String(x.securityId) === sid && x.netQty && Math.sign(x.netQty) === dir);
  let again = 0;

  // Algo Live entries that filled: their pair goes in (once)
  for (const [sid, w] of [...shared.pending]) {
    const e = ord.find((x) => x.correlationId === w.correlationId);
    if (!e) continue;
    const filled = e.filledQty ?? (e.orderStatus === 'TRADED' ? e.quantity : 0);
    if (!filled) { if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(e.orderStatus)) { shared.pending.delete(sid); log(`entry ${w.symbol}: ${e.orderStatus}${e.omsErrorDescription ? ` (${e.omsErrorDescription})` : ''}, no stop needed`); } continue; }
    const p = posOf(sid, w.side === 'SELL' ? -1 : 1);
    shared.pending.delete(sid); // before placing: a second sync must never place a second pair
    await placePair(token, { securityId: sid, side: w.side === 'SELL' ? 'BUY' : 'SELL', qty: p ? Math.abs(p.netQty) : filled, stop: w.stop, target: w.target, productType: e.productType, why: `Algo Live ${w.symbol} entry filled ${filled}` });
    again = Math.max(again, FRESH_MS);
  }

  // every stock with a pair still working
  // (and every stock a pair was placed on, until cleaned up: when its stop or target FILLED nothing of ours is open
  // any more, but an older super order's leg on that stock may still be)
  const sids = new Set([...ord.filter((x) => isOurStop(x) || isOurTarget(x)).map((x) => String(x.securityId)), ...shared.pairAt.keys()]);
  for (const sid of sids) {
    if (shared.exiting.has(sid)) continue;
    const stops = ord.filter((x) => String(x.securityId) === sid && isOurStop(x));
    const tgts = ord.filter((x) => String(x.securityId) === sid && isOurTarget(x));
    const first = stops[0] ?? tgts[0];
    const p = first ? posOf(sid, first.transactionType === 'BUY' ? -1 : 1) : pos.find((x: Position) => String(x.securityId) === sid && x.netQty);
    try {
      if (!p) {
        const age = Date.now() - (shared.pairAt.get(sid) ?? 0);
        if (age < FRESH_MS && first) { again = Math.max(again, FRESH_MS - age + 500); continue; }
        // flat: one exit filled (or he closed it), so the other must go, or it could open a new position later
        const gone: string[] = [];
        for (const x of [...stops, ...tgts]) if (await once(`cancel:${x.orderId}`, `pair ${sid}: cancel ${x.orderId}`, () => cancelOrder(token, x.orderId))) gone.push(x.orderId);
        // a super order's leg on the same stock (a pair added to an older super-order trade) must go too
        const finished = new Set(ord.filter((x) => ['CANCELLED', 'TRADED', 'REJECTED', 'EXPIRED', 'CLOSED'].includes(x.orderStatus)).map((x) => String(x.orderId)));
        for (const so of (await superOrders(token)).filter((x) => String(x.securityId) === sid)) {
          for (const l of so.legDetails ?? []) {
            const key = `${so.orderId}:${l.legName}`;
            if (!OPEN.includes(l.orderStatus) || (l.legName !== 'TARGET_LEG' && l.legName !== 'STOP_LOSS_LEG') || shared.goneLegs.has(key) || (l.orderId && finished.has(String(l.orderId)))) continue;
            if (await once(`cancel:${key}`, `pair ${sid}: cancel super ${l.legName}`, () => cancelLeg(token, so.orderId, l.legName as 'TARGET_LEG' | 'STOP_LOSS_LEG'))) { markGone(key); gone.push(`super ${l.legName}`); }
          }
        }
        if (gone.length) log(`pair ${sid}: position closed, cancelled ${gone.join(' and ')}`);
        shared.slm.delete(sid); shared.pairAt.delete(sid);
        continue;
      }
      const qty = Math.abs(p.netQty);
      await fitQty(token, sid, 'stop', stops, qty);
      await fitQty(token, sid, 'target', tgts, qty);
    } catch (e) { log(`pair ${sid}: ${(e as Error).message}`); }
  }
  return again;
}

/** one sync at a time (the stream and a fresh Algo Live entry can both ask) */
const g = globalThis as unknown as { __tePairs?: Promise<number> };
export function syncPairs(token: string): Promise<number> {
  const run = (g.__tePairs ?? Promise.resolve(0)).catch(() => 0).then(() => syncOnce(token));
  g.__tePairs = run;
  return run;
}
