import { cancelLeg, cancelOrder, marketOrder, modifyOrder, modifySuperLeg, orderList, positions, superOrders, type PlainOrder, type Position, type SuperOrder } from './dhanBot';
import { istNow, log, markGone, shared } from './te';
import { placePair } from './slmStops';

/**
 * One stock's orders and position, for tradereye's chart buttons (Flatten, Clear all, Break-even, Add stop, dragging an
 * order line). They act on EVERY order of that one stock, the ones placed by hand included, and only when he presses a
 * button on that stock's chart. Only Add stop places new orders (a stop and target for the position already open).
 */

export const OPEN = ['PENDING', 'TRANSIT', 'PART_TRADED', 'TRIGGERED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export interface Loaded { supers: SuperOrder[]; plain: PlainOrder[]; all: PlainOrder[]; pos: Position[]; finished: Set<string> }

/** order-book statuses after which an order can never fill */
const FINAL = ['CANCELLED', 'TRADED', 'REJECTED', 'EXPIRED', 'CLOSED'];
/** is this super-order leg still live? Dhan's super-order list can keep a cancelled leg as PENDING (13 Nov 2026), so the
 * order book (also Dhan's, read at the same moment) and this server's own record of cancels have the last word */
const legLive = (o: SuperOrder, l: { legName: string; orderStatus: string; orderId?: string }, finished: Set<string>) =>
  OPEN.includes(l.orderStatus) && !shared.goneLegs.has(`${o.orderId}:${l.legName}`) && !(l.orderId && finished.has(String(l.orderId)));

/** one stock out of the account's lists */
export function pick(securityId: string, sup: SuperOrder[], ord: PlainOrder[], pos: Position[]): Loaded {
  const supers = sup.filter((o) => String(o.securityId) === securityId);
  // a super order's legs can also show up in the plain order list: the chart handles them through the super order
  const superIds = new Set<string>();
  for (const o of supers) { superIds.add(String(o.orderId)); for (const l of o.legDetails ?? []) if (l.orderId) superIds.add(String(l.orderId)); }
  const all = ord.filter((o) => String(o.securityId) === securityId && OPEN.includes(o.orderStatus));
  const plain = all.filter((o) => !superIds.has(String(o.orderId)));
  const p = pos.filter((x) => String(x.securityId) === securityId && x.netQty);
  // the order book's finished orders: a super leg that is one of them is gone, whatever the super-order list says
  const finished = new Set(ord.filter((o) => String(o.securityId) === securityId && FINAL.includes(o.orderStatus)).map((o) => String(o.orderId)));
  return { supers, plain, all, pos: p, finished };
}

async function load(token: string, securityId: string): Promise<Loaded> {
  const [sup, ord, pos] = await Promise.all([superOrders(token), orderList(token), positions(token)]);
  return pick(securityId, sup, ord, pos);
}

export function bookOf(securityId: string, { supers, plain, pos, finished }: Loaded): Book {
  const working: Working[] = [];
  for (const o of supers) {
    const bot = (o.correlationId ?? '').startsWith('te-');
    const exit: 'BUY' | 'SELL' = o.transactionType === 'SELL' ? 'BUY' : 'SELL';
    if (OPEN.includes(o.orderStatus)) working.push({ id: `super:${o.orderId}:ENTRY_LEG`, role: 'entry', side: o.transactionType as 'BUY' | 'SELL', qty: o.quantity, price: o.price ?? 0, status: o.orderStatus, byBot: bot });
    for (const l of o.legDetails ?? []) {
      if ((l.legName !== 'STOP_LOSS_LEG' && l.legName !== 'TARGET_LEG') || !legLive(o, l, finished)) continue;
      working.push({ id: `super:${o.orderId}:${l.legName}`, role: l.legName === 'STOP_LOSS_LEG' ? 'stop' : 'target', side: exit, qty: o.filledQty || o.quantity, price: l.price, status: l.orderStatus, byBot: bot });
    }
  }
  for (const o of plain) {
    const stop = /STOP_LOSS/.test(o.orderType);
    // an Add-stop target (correlationId te-t…) draws as the TP it is
    const target = !stop && (o.correlationId ?? '').startsWith('te-t');
    working.push({ id: `order:${o.orderId}`, role: stop ? 'stop' : target ? 'target' : 'limit', side: o.transactionType as 'BUY' | 'SELL', qty: o.remainingQuantity || o.quantity, price: (stop ? o.triggerPrice : o.price) ?? 0, status: o.orderStatus, byBot: (o.correlationId ?? '').startsWith('te-') });
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
const liveLeg = (o: SuperOrder, finished: Set<string>) => OPEN.includes(o.orderStatus) || (o.legDetails ?? []).some((l) => l.legName !== 'ENTRY_LEG' && legLive(o, l, finished));
/** anything of this stock that could still fill */
const anyLive = (x: Loaded) => x.supers.some((o) => liveLeg(o, x.finished)) || x.all.length > 0;

/** one round of cancels: super legs, and every open plain order of the stock (a triggered stop leg's exchange order too) */
async function cancelRound(token: string, x: Loaded): Promise<string[]> {
  const errors: string[] = [];
  for (const o of x.supers) {
    if (OPEN.includes(o.orderStatus)) { try { await cancelLeg(token, o.orderId, 'ENTRY_LEG'); } catch (e) { errors.push(`entry ${o.orderId}: ${(e as Error).message}`); } }
    for (const l of o.legDetails ?? []) {
      if ((l.legName !== 'TARGET_LEG' && l.legName !== 'STOP_LOSS_LEG') || !legLive(o, l, x.finished)) continue;
      try { await cancelLeg(token, o.orderId, l.legName); markGone(`${o.orderId}:${l.legName}`); }
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

/**
 * Closes the stock's position NOW: cancels every working order (and waits until Dhan shows them gone: a live stop /
 * target left behind could open a new position the other way), then one market order for what is open. Dhan turns an
 * API market order into a limit with market price protection; if it is still open a moment later, that is reported.
 * Shared by Flatten and the 15:15 square-off.
 */
export async function exitNow(token: string, securityId: string, why: string): Promise<{ done: string[]; errors: string[] }> {
  if (shared.exiting.has(securityId)) return { done: [], errors: ['already being closed'] };
  shared.exiting.add(securityId);
  const done: string[] = [], errors: string[] = [];
  try {
    const { left, errors: cancelErrors } = await cancelAll(token, securityId);
    const p = left.pos[0];
    if (!p) done.push('no open position');
    else if (anyLive(left)) {
      const what = [...left.all.map((o) => `${o.orderType} ${o.transactionType} ${o.orderId} (${o.orderStatus})`), ...left.supers.filter((o) => liveLeg(o, left.finished)).map((o) => `super ${o.orderId}`)].join(', ');
      errors.push(`could not cancel ${what}${cancelErrors.length ? `: ${cancelErrors.join('; ')}` : ''}. The position was NOT closed (an order left live could open a new one): close it in Dhan`);
    } else {
      const side: 'BUY' | 'SELL' = p.netQty < 0 ? 'BUY' : 'SELL', qty = Math.abs(p.netQty);
      const correlationId = `tf-${istNow().date.replace(/-/g, '')}-${securityId}-${Date.now() % 1000}`.slice(0, 30);
      try {
        await marketOrder(token, { securityId, side, qty, productType: p.productType, correlationId });
        await sleep(1500);
        const still = (await positions(token)).find((x) => String(x.securityId) === securityId && x.netQty);
        if (still) errors.push(`market ${side.toLowerCase()} sent, but ${Math.abs(still.netQty)} is still open (Dhan holds API market orders as a protected limit): check it in Dhan`);
        else done.push(`${side === 'BUY' ? 'bought back' : 'sold'} ${qty} at market`);
      } catch (e) { errors.push(`market order refused: ${(e as Error).message}`); }
    }
  } finally { shared.exiting.delete(securityId); }
  shared.slm.delete(securityId);
  log(`exit ${securityId} (${why}): ${done.join(', ') || 'nothing closed'}${errors.length ? ` · errors: ${errors.join('; ')}` : ''}`);
  return { done, errors };
}

/**
 * Add SL / Add TP: for the open position, a stop-limit at `stop` and / or a target LIMIT at `target` (whichever is
 * given: the Charts page and Algo Live page have one button each). Refused, with what is there, when the position
 * already has one of the kind asked for: read from Dhan at the moment of the click (super orders, order book, positions).
 * Placed as a pair with whatever is there (src/lib/slmStops.ts).
 */
export async function addStop(token: string, securityId: string, stop?: number, target?: number) {
  const b = bookOf(securityId, await load(token, securityId));
  const p = b.position;
  if (!p) throw new Error('no open position on this stock');
  const side: 'BUY' | 'SELL' = p.netQty > 0 ? 'SELL' : 'BUY', dir = p.netQty > 0 ? 1 : -1;
  const curStop = b.working.find((w) => w.role === 'stop' && w.side === side);
  const curTarget = b.working.find((w) => w.side === side && (w.role === 'target' || w.role === 'limit'));
  const what = (w: { id: string; price: number }) => `${w.id.startsWith('super:') ? 'a super-order leg' : 'an order'} at ${w.price}`;
  const ifGone = 'if Dhan shows none, press ✕ on its line on the chart first';
  const wantStop = stop && stop > 0 ? stop : undefined, wantTarget = target && target > 0 ? target : undefined;
  if (!wantStop && !wantTarget) throw new Error('no price given');
  if (wantStop && curStop) throw new Error(`this position already has a stop (${what(curStop)}): ${ifGone}`);
  if (wantTarget && curTarget) throw new Error(`this position already has a target (${what(curTarget)}): ${ifGone}`);
  // the target must be on the profit side of the stop (the one placed now, or the one already there)
  const s0 = wantStop ?? curStop?.price, t0 = wantTarget ?? curTarget?.price;
  if (s0 && t0 && (dir > 0 ? !(t0 > s0) : !(t0 < s0))) throw new Error(`the target ${t0} is on the wrong side of the stop ${s0}`);
  const r = await placePair(token, { securityId, side, qty: Math.abs(p.netQty), stop: wantStop, target: wantTarget, productType: p.productType, why: wantStop && wantTarget ? 'Add SL + TP' : wantStop ? 'Add SL' : 'Add TP' });
  await sleep(600);
  return { ...r, book: await book(token, securityId) };
}

/** Clear all: cancel every working order of the stock (the position, if any, is left as it is) */
export async function clearAll(token: string, securityId: string) {
  const { left, errors } = await cancelAll(token, securityId);
  // he took the stop away himself: an Algo Live SL-M is not put back
  if (shared.slm.has(securityId)) shared.slm.set(securityId, 0);
  log(`clear all ${securityId}${errors.length ? ` · errors: ${errors.join('; ')}` : ''}`);
  return { errors, book: bookOf(securityId, left) };
}

/** Flatten: cancel every working order of the stock, wait until they are gone, then close the position at market */
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
  } else if (kind === 'order') {
    const { plain } = await load(token, securityId);
    const o = plain.find((x) => String(x.orderId) === orderId);
    if (!o) throw new Error('that order is not open on this stock any more');
    await modifyOrder(token, o, p);
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
    const so = supers.find((o) => String(o.orderId) === orderId);
    if (!so) throw new Error('that order is not on this stock');
    try { await cancelLeg(token, orderId, leg as 'ENTRY_LEG' | 'TARGET_LEG' | 'STOP_LOSS_LEG'); }
    catch (e) {
      // Dhan refuses to cancel a leg it still lists as PENDING when it is already cancelled (13 Nov 2026): it is gone.
      // A TRIGGERED leg (at the exchange) is never treated so.
      const l = (so.legDetails ?? []).find((x) => x.legName === leg);
      if (!(l && l.orderStatus === 'PENDING' && /cancel/i.test((e as Error).message))) throw e;
      log(`cancel ${id}: Dhan says it cannot be cancelled while listing it PENDING: it is no longer live, taken off the chart`);
    }
    markGone(`${orderId}:${leg}`);
  } else {
    const o = plain.find((x) => String(x.orderId) === orderId);
    if (!o) throw new Error('that order is not open on this stock any more');
    await cancelOrder(token, orderId);
    if (/STOP_LOSS/.test(o.orderType) && shared.slm.has(securityId)) shared.slm.set(securityId, 0); // he removed it: not put back
  }
  log(`cancel ${id} (${securityId})`);
  await sleep(600);
  return { book: await book(token, securityId) };
}
