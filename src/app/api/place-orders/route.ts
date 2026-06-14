import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const token = request.headers.get('x-dhan-token');
    const clientId = process.env.DHAN_CLIENT_ID;
    const baseUrl = process.env.NODE_ENV === 'production'
      ? process.env.DHAN_BASE_URL_PROD ?? 'https://api.dhan.co/v2'
      : process.env.DHAN_BASE_URL_DEV ?? 'https://sandbox.dhan.co/v2';
    const body = await request.json() as unknown;
    const { orders, securityId, segment } = body as { orders: Array<Record<string, unknown>>; securityId?: string; segment?: string };

    if (!token || !clientId) return NextResponse.json({ error: 'Auth Missing' }, { status: 401 });

    const results: Record<string, unknown>[] = [];
    for (const order of orders as Array<Record<string, unknown>>) {
      const txn = typeof order.transactionType === 'string' ? order.transactionType.toUpperCase() : 'SELL';
      const triggerVal = typeof (order.trigger) === 'number' ? (order.trigger as number) : parseFloat(String((order.trigger as unknown) || 0));
      const priceOffset = txn === 'BUY' ? 0.05 : -0.05;
      const payload = {
        dhanClientId: clientId,
        correlationId: `pyr-${Date.now()}-${Math.random().toString(36).substring(7)}`.substring(0, 30),
        transactionType: txn,
        exchangeSegment: segment,
        productType: "INTRADAY",
        orderType: "STOP_LOSS",
        validity: "DAY",
        securityId: securityId,
        quantity: parseInt(String((order.qty as unknown) || 0)),
        disclosedQuantity: parseInt(String((order.qty as unknown) || 0)),
        price: parseFloat((triggerVal + priceOffset).toFixed(2)),
        triggerPrice: triggerVal,
        afterMarketOrder: false,
      };
console.log("Placing Order:", payload);
      const response = await fetch(`${baseUrl}/orders`, {
        method: 'POST',
        headers: {
          'access-token': token,
        //   'client-id': clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      results.push(await response.json());
      console.log(results)
    }
    return NextResponse.json({ count: results.length, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}