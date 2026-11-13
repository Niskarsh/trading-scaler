import { cancelOrder, modifyOrder, orderList, positions, type PlainOrder, type Position } from './dhanBot';
import { log, shared } from './te';

/**
 * The one-cancels-the-other for Add-stop pairs (the Charts page's Add stop: a stop-limit plus a target LIMIT for a
 * position already open). Runs when Dhan's order stream says an order changed (src/lib/orderStream.ts).
 * Position flat (stop or target filled, or closed by hand) -> cancel what is left; part of it closed -> their quantity
 * comes down to what is still open (never more, or it would open a position the other way).
 *
 * Nothing here touches Algo Live's own orders (its super order keeps its stop leg). 13 Nov 2026: swapping that leg for
 * an SL-M cancelled the leg, then Dhan refused the SL-M ("DH-906 Price should be greater than Trigger Price": its API
 * takes no stop without a limit price), and retrying the cancel, which itself raised an order event, looped.
 *
 * Safety: an action that failed once is never retried by itself (`shared.failed`), and the stream runs at most one
 * sync every few seconds, so a refusal can never feed a loop.
 */

const OPEN = ['PENDING', 'TRANSIT', 'PART_TRADED', 'TRIGGERED'];
const isOurSlm = (o: PlainOrder) => /STOP_LOSS/.test(o.orderType) && (o.correlationId ?? '').startsWith('te-s') && OPEN.includes(o.orderStatus);
const isOurTarget = (o: PlainOrder) => o.orderType === 'LIMIT' && (o.correlationId ?? '').startsWith('te-t') && OPEN.includes(o.orderStatus);
const left = (o: PlainOrder) => o.remainingQuantity || o.quantity;

/** runs an order action once: if Dhan refused it, it is logged and never tried again by itself */
async function once(key: string, what: string, f: () => Promise<unknown>): Promise<boolean> {
  if (shared.failed.has(key)) return false;
  try { await f(); return true; }
  catch (e) { shared.failed.add(key); log(`${what}: ${(e as Error).message} (not retried; act on it in Dhan or on the chart)`); return false; }
}

/** keeps the open orders of one kind to `qty` in total: extras cancelled, the first cut down */
async function capQty(token: string, sid: string, kind: string, list: PlainOrder[], qty: number) {
  const total = list.reduce((a, x) => a + left(x), 0);
  if (!list.length || total <= qty) return;
  for (const x of list.slice(1)) await once(`cancel:${x.orderId}`, `${kind} ${sid}: cancel ${x.orderId}`, () => cancelOrder(token, x.orderId));
  if (await once(`modify:${list[0].orderId}:${qty}`, `${kind} ${sid}: cut ${list[0].orderId} to ${qty}`, () => modifyOrder(token, list[0], Number(kind === 'stop' ? list[0].triggerPrice : list[0].price), qty)))
    log(`${kind} ${sid}: quantity cut to ${qty} (part of the position closed)`);
}

export async function syncSlmStops(token: string) {
  const [ord, pos] = await Promise.all([orderList(token), positions(token)]);
  const posOf = (sid: string, dir: number) => pos.find((x: Position) => String(x.securityId) === sid && x.netQty && Math.sign(x.netQty) === dir);

  // every stock with an Add-stop pair still working
  const sids = new Set(ord.filter((x) => isOurSlm(x) || isOurTarget(x)).map((x) => String(x.securityId)));
  for (const sid of sids) {
    if (shared.exiting.has(sid)) continue;
    const slms = ord.filter((x) => String(x.securityId) === sid && isOurSlm(x));
    const tgts = ord.filter((x) => String(x.securityId) === sid && isOurTarget(x));
    const exitSide = (slms[0] ?? tgts[0]).transactionType;
    const p = posOf(sid, exitSide === 'BUY' ? -1 : 1);
    try {
      if (!p) {
        const gone: string[] = [];
        for (const x of [...slms, ...tgts]) if (await once(`cancel:${x.orderId}`, `stop pair ${sid}: cancel ${x.orderId}`, () => cancelOrder(token, x.orderId))) gone.push(x.orderId);
        if (gone.length) log(`stop pair ${sid}: position closed, cancelled ${gone.join(' and ')}`);
        shared.slm.delete(sid);
        continue;
      }
      const qty = Math.abs(p.netQty);
      await capQty(token, sid, 'stop', slms, qty);
      await capQty(token, sid, 'target', tgts, qty);
    } catch (e) { log(`stop pair ${sid}: ${(e as Error).message}`); }
  }
}
