/**
 * Runs once when the server starts (next start under pm2): the 15:15 square-off of the tradereye bot's positions.
 * Every 15 s between 15:15 and 15:25 IST, once a day, with the Dhan token tradereye last sent (kept in memory).
 * Dhan's own intraday square-off a few minutes later is the last net.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { shared, istNow, log } = await import('./lib/te');
  const { squareOff } = await import('./lib/bot');
  const g = globalThis as unknown as { __teTimer?: ReturnType<typeof setInterval> };
  if (g.__teTimer) return;
  g.__teTimer = setInterval(() => {
    const n = istNow();
    if (n.min < 15 * 60 + 15 || n.min >= 15 * 60 + 25) return;
    if (shared.squaredOff?.startsWith(new Date(Date.now()).toISOString().slice(0, 10)) || shared.squaring) return;
    if (!shared.token || Date.now() - shared.tokenAt > 20 * 3600_000) { if (n.min === 15 * 60 + 15) log('15:15: no Dhan token from tradereye today, cannot square off (Dhan will)'); return; }
    squareOff(shared.token, '15:15').catch((e) => log(`15:15 square-off failed: ${(e as Error).message}`));
  }, 15_000);
  log('15:15 square-off timer is on');
}
