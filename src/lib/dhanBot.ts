/**
 * The few Dhan calls the tradereye bot needs (orders go out from this server: Dhan only takes orders from its fixed IP).
 * Bot orders carry a correlationId starting "te-", so they are told apart from anything placed by hand.
 */

const BASE = () => process.env.NODE_ENV === 'production'
  ? process.env.DHAN_BASE_URL_PROD ?? 'https://api.dhan.co/v2'
  : process.env.DHAN_BASE_URL_DEV ?? 'https://sandbox.dhan.co/v2';

export const BOT_PREFIX = 'te-';

export class DhanBotError extends Error { constructor(public status: number, message: string) { super(message); } }

async function req<T>(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`${BASE()}${path}`, {
    method, headers: { 'access-token': token, 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
  });
  const text = await r.text();
  let j: unknown = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    const o = (j ?? {}) as { errorMessage?: string; errorCode?: string; message?: string };
    throw new DhanBotError(r.status, `${o.errorCode ? `${o.errorCode} ` : ''}${o.errorMessage ?? o.message ?? text.slice(0, 200) ?? `HTTP ${r.status}`}`);
  }
  return j as T;
}

/** the Dhan client id inside the token (or DHAN_CLIENT_ID) */
export function clientIdOf(token: string): string {
  if (process.env.DHAN_CLIENT_ID) return process.env.DHAN_CLIENT_ID;
  try { return String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).dhanClientId ?? ''); } catch { return ''; }
}

export interface SuperLeg { legName: string; orderStatus: string; price: number; orderId?: string }
export interface SuperOrder {
  orderId: string; correlationId?: string; orderStatus: string; transactionType: string; tradingSymbol?: string; securityId: string; quantity: number;
  filledQty?: number; averageTradedPrice?: number; price?: number; createTime?: string; omsErrorDescription?: string; legDetails?: SuperLeg[];
}
export interface Position { tradingSymbol?: string; securityId: string; productType: string; netQty: number; realizedProfit?: number; unrealizedProfit?: number; exchangeSegment?: string }

export const superOrders = (token: string) => req<SuperOrder[]>(token, 'GET', '/super/orders').then((r) => (Array.isArray(r) ? r : []));
export const positions = (token: string) => req<Position[]>(token, 'GET', '/positions').then((r) => (Array.isArray(r) ? r : []));

export function placeShort(token: string, o: { securityId: string; qty: number; targetPrice: number; stopLossPrice: number; correlationId: string }) {
  return req<{ orderId: string; orderStatus: string }>(token, 'POST', '/super/orders', {
    dhanClientId: clientIdOf(token), correlationId: o.correlationId, transactionType: 'SELL', exchangeSegment: 'NSE_EQ', productType: 'INTRADAY',
    orderType: 'MARKET', securityId: String(o.securityId), quantity: o.qty, price: 0, targetPrice: o.targetPrice, stopLossPrice: o.stopLossPrice, trailingJump: 0,
  });
}

/** Dhan's kill switch: no order on the whole account for the rest of the trading day. Dhan wants no open position and no pending order first. */
export const activateKillSwitch = (token: string) => req<{ killSwitchStatus?: string }>(token, 'POST', '/killswitch?killSwitchStatus=ACTIVATE');
export const killSwitchStatus = (token: string) => req<{ killSwitchStatus?: string }>(token, 'GET', '/killswitch');

export const cancelLeg = (token: string, orderId: string, leg: 'ENTRY_LEG' | 'TARGET_LEG' | 'STOP_LOSS_LEG') => req<unknown>(token, 'DELETE', `/super/orders/${orderId}/${leg}`);

/** a plain market order (to close what is left open) */
export function marketOrder(token: string, o: { securityId: string; side: 'BUY' | 'SELL'; qty: number; correlationId: string; productType?: string }) {
  return req<{ orderId: string; orderStatus: string }>(token, 'POST', '/orders', {
    dhanClientId: clientIdOf(token), correlationId: o.correlationId, transactionType: o.side, exchangeSegment: 'NSE_EQ', productType: o.productType ?? 'INTRADAY',
    orderType: 'MARKET', validity: 'DAY', securityId: String(o.securityId), quantity: o.qty, disclosedQuantity: 0, price: 0, triggerPrice: 0, afterMarketOrder: false,
  });
}

