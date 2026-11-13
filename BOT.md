# tradereye bot (Algo Live)

tradereye's **Algo Live** page decides the trades; this server places them, because Dhan only takes orders from this
server's fixed IP.

## What it does

- `POST /api/te`: the only door for tradereye. Every call is sealed (AES-256-GCM) with `TE_SHARED_SECRET`, so nobody
  without the secret can read it (it carries your Dhan token) or forge one. Calls older than a minute, or replayed, are
  refused. Actions: `ping`, `place`, `status`, `squareoff`, `killstatus`, `killswitch`, and for tradereye's Charts page
  `book`, `clearall`, `flatten`, `move`, `cancel` (below).
- **Orders**: shorts only, INTRADAY, NSE. A plain market entry (correlationId `te-<date>-<symbol>`); once it fills,
  its stop and target go in as a pair (below). If the order stream is not connected it falls back to a Dhan super
  order (entry, stop and target together); `BOT_ORDERS=super` forces that.
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
- **Stop / target pairs** (`src/lib/slmStops.ts`): a stop-limit at the exchange (trigger at the stop, limit
  `STOP_LIMIT_BUFFER_PCT`, 0.5%, past it: Dhan's API refuses a stop without a limit price, DH-906) plus a target
  LIMIT. Algo Live's trades get one when the entry fills; the Charts page's **Add stop** adds one (at Algo Live's
  levels) to an open position that has no stop. Dragging the stop line or Break-even moves trigger and limit together.
- **One-cancels-the-other, from Dhan's order stream** (`src/lib/orderStream.ts`, `wss://api-order-update.dhan.co`):
  no polling. Order messages run a sync (two reads) at most once every 3 s: a filled entry gets its pair; position
  flat, the leftover stop / target is cancelled (not in the first 15 s after placing, while the position list catches
  up); the pair's quantity follows the open quantity. Nothing ever cancels a stop while its position is open, and an
  action Dhan refuses is logged once and never retried by itself (13 Nov 2026: a stop was cancelled before its
  replacement existed, and a refused cancel looped). Needs Node 22+ (built-in WebSocket). Check with `node -v`.
- **Sandbox test**: `scripts/sandbox-test.mjs` runs these order calls against Dhan's sandbox (instructions inside).
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
