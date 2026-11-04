import { NextResponse } from 'next/server';
import { accept, log, shared } from '@/lib/te';
import { activateKillSwitch, killSwitchStatus } from '@/lib/dhanBot';
import { MAX_PER_DAY, place, squareOff, status, type BotOrder } from '@/lib/bot';

export const dynamic = 'force-dynamic';

/**
 * The only door for tradereye's Algo Live page: one sealed POST (src/lib/te.ts) with an action and the Dhan token.
 *   ping       the server is up (and the secret matches)
 *   place      { orders }: shorts as super orders (stop + target with the entry), with the guards in src/lib/bot.ts
 *   status     the bot's orders today and their positions
 *   squareoff  close every bot position now
 *   killstatus Dhan's kill switch as Dhan reports it
 *   killswitch turn Dhan's kill switch on (Dhan's own answer on failure), then report it as Dhan reports it
 * The token is kept in memory only (for the 15:15 square-off), never written anywhere or logged.
 */
export async function POST(req: Request) {
  const m = accept<{ action: string; token: string; orders?: BotOrder[] }>(await req.json().catch(() => null));
  if (typeof m === 'string') { log(`refused a call: ${m}`); return NextResponse.json({ error: `refused: ${m}` }, { status: 401 }); }
  if (!m.token) return NextResponse.json({ error: 'no Dhan token' }, { status: 400 });
  shared.token = m.token; shared.tokenAt = Date.now();
  try {
    switch (m.action) {
      case 'ping': return NextResponse.json({ ok: true, now: Date.now(), maxPerDay: MAX_PER_DAY });
      case 'place': return NextResponse.json({ placed: await place(m.token, Array.isArray(m.orders) ? m.orders : []) });
      case 'status': return NextResponse.json(await status(m.token));
      case 'squareoff': return NextResponse.json(await squareOff(m.token, 'asked by tradereye'));
      case 'killstatus': return NextResponse.json({ status: (await killSwitchStatus(m.token)).killSwitchStatus ?? '' });
      case 'killswitch': {
        let error: string | undefined;
        try { await activateKillSwitch(m.token); log('kill switch: activated'); }
        catch (e) { error = (e as Error).message; log(`kill switch refused: ${error}`); }
        return NextResponse.json({ status: (await killSwitchStatus(m.token)).killSwitchStatus ?? '', error });
      }
      default: return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (e) {
    log(`${m.action} failed: ${(e as Error).message}`);
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
