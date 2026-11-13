# tradereye bot (Algo Live)

tradereye's **Algo Live** page decides the trades; this server places them, because Dhan only takes orders from this
server's fixed IP.

## What it does

- `POST /api/te`: the only door for tradereye. Every call is sealed (AES-256-GCM) with `TE_SHARED_SECRET`, so nobody
  without the secret can read it (it carries your Dhan token) or forge one. Calls older than a minute, or replayed, are
  refused. Actions: `ping`, `place`, `status`, `squareoff`, `killstatus`, `killswitch`, and for tradereye's Charts page
  `book`, `clearall`, `flatten`, `move`, `cancel` (below).
- **Orders**: shorts only, as Dhan super orders (market entry, stop and target placed with it), INTRADAY, NSE.
  correlationId `te-<date>-<symbol>`.
- **Guards on this server** (whatever tradereye asks):
  - at most `BOT_MAX_PER_DAY` (2) bot orders a day, counted from Dhan's own order list (an order rejected or cancelled
    before it filled does not count);
  - never the same order twice;
  - only between `BOT_FROM` (09:30) and `BOT_TO` (11:05) IST;
  - no position above `BOT_MAX_NOTIONAL` (₹75,000).
- **15:15 IST**: closes every bot position. It cancels entries that never filled, cancels the stop and target, then
  for each bot stock still open cancels every order of that stock (its SL-M too) and buys back at market. It uses the
  Dhan token tradereye last sent (kept in memory only).
- **Chart buttons (one stock, tradereye's Charts page)**: these act on *every* order of that one stock, hand-placed
  ones included, and only when you press the button on that stock's chart (at once, no confirmation).
  `book` lists its position and working orders; `clearall` cancels its working orders (the position stays);
  `flatten` cancels them, waits until Dhan shows them gone (cancelling again if needed), then closes the position
  at market (never while a stop or target is still live: it says which); `move` moves a stop / target / limit (a
  dragged line, or Break-even); `cancel` cancels one order (the ✕ on its line); `addstop` (below). None of them opens
  a new position. Logic: `src/lib/symbolOrders.ts`.
- **Algo Live stops are SL-M orders** (`src/lib/slmStops.ts`): once a bot entry fills, its super order's stop leg is
  cancelled and an SL-M (`STOP_LOSS_MARKET`) at the same price takes its place at the exchange; when the price touches
  it, it goes out as a market order. The target stays the super order's leg. `BOT_STOP=super` keeps the old stop leg.
- **Add stop** (tradereye's Charts page, `addstop`): for an open position with no stop, an SL-M at Algo Live's stop and
  a target LIMIT at its target, as a pair.
- **One-cancels-the-other, from Dhan's order stream** (`src/lib/orderStream.ts`, `wss://api-order-update.dhan.co`):
  no polling. Dhan pushes a message when any order changes; each one runs a sync (three reads): position flat, the
  SL-M / target left over is cancelled; part closed, their quantity comes down to what is open; an SL-M that failed
  to place is tried again (one you cancel yourself is not put back). The stream connects with the token tradereye last
  sent and reconnects by itself. **Needs Node 22+** (built-in WebSocket): without it the swap never happens and Algo
  Live keeps its super-order stop, and Add stop is refused. Check with `node -v`.
- **Everything else** (your existing pages and APIs) now asks for a password (HTTP Basic: user `UI_USER`, default
  `nik`, password `UI_PASSWORD`).

## Set up (once)

1. Make a long random secret:
   ```bash
   openssl rand -base64 32
   ```
2. On the EC2 server, put these in the app's environment, for example in `ecosystem.config.js` under `env`, or in a
   `.env.production` file next to `package.json`:
   ```
   TE_SHARED_SECRET=<the secret>
   UI_PASSWORD=<a password for the pages>
   DHAN_CLIENT_ID=<your Dhan client id>
   ```
3. On Vercel (tradereye → Settings → Environment Variables), add the same `TE_SHARED_SECRET` and
   `TRADING_SCALER_URL=http://<EC2 address>:3000`. Then redeploy tradereye.
4. Deploy here:
   ```bash
   git pull && npm ci && npm run deploy
   ```
5. Open tradereye → Algo Live → **Check trading-scaler**. It should answer "trading-scaler is up".

The server's clock must be right, because calls older than a minute are refused. EC2 keeps time by default.
