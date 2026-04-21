import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const token = request.headers.get('x-dhan-token');
    const clientId = process.env.DHAN_CLIENT_ID;
    const { orders, tradingSymbol, securityId, segment } = await request.json();

    if (!token || !clientId) return NextResponse.json({ error: 'Auth Missing' }, { status: 401 });

    const results: Record<string, unknown>[] = [];
    for (const order of orders) {
      const payload = {
        dhanClientId: clientId,
        correlationId: `pyr-${Date.now()}-${Math.random().toString(36).substring(7)}`.substring(0, 30),
        transactionType: "SELL",
        exchangeSegment: segment,
        productType: "INTRADAY",
        orderType: "STOP_LOSS",
        validity: "DAY",
        securityId: securityId,
        quantity: parseInt(order.qty),
        disclosedQuantity: parseInt(order.qty),
        price: typeof order.price === 'number' ? order.price : parseFloat(order.price),
        triggerPrice: typeof order.trigger === 'number' ? order.trigger : parseFloat(order.trigger),
        afterMarketOrder: false,
      };
console.log("Placing Order:", payload);
      const response = await fetch('https://api.dhan.co/v2/orders', {
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
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}