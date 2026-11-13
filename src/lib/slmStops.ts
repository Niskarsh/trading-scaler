import { BOT_PREFIX, cancelLeg, cancelOrder, modifyOrder, slmOrder, type PlainOrder, type Position, type SuperOrder } from './dhanBot';
import { istNow, log, shared } from './te';

/**
 * Algo Live's stops as real SL-M orders.
 *
 * A super order's stop leg waits on Dhan's server and, when hit, goes out as a LIMIT that a fast move leaves behind
 * (13 Nov 2026). So once a bot entry fills, its stop leg is swapped for an SL-M at the same price: it sits at the
 * exchange and goes out as a market order when the price touches the trigger. The target stays the super order's leg.
 *
 * The SL-M is no longer tied to the target, so this does the one-cancels-the-other (every stop guard tick, 2 s):
 *  - position flat (stop or target filled, or closed by hand): cancel what is left (the SL-M, the target leg);
 *  - target partly filled: the SL-M's quantity comes down to what is still open (it must never buy more than that);
 *  - an SL-M that could not be placed is tried again next tick; one he cancels himself (✕ / Clear all) is not.
 * BOT_STOP=super keeps the old super-order stop leg.
 */

const SLM_PREFIX = 'te-s';
const OPEN = ['PENDING', 'TRANSIT', 'PART_TRADED', 'TRIGGERED'];
export const isOurSlm = (o: PlainOrder) => o.orderType === 'STOP_LOSS_MARKET' && (o.correlationId ?? '').startsWith(SLM_PREFIX) && OPEN.includes(o.orderStatus);

export async function syncSlmStops(token: string, sup: SuperOrder[], ord: PlainOrder[], pos: Position[]) {
  if (/^super$/i.test(process.env.BOT_STOP ?? '')) return;
  const date = istNow().date.replace(/-/g, '');
  const corr = (sid: string) => `${SLM_PREFIX}${date}-${sid}-${Date.now() % 10000}`.slice(0, 30);
  for (const o of sup) {
    if (!(o.correlationId ?? '').startsWith(BOT_PREFIX) || !((o.filledQty ?? 0) > 0 || o.orderStatus === 'TRADED')) continue;
    const sid = String(o.securityId);
    if (shared.exiting.has(sid)) continue;
    const dir = o.transactionType === 'SELL' ? -1 : 1, exitSide: 'BUY' | 'SELL' = dir < 0 ? 'BUY' : 'SELL';
    const p = pos.find((x) => String(x.securityId) === sid && x.netQty && Math.sign(x.netQty) === dir);
    const leg = (o.legDetails ?? []).find((l) => l.legName === 'STOP_LOSS_LEG');
    const tgt = (o.legDetails ?? []).find((l) => l.legName === 'TARGET_LEG' && OPEN.includes(l.orderStatus));
    const mine = ord.filter((x) => String(x.securityId) === sid && isOurSlm(x));
    try {
      if (!p) {
        // flat: one exit filled (or he closed it), so the other must go, or it could open a new position later.
        // Only once swapped (before that the super order does its own one-cancels-the-other, and a position list
        // that lags just after the entry fills must not cancel a fresh target)
        const swapped = shared.slm.has(sid) || leg?.orderStatus === 'CANCELLED';
        if (!swapped || (!mine.length && !tgt)) { shared.slm.delete(sid); continue; }
        for (const x of mine) await cancelOrder(token, x.orderId);
        if (tgt) await cancelLeg(token, o.orderId, 'TARGET_LEG');
        log(`SL-M ${sid}: position closed, cancelled ${[...mine.map((x) => `SL-M ${x.orderId}`), ...(tgt ? ['the target'] : [])].join(' and ')}`);
        shared.slm.delete(sid);
        continue;
      }
      const qty = Math.abs(p.netQty);
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
      // follow a dragged / break-even stop; never cover more than is open (a partly filled target)
      shared.slm.set(sid, Number(mine[0].triggerPrice) || want || 0);
      const total = mine.reduce((a, x) => a + (x.remainingQuantity || x.quantity), 0);
      if (total > qty) {
        for (const x of mine.slice(1)) await cancelOrder(token, x.orderId);
        await modifyOrder(token, mine[0], Number(mine[0].triggerPrice), qty);
        log(`SL-M ${sid}: quantity cut to ${qty} (part of the position closed)`);
      }
    } catch (e) { log(`SL-M ${sid}: ${(e as Error).message}`); }
  }
}
