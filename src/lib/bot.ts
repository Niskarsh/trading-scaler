import { BOT_PREFIX, cancelLeg, cancelOrder, marketOrder, orderList, placeShort, positions, superOrders, type PlainOrder, type SuperOrder } from './dhanBot';
import { exitNow } from './symbolOrders';
import { syncSoon } from './orderStream';
import { syncPairs } from './slmStops';
import { istNow, log, shared } from './te';

/**
 * The tradereye bot's orders, with the server's own guards (whatever tradereye asks):
 *  - at most BOT_MAX_PER_DAY (default 2) bot orders a day, counted from Dhan's own order list (rejected / cancelled
 *    before filling do not count), never the same correlationId twice;
 *  - only between BOT_FROM (09:30) and BOT_TO (11:05) IST, only shorts, only INTRADAY, each position at most
 *    BOT_MAX_NOTIONAL (₹75,000) of stock;
 *  - whatever is still open at 15:15 is closed (src/instrumentation.ts), and on demand.
 *
 * How a trade is placed (13 Nov 2026 on): a plain market entry; once it fills, its stop (a stop-limit at the exchange,
 * its limit STOP_LIMIT_BUFFER_PCT past the trigger) and target (a LIMIT) go in as a pair that cancel each other
 * (src/lib/slmStops.ts: looked at straight after the entry, on Dhan's order-stream messages, and every 20 s from Dhan
 * directly while a trade is managed, so a dropped stream only slows it). A super order's stop leg goes out as a limit
 * Dhan prices itself, which a fast move left unfilled. BOT_ORDERS=super goes back to super orders.
 */

