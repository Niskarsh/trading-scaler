import { NextResponse } from 'next/server';

const baseUrl = process.env.NODE_ENV === 'production'
    ? process.env.DHAN_BASE_URL_PROD ?? 'https://api.dhan.co/v2'
    : process.env.DHAN_BASE_URL_DEV ?? 'https://sandbox.dhan.co/v2';
export async function POST(request: Request) {
    try {
        const token = request.headers.get('x-dhan-token');
        const clientId = process.env.DHAN_CLIENT_ID;
        if (!token || !clientId) return NextResponse.json({ error: 'Auth Missing' }, { status: 401 });

        const {
            // profitValue,
            lossValue, productType }: {
                // profitValue: string;
                lossValue: string; productType: Array<"INTRADAY" | "DELIVERY">;
            } = await request.json();

        if (
            // !profitValue ||
            !lossValue || !productType || !Array.isArray(productType) || productType.length === 0
        ) {
            return NextResponse.json({ error: 'Missing Parameters' }, { status: 400 });
        }
        //         curl --request POST \
        //   --url https://api.dhan.co/v2/pnlExit \
        //   --header 'Accept: application/json' \
        //   --header 'Content-Type: application/json' \
        //   --header 'access-token: ' \
        //   --data '{Request Body}'

        const response = await fetch(`${baseUrl}/pnlExit`, {
            method: 'POST',
            headers: {
                'access-token': token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                // profitValue,
                lossValue,
                productType,
                enableKillSwitch: true,
                dhanClientId: clientId,
            }),
        });
        const results = await response.json();
        console.log(results)
        return NextResponse.json({ data: results });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function GET(request: Request) {
    try {
        const token = request.headers.get('x-dhan-token');
        if (!token) return NextResponse.json({ error: 'Auth Missing' }, { status: 401 });
        const response = await fetch(`${baseUrl}/pnlExit`, {
            method: 'GET',
            headers: {
                'access-token': token,
                'Content-Type': 'application/json',
            },
            // body: JSON.stringify(payload),
        });
        const results: {
            pnlExitStatus: "ACTIVE" | "INACTIVE",
            profit: string,
            loss: string,
            productType: Array<"INTRADAY" | "DELIVERY">,
            enable_kill_switch: boolean
        } = await response.json();
        console.log(results)

        return NextResponse.json({ pnlLimitData: results });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
