import { cancelLeg, cancelOrder, limitOrder, ltps, marketOrder, modifyOrder, modifySuperLeg, orderList, positions, superOrders, type PlainOrder, type Position, type SuperOrder } from './dhanBot';
import { istNow, log, shared } from './te';

/**
 * One stock's orders and position, for tradereye's chart buttons (Flatten, Clear all, Break-even, dragging an order line)
 * and for the stop guard (src/lib/stopGuard.ts). The chart buttons act on EVERY order of that one stock, the ones placed
 * by hand included: they only run when he presses a button on that stock's chart. Nothing here opens a new position.
 *
 * Why exits are LIMIT orders that chase: since March 2026 Dhan sends no API order to the exchange as a pure market order.
 * A market order (and a super order's triggered stop leg) becomes a LIMIT at a "market price protection" price, and in a
 * fast move that limit is left behind, unfilled, while the loss grows. So an exit here is a limit priced through the
 * market (CHASE_PCT beyond the last price: it fills at once at the best price there is), re-priced until the position
 * is flat.
 */

export const OPEN = ['PENDING', 'TRANSIT', 'PART_TRADED', 'TRIGGERED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** how far through the last price an exit limit is priced (%), so it fills at once */
const CHASE_PCT = Number(process.env.EXIT_CHASE_PCT ?? 2);

/** a working order as the chart draws it */
export interface Working {
  /** 'super:<orderId>:<leg>' or 'order:<orderId>' */
  id: string;
  role: 'stop' | 'target' | 'entry' | 'limit';
  side: 'BUY' | 'SELL'; qty: number; price: number; status: string; byBot: boolean;
}
export interface Book {
  securityId: string;
  position: { netQty: number; avgPrice: number; productType: string; realized: number; unrealized: number } | null;
  working: Working[];
}

export interface Loaded { supers: SuperOrder[]; plain: PlainOrder[]; all: PlainOrder[]; pos: Position[] }

/** one stock out of the account's lists (fetched once: the stop guard reads every stock from one fetch) */
export function pick(securityId: string, sup: SuperOrder[], ord: PlainOrder[], pos: Position[]): Loaded {
  const supers = sup.filter((o) => String(o.securityId) === securityId);
  // a super order's legs can also show up in the plain order list: the chart handles them through the super order
  const superIds = new Set<string>();
  for (const o of supers) { superIds.add(String(o.orderId)); for (const l of o.legDetails ?? []) if (l.orderId) superIds.add(String(l.orderId)); }
  const all = ord.filter((o) => String(o.securityId) === securityId && OPEN.includes(o.orderStatus));
  const plain = all.filter((o) => !superIds.has(String(o.orderId)));
  const p = pos.filter((x) => String(x.securityId) === securityId && x.netQty);
  return { supers, plain, all, pos: p };
}

async function load(token: string, securityId: string): Promise<Loaded> {
  const [sup, ord, pos] = await Promise.all([superOrders(token), orderList(token), positions(token)]);
  return pick(securityId, sup, ord, pos);
}

export function bookOf(securityId: string, { supers, plain, pos }: Loaded): Book {
  const working: Working[] = [];
  for (const o of supers) {
    const bot = (o.correlationId ?? '').startsWith('te-');
    const exit: 'BUY' | 'SELL' = o.transactionType === 'SELL' ? 'BUY' : 'SELL';
    if (OPEN.includes(o.orderStatus)) working.push({ id: `super:${o.orderId}:ENTRY_LEG`, role: 'entry', side: o.transactionType as 'BUY' | 'SELL', qty: o.quantity, price: o.price ?? 0, status: o.orderStatus, byBot: bot });
    for (const l of o.legDetails ?? []) {
      if (!OPEN.includes(l.orderStatus) || (l.legName !== 'STOP_LOSS_LEG' && l.legName !== 'TARGET_LEG')) continue;
      working.push({ id: `super:${o.orderId}:${l.legName}`, role: l.legName === 'STOP_LOSS_LEG' ? 'stop' : 'target', side: exit, qty: o.filledQty || o.quantity, price: l.price, status: l.orderStatus, byBot: bot });
    }
  }
  for (const o of plain) {
    const stop = /STOP_LOSS/.test(o.orderType);
    working.push({ id: `order:${o.orderId}`, role: stop ? 'stop' : 'limit', side: o.transactionType as 'BUY' | 'SELL', qty: o.remainingQuantity || o.quantity, price: (stop ? o.triggerPrice : o.price) ?? 0, status: o.orderStatus, byBot: (o.correlationId ?? '').startsWith('te-') });
  }
  const p = pos[0] as (typeof pos)[number] & { buyAvg?: number; sellAvg?: number; costPrice?: number } | undefined;
  return {
    securityId,
    position: p ? { netQty: p.netQty, avgPrice: Number(p.netQty > 0 ? p.buyAvg ?? p.costPrice : p.sellAvg ?? p.costPrice) || 0, productType: p.productType, realized: p.realizedProfit ?? 0, unrealized: p.unrealizedProfit ?? 0 } : null,
    working,
  };
}

export async function book(token: string, securityId: string): Promise<Book> {
  return bookOf(securityId, await load(token, securityId));
}

/** a super order's leg (or entry) that can still fill */
const liveLeg = (o: SuperOrder) => OPEN.includes(o.orderStatus) || (o.legDetails ?? []).some((l) => OPEN.includes(l.orderStatus) && l.legName !== 'ENTRY_LEG');
/** anything of this stock that could still fill */
const anyLive = (x: Loaded) => x.supers.some(liveLeg) || x.all.length > 0;

/** one round of cancels: super legs, and every open plain order of the stock (a triggered stop leg's exchange order too) */
async function cancelRound(token: string, x: Loaded): Promise<string[]> {
  const errors: string[] = [];
  for (const o of x.supers) {
    if (OPEN.includes(o.orderStatus)) { try { await cancelLeg(token, o.orderId, 'ENTRY_LEG'); } catch (e) { errors.push(`entry ${o.orderId}: ${(e as Error).message}`); } }
    for (const l of o.legDetails ?? []) {
      if (!OPEN.includes(l.orderStatus) || (l.legName !== 'TARGET_LEG' && l.legName !== 'STOP_LOSS_LEG')) continue;
      try { await cancelLeg(token, o.orderId, l.legName); }
      catch (e) {
        // a triggered leg already sits at the exchange as its own order: cancel that
        if (l.orderId) { try { await cancelOrder(token, String(l.orderId)); continue; } catch { /* reported below */ } }
        errors.push(`${l.legName}: ${(e as Error).message}`);
      }
    }
  }
  for (const o of x.all) { try { await cancelOrder(token, o.orderId); } catch (e) { errors.push(`order ${o.orderId}: ${(e as Error).message}`); } }
  return errors;
}

/**
 * Cancels every working order of the stock and waits until Dhan shows none (up to ~8 s, cancelling again each round:
 * Dhan takes a moment to show a cancel). Returns what is left and the last errors.
 */
async function cancelAll(token: string, securityId: string): Promise<{ left: Loaded; errors: string[] }> {
  let x = await load(token, securityId), errors: string[] = [];
  for (let round = 0; round < 4 && anyLive(x); round++) {
    errors = await cancelRound(token, x);
    for (let k = 0; k < 4; k++) { await sleep(500); x = await load(token, securityId); if (!anyLive(x)) break; }
  }
  return { left: x, errors: anyLive(x) ? errors : [] };
}

const tick = 0.05;
/** an exit price through the market: it fills at once at the best price, up to CHASE_PCT away */
export const throughPrice = (ltp: number, side: 'BUY' | 'SELL') =>
  side === 'BUY' ? Math.ceil((ltp * (1 + CHASE_PCT / 100)) / tick) * tick : Math.max(tick, Math.floor((ltp * (1 - CHASE_PCT / 100)) / tick) * tick);

/**
 * Closes the stock's position NOW: cancels every working order (and waits until they are gone: a live stop / target
 * left behind could open a new position the other way), then sends a limit priced through the market, and re-sends
 * it at the new price until the position is flat (about 20 s at most). Shared by Flatten and the stop guard.
 */
export async function exitNow(token: string, securityId: string, why: string): Promise<{ done: string[]; errors: string[] }> {
  if (shared.exiting.has(securityId)) return { done: [], errors: ['already being closed'] };
  shared.exiting.add(securityId);
  const done: string[] = [], errors: string[] = [];
  const date = istNow().date.replace(/-/g, '');
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { left, errors: cancelErrors } = await cancelAll(token, securityId);
      const p = left.pos[0];
      if (!p) { done.push(attempt === 0 ? 'no open position' : 'closed'); errors.length = 0; break; }
      if (anyLive(left)) {
        const what = [...left.all.map((o) => `${o.orderType} ${o.transactionType} ${o.orderId} (${o.orderStatus})`), ...left.supers.filter(liveLeg).map((o) => `super ${o.orderId}`)].join(', ');
        errors.push(`could not cancel ${what}${cancelErrors.length ? `: ${cancelErrors.join('; ')}` : ''}. The position was NOT closed (an order left live could open a new one): close it in Dhan`);
        break;
      }
      const side: 'BUY' | 'SELL' = p.netQty < 0 ? 'BUY' : 'SELL', qty = Math.abs(p.netQty);
      const ltp = (await ltps(token, [securityId]).catch(() => new Map<string, number>())).get(securityId);
      const correlationId = `tx-${date}-${securityId}-${attempt}-${Date.now() % 1000}`.slice(0, 30);
      try {
        if (ltp) await limitOrder(token, { securityId, side, qty, price: Number(throughPrice(ltp, side).toFixed(2)), productType: p.productType, correlationId });
        else await marketOrder(token, { securityId, side, qty, productType: p.productType, correlationId });
      } catch (e) { errors.push(`exit order refused: ${(e as Error).message}`); }
      // flat yet? (checked every half second for ~2.5 s, then the leftover is cancelled and re-priced)
      let flat = false;
      for (let k = 0; k < 5 && !flat; k++) { await sleep(500); flat = !(await positions(token)).some((x) => String(x.securityId) === securityId && x.netQty); }
      if (flat) { done.push(`${side === 'BUY' ? 'bought back' : 'sold'} ${qty}${ltp ? ` (limit through ${ltp})` : ' at market'}`); errors.length = 0; break; }
      if (attempt === 7) errors.push('still open after ~25 s of exit orders: close it in Dhan');
    }
  } finally { shared.exiting.delete(securityId); }
  shared.guard.delete(securityId);
  log(`exit ${securityId} (${why}): ${done.join(', ') || 'nothing closed'}${errors.length ? ` · errors: ${errors.join('; ')}` : ''}`);
  return { done, errors };
}