/** an ordinary order (anything not a super order: SL / SL-M / LIMIT placed by hand or by TradingView) */
export interface PlainOrder {
  orderId: string; correlationId?: string; orderStatus: string; transactionType: string; productType: string; orderType: string; validity?: string;
  tradingSymbol?: string; securityId: string; quantity: number; remainingQuantity?: number; filledQty?: number; price?: number; triggerPrice?: number;
  disclosedQuantity?: number; legName?: string;
}
export const orderList = (token: string) => req<PlainOrder[]>(token, 'GET', '/orders').then((r) => (Array.isArray(r) ? r : []));
export const cancelOrder = (token: string, orderId: string) => req<unknown>(token, 'DELETE', `/orders/${orderId}`);

/** change an ordinary order's price (a stop moves its trigger; a stop-limit moves both by the same amount) */
export function modifyOrder(token: string, o: PlainOrder, newPrice: number, qty?: number) {
  const isStop = /STOP_LOSS/.test(o.orderType);
  const trigger = isStop ? newPrice : 0;
  const price = o.orderType === 'STOP_LOSS' ? Math.round((newPrice + ((o.price ?? 0) - (o.triggerPrice ?? 0))) * 20) / 20 : isStop ? 0 : newPrice;
  return req<{ orderId: string; orderStatus: string }>(token, 'PUT', `/orders/${o.orderId}`, {
    dhanClientId: clientIdOf(token), orderId: o.orderId, orderType: o.orderType, legName: o.legName ?? '', quantity: qty ?? (o.remainingQuantity || o.quantity),
    price, disclosedQuantity: o.disclosedQuantity ?? 0, triggerPrice: trigger, validity: o.validity ?? 'DAY',
  });
}

/** move a super order's stop or target leg */
export function modifySuperLeg(token: string, orderId: string, leg: 'STOP_LOSS_LEG' | 'TARGET_LEG', price: number) {
  return req<{ orderId: string; orderStatus: string }>(token, 'PUT', `/super/orders/${orderId}`, leg === 'STOP_LOSS_LEG'
    ? { dhanClientId: clientIdOf(token), orderId, legName: leg, stopLossPrice: price, trailingJump: 0 }
    : { dhanClientId: clientIdOf(token), orderId, legName: leg, targetPrice: price });
}

/** a plain LIMIT order (the target of an Add-stop pair) */
export function limitOrder(token: string, o: { securityId: string; side: 'BUY' | 'SELL'; qty: number; price: number; correlationId: string; productType?: string }) {
  return req<{ orderId: string; orderStatus: string }>(token, 'POST', '/orders', {
    dhanClientId: clientIdOf(token), correlationId: o.correlationId, transactionType: o.side, exchangeSegment: 'NSE_EQ', productType: o.productType ?? 'INTRADAY',
    orderType: 'LIMIT', validity: 'DAY', securityId: String(o.securityId), quantity: o.qty, disclosedQuantity: 0, price: o.price, triggerPrice: 0, afterMarketOrder: false,
  });
}


/** a stop-limit (SL): sits at the exchange; once the price touches the trigger it goes out as a limit at `price` (Dhan's API refuses an SL-M with no price: DH-906) */
export function stopLimitOrder(token: string, o: { securityId: string; side: 'BUY' | 'SELL'; qty: number; trigger: number; price: number; correlationId: string; productType?: string }) {
  return req<{ orderId: string; orderStatus: string }>(token, 'POST', '/orders', {
    dhanClientId: clientIdOf(token), correlationId: o.correlationId, transactionType: o.side, exchangeSegment: 'NSE_EQ', productType: o.productType ?? 'INTRADAY',
    orderType: 'STOP_LOSS', validity: 'DAY', securityId: String(o.securityId), quantity: o.qty, disclosedQuantity: 0, price: o.price, triggerPrice: o.trigger, afterMarketOrder: false,
  });
}
