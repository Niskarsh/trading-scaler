import { BOT_PREFIX, cancelLeg, cancelOrder, modifyOrder, orderList, positions, slmOrder, superOrders, type PlainOrder, type Position, type SuperOrder } from './dhanBot';
import { istNow, log, shared } from './te';

/**
 * Stops as real SL-M orders, and the one-cancels-the-other that goes with them. Runs only when Dhan's order stream says
 * an order changed (src/lib/orderStream.ts): no polling, so it costs REST calls only when something actually happens.
 *
 * 1. Algo Live trades: a super order's stop leg waits on Dhan's server and, when hit, goes out as a LIMIT that a fast move
 *    leaves behind (13 Nov 2026). So once a bot entry fills, its stop leg is swapped for an SL-M at the same price: it
 *    sits at the exchange and goes out as a market order when the price touches it. The target stays the super's leg.
 * 2. Add-stop pairs (the Charts page's Add stop): an SL-M plus a target LIMIT for a position already open.
 *
 * For both: position flat (stop or target filled, or closed by hand) -> cancel what is left; part of it closed -> the
 * SL-M / target quantity comes down to what is still open (never more than that, or it would open a position the other
 * way). An SL-M that could not be placed is tried again; one he cancels himself (✕ / Clear all) is not.
 * BOT_STOP=super keeps Algo Live's old super-order stop leg.
 */

const OPEN = ['PENDING', 'TRANSIT', 'PART_TRADED', 'TRIGGERED'];
const isOurSlm = (o: PlainOrder) => o.orderType === 'STOP_LOSS_MARKET' && (o.correlationId ?? '').startsWith('te-s') && OPEN.includes(o.orderStatus);
const isOurTarget = (o: PlainOrder) => o.orderType === 'LIMIT' && (o.correlationId ?? '').startsWith('te-t') && OPEN.includes(o.orderStatus);
const left = (o: PlainOrder) => o.remainingQuantity || o.quantity;

/** keeps the open orders of one kind to `qty` in total: extras cancelled, the first cut down */
async function capQty(token: string, sid: string, kind: string, list: PlainOrder[], qty: number) {
  const total = list.reduce((a, x) => a + left(x), 0);
  if (!list.length || total <= qty) return;
  for (const x of list.slice(1)) await cancelOrder(token, x.orderId);
  await modifyOrder(token, list[0], Number(kind === 'SL-M' ? list[0].triggerPrice : list[0].price), qty);
  log(`${kind} ${sid}: quantity cut to ${qty} (part of the position closed)`);
}

