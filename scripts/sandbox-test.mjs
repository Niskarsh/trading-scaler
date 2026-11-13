#!/usr/bin/env node
/**
 * Runs the order calls trading-scaler makes against Dhan's SANDBOX (no real money), and prints what Dhan answers.
 * Run it on the EC2 machine (Dhan only takes orders from its IP):
 *
 *   DHAN_SANDBOX_TOKEN=<sandbox access token> DHAN_SANDBOX_CLIENT_ID=<sandbox client id> \
 *     node scripts/sandbox-test.mjs <securityId> <price near the market>
 *
 * e.g. node scripts/sandbox-test.mjs 1333 1650
 * It never touches https://api.dhan.co (real account): only https://sandbox.dhan.co.
 */

const BASE = 'https://sandbox.dhan.co/v2';
const token = process.env.DHAN_SANDBOX_TOKEN, clientId = process.env.DHAN_SANDBOX_CLIENT_ID;
const [sid, px] = [process.argv[2], Number(process.argv[3])];
if (!token || !clientId || !sid || !(px > 0)) { console.error('usage: DHAN_SANDBOX_TOKEN=… DHAN_SANDBOX_CLIENT_ID=… node scripts/sandbox-test.mjs <securityId> <price>'); process.exit(1); }
const tick = (v) => Number((Math.round(v * 20) / 20).toFixed(2));

async function call(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'access-token': token, 'client-id': clientId, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { ok: r.ok, status: r.status, j };
}
const order = (o) => ({ dhanClientId: clientId, exchangeSegment: 'NSE_EQ', productType: 'INTRADAY', validity: 'DAY', securityId: String(sid), disclosedQuantity: 0, afterMarketOrder: false, triggerPrice: 0, price: 0, ...o });
const results = [];
async function step(name, expect, f) {
  const r = await f();
  const msg = r.ok ? JSON.stringify(r.j).slice(0, 160) : `${r.status} ${JSON.stringify(r.j).slice(0, 160)}`;
  results.push({ step: name, expect, got: r.ok ? 'OK' : 'REFUSED', detail: msg });
  console.log(`${r.ok ? 'OK     ' : 'REFUSED'} ${name}\n        ${msg}`);
  return r;
}

const stop = tick(px * 1.01), lim = tick(stop * 1.005), target = tick(px * 0.98);
console.log(`sandbox, security ${sid}, price ${px}: short 1, stop ${stop} (limit ${lim}), target ${target}\n`);

await step('market SELL 1 (open a short)', 'OK', () => call('POST', '/orders', order({ correlationId: 'sbx-entry', transactionType: 'SELL', orderType: 'MARKET', quantity: 1 })));
await step('SL-M BUY with price 0 (what failed on 13 Nov: DH-906?)', 'REFUSED', () => call('POST', '/orders', order({ correlationId: 'sbx-slm', transactionType: 'BUY', orderType: 'STOP_LOSS_MARKET', quantity: 1, triggerPrice: stop })));
const sl = await step(`stop-limit BUY trigger ${stop} limit ${lim} (what Add stop now sends)`, 'OK', () => call('POST', '/orders', order({ correlationId: 'te-s-sbx', transactionType: 'BUY', orderType: 'STOP_LOSS', quantity: 1, triggerPrice: stop, price: lim })));
const tg = await step(`target LIMIT BUY at ${target}`, 'OK', () => call('POST', '/orders', order({ correlationId: 'te-t-sbx', transactionType: 'BUY', orderType: 'LIMIT', quantity: 1, price: target })));
const slId = sl.j?.orderId, tgId = tg.j?.orderId;
if (slId) {
  const s2 = tick(stop * 1.005), l2 = tick(s2 * 1.005);
  await step(`move the stop to ${s2} (drag)`, 'OK', () => call('PUT', `/orders/${slId}`, { dhanClientId: clientId, orderId: slId, orderType: 'STOP_LOSS', legName: '', quantity: 1, price: l2, disclosedQuantity: 0, triggerPrice: s2, validity: 'DAY' }));
  await step('cancel the stop', 'OK', () => call('DELETE', `/orders/${slId}`));
  await step('cancel the stop AGAIN (must be refused, and trading-scaler must not loop on it)', 'REFUSED', () => call('DELETE', `/orders/${slId}`));
}
if (tgId) await step('cancel the target', 'OK', () => call('DELETE', `/orders/${tgId}`));
await step('market BUY 1 (close the short)', 'OK', () => call('POST', '/orders', order({ correlationId: 'sbx-exit', transactionType: 'BUY', orderType: 'MARKET', quantity: 1 })));
const list = await call('GET', '/orders');
console.log('\norder book now:');
for (const o of Array.isArray(list.j) ? list.j : []) console.log(`  ${o.orderId} ${o.transactionType} ${o.orderType} ${o.orderStatus} qty ${o.quantity} price ${o.price} trigger ${o.triggerPrice} ${o.correlationId ?? ''}`);

console.log('\nsummary:');
for (const r of results) console.log(`  ${r.got === r.expect ? 'as expected' : 'UNEXPECTED '}  ${r.got.padEnd(7)} ${r.step}`);
