/**
 * The few Dhan calls the tradereye bot needs (orders go out from this server: Dhan only takes orders from its fixed IP).
 * Bot orders carry a correlationId starting "te-", so they are told apart from anything placed by hand.
 */

const BASE = () => process.env.NODE_ENV === 'production'
  ? process.env.DHAN_BASE_URL_PROD ?? 'https://api.dhan.co/v2'
  : process.env.DHAN_BASE_URL_DEV ?? 'https://sandbox.dhan.co/v2';

export const BOT_PREFIX = 'te-';

export class DhanBotError extends Error { constructor(public status: number, message: string) { super(message); } }

async function req<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE()}${path}`, {
    method, headers: { 'access-token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
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

export const cancelLeg = (token: string, orderId: string, leg: 'ENTRY_LEG' | 'TARGET_LEG' | 'STOP_LOSS_LEG') => req<unknown>(token, 'DELETE', `/super/orders/${orderId}/${leg}`);

/** a plain market order (to close what is left open) */
export function marketOrder(token: string, o: { securityId: string; side: 'BUY' | 'SELL'; qty: number; correlationId: string }) {
  return req<{ orderId: string; orderStatus: string }>(token, 'POST', '/orders', {
    dhanClientId: clientIdOf(token), correlationId: o.correlationId, transactionType: o.side, exchangeSegment: 'NSE_EQ', productType: 'INTRADAY',
    orderType: 'MARKET', validity: 'DAY', securityId: String(o.securityId), quantity: o.qty, disclosedQuantity: 0, price: 0, triggerPrice: 0, afterMarketOrder: false,
  });
}