export async function syncSlmStops(token: string) {
  const [sup, ord, pos] = await Promise.all([superOrders(token), orderList(token), positions(token)]);
  const date = istNow().date.replace(/-/g, '');
  const corr = (sid: string) => `te-s${date}-${sid}-${Date.now() % 10000}`.slice(0, 30);
  const posOf = (sid: string, dir: number) => pos.find((x: Position) => String(x.securityId) === sid && x.netQty && Math.sign(x.netQty) === dir);
  const handled = new Set<string>();

  // 1. Algo Live trades
  for (const o of sup as SuperOrder[]) {
    if (!(o.correlationId ?? '').startsWith(BOT_PREFIX) || !((o.filledQty ?? 0) > 0 || o.orderStatus === 'TRADED')) continue;
    const sid = String(o.securityId);
    if (shared.exiting.has(sid) || handled.has(sid)) continue;
    handled.add(sid);
    const dir = o.transactionType === 'SELL' ? -1 : 1, exitSide: 'BUY' | 'SELL' = dir < 0 ? 'BUY' : 'SELL';
    const p = posOf(sid, dir);
    const leg = (o.legDetails ?? []).find((l) => l.legName === 'STOP_LOSS_LEG');
    const tgt = (o.legDetails ?? []).find((l) => l.legName === 'TARGET_LEG' && OPEN.includes(l.orderStatus));
    const mine = ord.filter((x) => String(x.securityId) === sid && isOurSlm(x));
    // an Add-stop target on an Algo Live stock (after he removed its stop) goes with it
    const tmine = ord.filter((x) => String(x.securityId) === sid && isOurTarget(x));
    try {
      if (!p) {
        // flat: one exit filled (or he closed it), so the other must go, or it could open a new position later. Only
        // once swapped: before that the super order does its own one-cancels-the-other
        const swapped = shared.slm.has(sid) || leg?.orderStatus === 'CANCELLED';
        if (!swapped || (!mine.length && !tmine.length && !tgt)) { shared.slm.delete(sid); continue; }
        for (const x of [...mine, ...tmine]) await cancelOrder(token, x.orderId);
        if (tgt) await cancelLeg(token, o.orderId, 'TARGET_LEG');
        log(`SL-M ${sid}: position closed, cancelled ${[...mine.map((x) => `SL-M ${x.orderId}`), ...tmine.map((x) => `target ${x.orderId}`), ...(tgt ? ['the target leg'] : [])].join(' and ')}`);
        shared.slm.delete(sid);
        continue;
      }
      if (/^super$/i.test(process.env.BOT_STOP ?? '')) continue;
      const qty = Math.abs(p.netQty);
      await capQty(token, sid, 'target', tmine, qty);
      if (leg && leg.orderStatus === 'PENDING' && !mine.length && shared.slm.get(sid) !== 0) {
        // the swap: the leg goes first (two live stops could both fire and turn the position around), then the SL-M
        await cancelLeg(token, o.orderId, 'STOP_LOSS_LEG');
        shared.slm.set(sid, leg.price);
        await slmOrder(token, { securityId: sid, side: exitSide, qty, trigger: leg.price, productType: p.productType, correlationId: corr(sid) });
        log(`SL-M ${sid}: stop leg of ${o.orderId} swapped for an SL-M ${exitSide} ${qty} at ${leg.price}`);
        continue;
      }
      const want = shared.slm.get(sid) ?? (leg?.orderStatus === 'CANCELLED' && tgt ? leg.price : undefined);
      if (!mine.length) {
        // placing failed last time (or the server restarted between the two steps): try again; 0 = he removed it
        if (want) {
          await slmOrder(token, { securityId: sid, side: exitSide, qty, trigger: want, productType: p.productType, correlationId: corr(sid) });
          shared.slm.set(sid, want);
          log(`SL-M ${sid}: placed ${exitSide} ${qty} at ${want} (retry)`);
        }
        continue;
      }
      shared.slm.set(sid, Number(mine[0].triggerPrice) || want || 0);
      await capQty(token, sid, 'SL-M', mine, qty);
    } catch (e) { log(`SL-M ${sid}: ${(e as Error).message}`); }
  }

  // 2. Add-stop pairs (any stock with our SL-M / target that is not an Algo Live trade)
  const sids = new Set(ord.filter((x) => isOurSlm(x) || isOurTarget(x)).map((x) => String(x.securityId)));
  for (const sid of sids) {
    if (handled.has(sid) || shared.exiting.has(sid)) continue;
    const slms = ord.filter((x) => String(x.securityId) === sid && isOurSlm(x));
    const tgts = ord.filter((x) => String(x.securityId) === sid && isOurTarget(x));
    const exitSide = (slms[0] ?? tgts[0]).transactionType;
    const p = posOf(sid, exitSide === 'BUY' ? -1 : 1);
    try {
      if (!p) {
        for (const x of [...slms, ...tgts]) await cancelOrder(token, x.orderId);
        log(`stop pair ${sid}: position closed, cancelled ${[...slms.map((x) => `SL-M ${x.orderId}`), ...tgts.map((x) => `target ${x.orderId}`)].join(' and ')}`);
        shared.slm.delete(sid);
        continue;
      }
      const qty = Math.abs(p.netQty);
      await capQty(token, sid, 'SL-M', slms, qty);
      await capQty(token, sid, 'target', tgts, qty);
    } catch (e) { log(`stop pair ${sid}: ${(e as Error).message}`); }
  }
}
