import { cancelLeg, cancelOrder, marketOrder, modifyOrder, modifySuperLeg, orderList, positions, superOrders, type PlainOrder, type SuperOrder } from './dhanBot';
import { istNow, log } from './te';

/**
 * One stock's orders and position, for tradereye's chart buttons (Flatten, Clear all, Break-even, dragging an order line).
 * Unlike the bot's own square-off, these act on EVERY order of that one stock, the ones placed by hand included: they
 * only run when he presses a button on that stock's chart (and confirms). Nothing here places a new position.
 */

const OPEN = ['PENDING', 'TRANSIT', 'PART_TRADED', 'TRIGGERED'];
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

async function load(token: string, securityId: string) {
  const [sup, ord, pos] = await Promise.all([superOrders(token), orderList(token), positions(token)]);
  const supers = sup.filter((o) => String(o.securityId) === securityId);
  // a super order's legs can also show up in the plain order list: they are handled through the super order
  const superIds = new Set<string>();
  for (const o of supers) { superIds.add(String(o.orderId)); for (const l of o.legDetails ?? []) if (l.orderId) superIds.add(String(l.orderId)); }
  const plain = ord.filter((o) => String(o.securityId) === securityId && !superIds.has(String(o.orderId)) && OPEN.includes(o.orderStatus));
  const p = pos.filter((x) => String(x.securityId) === securityId && x.netQty);
  return { supers, plain, pos: p };
}

export async function book(token: string, securityId: string): Promise<Book> {
  const { supers, plain, pos } = await load(token, securityId);
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

async function cancelEverything(token: string, supers: SuperOrder[], plain: PlainOrder[]): Promise<string[]> {
  const errors: string[] = [];
  for (const o of supers) {
    try {
      if (OPEN.includes(o.orderStatus)) { await cancelLeg(token, o.orderId, 'ENTRY_LEG'); continue; }
      for (const l of o.legDetails ?? []) if (OPEN.includes(l.orderStatus) && (l.legName === 'TARGET_LEG' || l.legName === 'STOP_LOSS_LEG')) {
        try { await cancelLeg(token, o.orderId, l.legName); } catch (e) { errors.push(`${l.legName}: ${(e as Error).message}`); }
      }
    } catch (e) { errors.push(`super order ${o.orderId}: ${(e as Error).message}`); }
  }
  for (const o of plain) { try { await cancelOrder(token, o.orderId); } catch (e) { errors.push(`order ${o.orderId}: ${(e as Error).message}`); } }
  return errors;
}

/** Clear all: cancel every working order of the stock (the position, if any, is left as it is) */
export async function clearAll(token: string, securityId: string) {
  const { supers, plain } = await load(token, securityId);
  const errors = await cancelEverything(token, supers, plain);
  log(`clear all ${securityId}: ${supers.length + plain.length} order(s)${errors.length ? ` · errors: ${errors.join('; ')}` : ''}`);
  await sleep(800);
  return { errors, book: await book(token, securityId) };
}

/**
 * Flatten: cancel every working order of the stock, check they are gone, then close the position at market. If a stop
 * or target is still live it does NOT close (the live stop could then open a new position the other way): it reports it.
 */
export async function flatten(token: string, securityId: string) {
  const first = await load(token, securityId);
  const errors = await cancelEverything(token, first.supers, first.plain);
  await sleep(1500);
  const again = await load(token, securityId);
  const live = again.supers.some((o) => OPEN.includes(o.orderStatus) || (o.legDetails ?? []).some((l) => OPEN.includes(l.orderStatus) && l.legName !== 'ENTRY_LEG')) || again.plain.length > 0;
  const done: string[] = [];
  if (live) errors.push('a stop / target is still live, so the position was not closed: try again or close it in Dhan');
  else {
    const date = istNow().date.replace(/-/g, '');
    for (const p of again.pos) {
      try {
        await marketOrder(token, { securityId, side: p.netQty < 0 ? 'BUY' : 'SELL', qty: Math.abs(p.netQty), productType: p.productType, correlationId: `tf-${date}-${securityId}-${Date.now() % 100000}`.slice(0, 30) });
        done.push(`${p.netQty < 0 ? 'bought back' : 'sold'} ${Math.abs(p.netQty)} at market`);
      } catch (e) { errors.push((e as Error).message); }
    }
  }
  log(`flatten ${securityId}: ${done.join(', ') || 'nothing closed'}${errors.length ? ` · errors: ${errors.join('; ')}` : ''}`);
  await sleep(800);
  return { done, errors, book: await book(token, securityId) };
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
    if (!supers.some((o) => String(o.orderId) === orderId)) throw new Error('that order is not on this stock');
    await cancelLeg(token, orderId, leg as 'ENTRY_LEG' | 'TARGET_LEG' | 'STOP_LOSS_LEG');
  } else {
    if (!plain.some((o) => String(o.orderId) === orderId)) throw new Error('that order is not open on this stock any more');
    await cancelOrder(token, orderId);
  }
  log(`cancel ${id} (${securityId})`);
  await sleep(600);
  return { book: await book(token, securityId) };
}
