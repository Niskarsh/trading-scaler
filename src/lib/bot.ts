import { BOT_PREFIX, cancelLeg, marketOrder, placeShort, positions, superOrders, type SuperOrder } from './dhanBot';
import { istNow, log, shared } from './te';

/**
 * The tradereye bot's orders, with the server's own guards (whatever tradereye asks):
 *  - at most BOT_MAX_PER_DAY (default 2) bot orders a day, counted from Dhan's own order list (rejected / cancelled
 *    before filling do not count), never the same correlationId twice;
 *  - only between BOT_FROM (09:30) and BOT_TO (11:05) IST, only shorts, only INTRADAY, each position at most
 *    BOT_MAX_NOTIONAL (₹75,000) of stock;
 *  - whatever is still open at 15:15 is closed (src/instrumentation.ts), and on demand.
 */

export const MAX_PER_DAY = Number(process.env.BOT_MAX_PER_DAY ?? 2);
const MAX_NOTIONAL = Number(process.env.BOT_MAX_NOTIONAL ?? 75_000);
const hm = (s: string | undefined, d: number) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : d; };
const FROM = hm(process.env.BOT_FROM, 9 * 60 + 30), TO = hm(process.env.BOT_TO, 11 * 60 + 5);
const OPEN = ['PENDING', 'TRANSIT', 'PART_TRADED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BotOrder { symbol: string; securityId: string; qty: number; targetPrice: number; stopLossPrice: number; correlationId: string }

const isBot = (o: SuperOrder) => (o.correlationId ?? '').startsWith(BOT_PREFIX);
const counts = (o: SuperOrder) => !['REJECTED', 'CANCELLED'].includes(o.orderStatus) || (o.filledQty ?? 0) > 0;

export async function place(token: string, orders: BotOrder[]) {
  const now = istNow();
  const placed: { symbol: string; correlationId: string; orderId?: string; orderStatus?: string; error?: string }[] = [];
  if (now.min < FROM || now.min > TO) return orders.map((o) => ({ symbol: o.symbol, correlationId: o.correlationId, error: `outside the bot's hours (${process.env.BOT_FROM ?? '09:30'}-${process.env.BOT_TO ?? '11:05'} IST)` }));
  const today = (await superOrders(token)).filter(isBot);
  let used = today.filter(counts).length;
  for (const o of orders) {
    const r = { symbol: o.symbol, correlationId: o.correlationId };
    const dup = today.find((x) => x.correlationId === o.correlationId);
    if (dup) { placed.push({ ...r, orderId: dup.orderId, orderStatus: dup.orderStatus, error: dup.orderStatus === 'REJECTED' ? dup.omsErrorDescription ?? 'rejected' : undefined }); continue; }
    if (!o.correlationId.startsWith(BOT_PREFIX) || o.correlationId.length > 30) { placed.push({ ...r, error: 'bad correlationId' }); continue; }
    if (!(o.qty > 0 && Number.isInteger(o.qty)) || !(o.stopLossPrice > o.targetPrice) || o.targetPrice <= 0) { placed.push({ ...r, error: 'bad order (qty, stop above target for a short)' }); continue; }
    if (o.qty * o.stopLossPrice > MAX_NOTIONAL) { placed.push({ ...r, error: `position ₹${Math.round(o.qty * o.stopLossPrice)} is above BOT_MAX_NOTIONAL ₹${MAX_NOTIONAL}` }); continue; }
    if (used >= MAX_PER_DAY) { placed.push({ ...r, error: `the day's ${MAX_PER_DAY} bot orders are taken` }); continue; }
    try {
      const x = await placeShort(token, o);
      used++;
      log(`placed ${o.symbol} short ${o.qty} stop ${o.stopLossPrice} target ${o.targetPrice} -> ${x.orderId} ${x.orderStatus}`);
      placed.push({ ...r, orderId: x.orderId, orderStatus: x.orderStatus, error: x.orderStatus === 'REJECTED' ? 'rejected by Dhan' : undefined });
    } catch (e) {
      log(`place ${o.symbol} failed: ${(e as Error).message}`);
      placed.push({ ...r, error: (e as Error).message });
    }
  }
  return placed;
}

export async function status(token: string) {
  const [list, pos] = await Promise.all([superOrders(token), positions(token)]);
  const bot = list.filter(isBot);
  const ids = new Set(bot.map((o) => String(o.securityId)));
  return {
    orders: bot.map((o) => ({
      orderId: o.orderId, correlationId: o.correlationId ?? '', symbol: o.tradingSymbol ?? '', orderStatus: o.orderStatus, qty: o.quantity, filledQty: o.filledQty ?? 0,
      avgPrice: o.averageTradedPrice ?? 0, legs: (o.legDetails ?? []).map((l) => ({ legName: l.legName, orderStatus: l.orderStatus, price: l.price })), error: o.orderStatus === 'REJECTED' ? o.omsErrorDescription : undefined,
    })),
    positions: pos.filter((p) => ids.has(String(p.securityId)) && p.productType === 'INTRADAY').map((p) => ({ symbol: p.tradingSymbol ?? '', securityId: String(p.securityId), netQty: p.netQty, realized: p.realizedProfit ?? 0, unrealized: p.unrealizedProfit ?? 0 })),
    squaredOffAt: shared.squaredOff, maxPerDay: MAX_PER_DAY,
  };
}

/**
 * Closes every bot position: cancels entries not filled yet, cancels the stop and target of filled ones, checks they are
 * gone, then buys back what is still short at market. A position whose stop or target could not be cancelled is left
 * alone (buying it back would leave a live stop that could open a new position): it is reported instead.
 */
export async function squareOff(token: string, why: string): Promise<{ done: string[]; errors: string[] }> {
  if (shared.squaring) return { done: [], errors: ['a square-off is already running'] };
  shared.squaring = true;
  const done: string[] = [], errors: string[] = [];
  try {
    log(`square-off (${why})`);
    const bot = (await superOrders(token)).filter(isBot);
    for (const o of bot) {
      try {
        if (OPEN.includes(o.orderStatus)) { await cancelLeg(token, o.orderId, 'ENTRY_LEG'); continue; }
        if (o.orderStatus === 'TRADED') for (const l of o.legDetails ?? []) if (OPEN.includes(l.orderStatus) && (l.legName === 'TARGET_LEG' || l.legName === 'STOP_LOSS_LEG')) {
          try { await cancelLeg(token, o.orderId, l.legName); } catch (e) { errors.push(`${o.tradingSymbol} ${l.legName}: ${(e as Error).message}`); }
        }
      } catch (e) { errors.push(`${o.tradingSymbol}: ${(e as Error).message}`); }
    }
    await sleep(1500);
    const again = (await superOrders(token)).filter(isBot);
    const stuck = new Set(again.filter((o) => OPEN.includes(o.orderStatus) || (o.legDetails ?? []).some((l) => OPEN.includes(l.orderStatus))).map((o) => String(o.securityId)));
    const ids = new Set(again.map((o) => String(o.securityId)));
    const date = istNow().date.replace(/-/g, '');
    for (const p of await positions(token)) {
      const id = String(p.securityId);
      if (!ids.has(id) || p.productType !== 'INTRADAY' || !p.netQty) continue;
      if (stuck.has(id)) { errors.push(`${p.tradingSymbol}: its stop / target is still live, not closed (close it in Dhan)`); continue; }
      try {
        await marketOrder(token, { securityId: id, side: p.netQty < 0 ? 'BUY' : 'SELL', qty: Math.abs(p.netQty), correlationId: `te-x-${date}-${id}`.slice(0, 30) });
        done.push(`${p.tradingSymbol ?? id} ${p.netQty < 0 ? 'bought back' : 'sold'} ${Math.abs(p.netQty)}`);
      } catch (e) { errors.push(`${p.tradingSymbol}: ${(e as Error).message}`); }
    }
    shared.squaredOff = new Date().toISOString();
    log(`square-off done: ${done.join(', ') || 'nothing open'}${errors.length ? ` · errors: ${errors.join('; ')}` : ''}`);
    return { done, errors };
  } finally { shared.squaring = false; }
}
