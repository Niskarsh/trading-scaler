import { NextResponse, type NextRequest } from 'next/server';

/**
 * The lock in front of this app (it used to be open to anyone who found the address):
 *  - /api/te (tradereye's Algo Live) has its own lock: every call is sealed with TE_SHARED_SECRET (src/lib/te.ts);
 *  - everything else (the pages and their APIs) asks for a password (HTTP Basic: user UI_USER, default "nik",
 *    password UI_PASSWORD). With no UI_PASSWORD set, everything else is closed.
 */
export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === '/api/te') return NextResponse.next();
  const pass = process.env.UI_PASSWORD;
  if (!pass) return new NextResponse('Locked: set UI_PASSWORD on the server.', { status: 503 });
  const user = process.env.UI_USER ?? 'nik';
  const h = req.headers.get('authorization') ?? '';
  let ok = false;
  if (h.startsWith('Basic ')) {
    try {
      const [u, ...rest] = atob(h.slice(6)).split(':');
      ok = same(u, user) && same(rest.join(':'), pass);
    } catch { ok = false; }
  }
  if (ok) return NextResponse.next();
  return new NextResponse('Password required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="trading-scaler", charset="UTF-8"' } });
}

/** compares without leaking where the first difference is */
function same(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
