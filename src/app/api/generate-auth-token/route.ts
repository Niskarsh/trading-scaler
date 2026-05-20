import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const clientId = process.env.DHAN_CLIENT_ID;
    const pin = process.env.DHAN_MPIN;
    const { totp } = await request.json();

    if (!totp) return NextResponse.json({ error: 'TOTP Missing' }, { status: 401 });
    if (!clientId || !pin) return NextResponse.json({ error: 'Auth Missing' }, { status: 401 });
    const response = await fetch(`https://auth.dhan.co/app/generateAccessToken?dhanClientId=${clientId}&pin=${pin}&totp=${totp}`, {
      method: 'POST',
      // headers: {
      //   'access-token': token,
      //   //   'client-id': clientId,
      //   'Content-Type': 'application/json',
      // },
      // body: JSON.stringify(payload),
    });
    const results = await response.json();
    // console.log(results)

    return NextResponse.json({ token: results.accessToken });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}