export const MAX_PER_DAY = Number(process.env.BOT_MAX_PER_DAY ?? 2);
const MAX_NOTIONAL = Number(process.env.BOT_MAX_NOTIONAL ?? 75_000);
const hm = (s: string | undefined, d: number) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : d; };
const FROM = hm(process.env.BOT_FROM, 9 * 60 + 30), TO = hm(process.env.BOT_TO, 11 * 60 + 5);
const OPEN = ['PENDING', 'TRANSIT', 'PART_TRADED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BotOrder { symbol: string; securityId: string; qty: number; targetPrice: number; stopLossPrice: number; correlationId: string }

const isBot = (o: SuperOrder) => (o.correlationId ?? '').startsWith(BOT_PREFIX);
const counts = (o: { orderStatus: string; filledQty?: number }) => !['REJECTED', 'CANCELLED'].includes(o.orderStatus) || (o.filledQty ?? 0) > 0;
/** a bot entry placed as a plain order (te-<date>-<symbol>; te-s / te-t are its stop and target) */
const isBotEntry = (o: PlainOrder) => /^te-\d{8}-/.test(o.correlationId ?? '');

export async function place(token: string, orders: BotOrder[]) {
  const now = istNow();
  const placed: { symbol: string; correlationId: string; orderId?: string; orderStatus?: string; error?: string }[] = [];
  if (now.min < FROM || now.min > TO) return orders.map((o) => ({ symbol: o.symbol, correlationId: o.correlationId, error: `outside the bot's hours (${process.env.BOT_FROM ?? '09:30'}-${process.env.BOT_TO ?? '11:05'} IST)` }));
  const [sup, ord] = await Promise.all([superOrders(token), orderList(token)]);
  const today: { correlationId?: string; orderId: string; orderStatus: string; filledQty?: number; omsErrorDescription?: string }[] = [...sup.filter(isBot), ...ord.filter(isBotEntry)];
  let used = today.filter(counts).length;
  const pairs = !/^super$/i.test(process.env.BOT_ORDERS ?? '');
  for (const o of orders) {
    const r = { symbol: o.symbol, correlationId: o.correlationId };
    const dup = today.find((x) => x.correlationId === o.correlationId);
    if (dup) { placed.push({ ...r, orderId: dup.orderId, orderStatus: dup.orderStatus, error: dup.orderStatus === 'REJECTED' ? dup.omsErrorDescription ?? 'rejected' : undefined }); continue; }
    if (!o.correlationId.startsWith(BOT_PREFIX) || o.correlationId.length > 30) { placed.push({ ...r, error: 'bad correlationId' }); continue; }
    if (!(o.qty > 0 && Number.isInteger(o.qty)) || !(o.stopLossPrice > o.targetPrice) || o.targetPrice <= 0) { placed.push({ ...r, error: 'bad order (qty, stop above target for a short)' }); continue; }
    if (o.qty * o.stopLossPrice > MAX_NOTIONAL) { placed.push({ ...r, error: `position ₹${Math.round(o.qty * o.stopLossPrice)} is above BOT_MAX_NOTIONAL ₹${MAX_NOTIONAL}` }); continue; }
    if (used >= MAX_PER_DAY) { placed.push({ ...r, error: `the day's ${MAX_PER_DAY} bot orders are taken` }); continue; }
    try {
      let x: { orderId: string; orderStatus: string };
      if (pairs) {
        // the stop and target wait for the fill (src/lib/slmStops.ts); registered BEFORE the order goes out
        shared.pending.set(String(o.securityId), { correlationId: o.correlationId, symbol: o.symbol, side: 'SELL', stop: o.stopLossPrice, target: o.targetPrice });
        x = await marketOrder(token, { securityId: o.securityId, side: 'SELL', qty: o.qty, correlationId: o.correlationId });
        syncSoon();
        // a market entry normally fills at once: look straight away rather than wait for the stream
        setTimeout(() => { void syncPairs(token).catch(() => 0); }, 1500);
      } else {
        x = await placeShort(token, o);
        log(`(order stream not connected: ${o.symbol} placed as a super order)`);
      }
      used++;
      log(`placed ${o.symbol} short ${o.qty} stop ${o.stopLossPrice} target ${o.targetPrice} -> ${x.orderId} ${x.orderStatus}`);
      placed.push({ ...r, orderId: x.orderId, orderStatus: x.orderStatus, error: x.orderStatus === 'REJECTED' ? 'rejected by Dhan' : undefined });
    } catch (e) {
      shared.pending.delete(String(o.securityId));
      log(`place ${o.symbol} failed: ${(e as Error).message}`);
      placed.push({ ...r, error: (e as Error).message });
    }
  }
  return placed;
}

export async function status(token: string) {
  const [list, ord, pos] = await Promise.all([superOrders(token), orderList(token), positions(token)]);
  const bot = list.filter(isBot), plain = ord.filter(isBotEntry);
  const ids = new Set([...bot, ...plain].map((o) => String(o.securityId)));
  // a plain entry's stop / target: its te-s / te-t orders on that stock, shown as the legs a super order would have
  const legsOf = (sid: string) => ord.filter((x) => String(x.securityId) === sid && /^te-[st]\d/.test(x.correlationId ?? ''))
    .map((x) => ({ legName: (x.correlationId ?? '').startsWith('te-s') ? 'STOP_LOSS_LEG' : 'TARGET_LEG', orderStatus: x.orderStatus, price: Number((x.correlationId ?? '').startsWith('te-s') ? x.triggerPrice : x.price) || 0 }));
  return {
    orders: [
      ...bot.map((o) => ({
        orderId: o.orderId, correlationId: o.correlationId ?? '', symbol: o.tradingSymbol ?? '', orderStatus: o.orderStatus, qty: o.quantity, filledQty: o.filledQty ?? 0,
        avgPrice: o.averageTradedPrice ?? 0, legs: (o.legDetails ?? []).map((l) => ({ legName: l.legName, orderStatus: l.orderStatus, price: l.price })), error: o.orderStatus === 'REJECTED' ? o.omsErrorDescription : undefined,
      })),
      ...plain.map((o) => ({
        orderId: o.orderId, correlationId: o.correlationId ?? '', symbol: o.tradingSymbol ?? '', orderStatus: o.orderStatus, qty: o.quantity, filledQty: o.filledQty ?? 0,
        avgPrice: o.averageTradedPrice ?? 0, legs: legsOf(String(o.securityId)), error: o.orderStatus === 'REJECTED' ? o.omsErrorDescription : undefined,
      })),
    ],
    positions: pos.filter((p) => ids.has(String(p.securityId)) && p.productType === 'INTRADAY').map((p) => ({ symbol: p.tradingSymbol ?? '', securityId: String(p.securityId), netQty: p.netQty, realized: p.realizedProfit ?? 0, unrealized: p.unrealizedProfit ?? 0 })),
    squaredOffAt: shared.squaredOff, maxPerDay: MAX_PER_DAY,
  };
}

/**
 * Closes every bot position: cancels entries not filled yet, cancels the stop and target of filled ones, then for each
 * bot stock still open cancels every order of that stock (its SL-M and target included) and buys back, chasing the
 * price (symbolOrders exitNow). A position whose orders could not be cancelled is left alone (buying it back would
 * leave a live stop that could open a new position): it is reported instead.
 */
export async function squareOff(token: string, why: string): Promise<{ done: string[]; errors: string[] }> {
  if (shared.squaring) return { done: [], errors: ['a square-off is already running'] };
  shared.squaring = true;
  const done: string[] = [], errors: string[] = [];
  try {
    log(`square-off (${why})`);
    const bot = (await superOrders(token)).filter(isBot);
    // plain Algo Live entries (te-<date>-…): one not filled yet is cancelled, a filled one's stock is closed below
    const plain = (await orderList(token)).filter(isBotEntry);
    for (const o of plain) if (OPEN.includes(o.orderStatus)) { try { await cancelOrder(token, o.orderId); } catch (e) { errors.push(`${o.tradingSymbol} entry: ${(e as Error).message}`); } }
    for (const o of bot) {
      try {
        if (OPEN.includes(o.orderStatus)) { await cancelLeg(token, o.orderId, 'ENTRY_LEG'); continue; }
        if (o.orderStatus === 'TRADED') for (const l of o.legDetails ?? []) if (OPEN.includes(l.orderStatus) && (l.legName === 'TARGET_LEG' || l.legName === 'STOP_LOSS_LEG')) {
          try { await cancelLeg(token, o.orderId, l.legName); } catch (e) { errors.push(`${o.tradingSymbol} ${l.legName}: ${(e as Error).message}`); }
        }
      } catch (e) { errors.push(`${o.tradingSymbol}: ${(e as Error).message}`); }
    }
    await sleep(1500);
    // every bot stock still open: cancel its orders (target, SL-M) and close it, chasing the price (symbolOrders exitNow)
    const ids = new Set([...bot, ...plain].map((o) => String(o.securityId)));
    for (const p of await positions(token)) {
      const id = String(p.securityId);
      if (!ids.has(id) || p.productType !== 'INTRADAY' || !p.netQty) continue;
      const r = await exitNow(token, id, `square-off (${why})`);
      done.push(...r.done.map((d) => `${p.tradingSymbol ?? id} ${d}`));
      errors.push(...r.errors.map((e) => `${p.tradingSymbol ?? id}: ${e}`));
    }
    shared.squaredOff = new Date().toISOString();
    log(`square-off done: ${done.join(', ') || 'nothing open'}${errors.length ? ` · errors: ${errors.join('; ')}` : ''}`);
    return { done, errors };
  } finally { shared.squaring = false; }
}