/** Clear all: cancel every working order of the stock (the position, if any, is left as it is) */
export async function clearAll(token: string, securityId: string) {
  const { left, errors } = await cancelAll(token, securityId);
  // he took the stop away himself: the stop guard forgets it, and an Algo Live SL-M is not put back
  shared.guard.delete(securityId);
  if (shared.slm.has(securityId)) shared.slm.set(securityId, 0);
  log(`clear all ${securityId}${errors.length ? ` · errors: ${errors.join('; ')}` : ''}`);
  return { errors, book: bookOf(securityId, left) };
}

/** Flatten: cancel every working order of the stock, wait until they are gone, then close the position (chasing the price) */
export async function flatten(token: string, securityId: string) {
  const r = await exitNow(token, securityId, 'Flatten');
  await sleep(500);
  return { ...r, book: await book(token, securityId) };
}

/** move one working order (a dragged line, or break-even) */
export async function moveOrder(token: string, securityId: string, id: string, price: number) {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error('bad price');
  const p = Math.round(price * 20) / 20; // NSE tick 0.05
  const [kind, orderId, leg] = id.split(':');
  if (kind === 'super') {
    if (leg !== 'STOP_LOSS_LEG' && leg !== 'TARGET_LEG') throw new Error('only a stop or target leg can be moved');
    const { supers } = await load(token, securityId);
    if (!supers.some((o) => String(o.orderId) === orderId)) throw new Error('that order is not on this stock');
    await modifySuperLeg(token, orderId, leg, p);
    if (leg === 'STOP_LOSS_LEG') { const m = shared.guard.get(securityId); if (m) { m.stop = p; m.beyondSince = null; } }
  } else if (kind === 'order') {
    const { plain } = await load(token, securityId);
    const o = plain.find((x) => String(x.orderId) === orderId);
    if (!o) throw new Error('that order is not open on this stock any more');
    await modifyOrder(token, o, p);
    if (/STOP_LOSS/.test(o.orderType)) { const m = shared.guard.get(securityId); if (m) { m.stop = p; m.beyondSince = null; } }
  } else throw new Error('unknown order');
  log(`move ${id} (${securityId}) to ${p}`);
  await sleep(600);
  return { book: await book(token, securityId) };
}

/** cancel one working order (the ✕ on its line) */
export async function cancelOne(token: string, securityId: string, id: string) {
  const [kind, orderId, leg] = id.split(':');
  const { supers, plain } = await load(token, securityId);
  if (kind === 'super') {
    if (!supers.some((o) => String(o.orderId) === orderId)) throw new Error('that order is not on this stock');
    await cancelLeg(token, orderId, leg as 'ENTRY_LEG' | 'TARGET_LEG' | 'STOP_LOSS_LEG');
    if (leg === 'STOP_LOSS_LEG') shared.guard.delete(securityId); // he took the stop away: the stop guard forgets it
  } else {
    const o = plain.find((x) => String(x.orderId) === orderId);
    if (!o) throw new Error('that order is not open on this stock any more');
    await cancelOrder(token, orderId);
    if (/STOP_LOSS/.test(o.orderType)) { shared.guard.delete(securityId); if (shared.slm.has(securityId)) shared.slm.set(securityId, 0); }
  }
  log(`cancel ${id} (${securityId})`);
  await sleep(600);
  return { book: await book(token, securityId) };
}
