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
  buys back at market. It uses the Dhan token tradereye last sent (kept in memory only). Orders you place by hand are
  never touched.
- **Chart buttons (one stock, tradereye's Charts page)**: these act on *every* order of that one stock, hand-placed
  ones included, and only when you press the button on that stock's chart (at once, no confirmation).
  `book` lists its position and working orders; `clearall` cancels its working orders (the position stays);
  `flatten` cancels them, waits until Dhan shows them gone (cancelling again if needed), then closes the position
  with a limit through the market, re-priced until flat (never while a stop or target is still live: it says which); `move` moves a stop / target / limit (a dragged line, or Break-even); `cancel`
  cancels one order (the ✕ on its line). None of them opens a new position. Logic: `src/lib/symbolOrders.ts`.
- **Stop guard** (`src/lib/stopGuard.ts`): since March 2026 Dhan sends no API order as a pure market order. A triggered
  stop (a super order's stop leg, or an SL order) goes out as a LIMIT, and in a fast move it is left behind unfilled
  while the loss grows. Every 2 s in market hours this server reads every open NSE position, remembers its stop (it
  follows a dragged or break-even stop), and the moment the last price is past the stop with the position still
  open, it closes it: cancels the stuck exit and every other order of that stock, waits until Dhan shows them gone,
  then sends a buy / sell 2% through the last price (fills at once at the best prices, like a market order),
  re-priced until flat. A stop you
  remove yourself (price not past it) is forgotten. Env (all optional): `STOP_GUARD=off`, `GUARD_TICK_MS` (2000),
  `GUARD_GRACE_MS` (0), `EXIT_CHASE_PCT` (2). It uses the token tradereye last sent and Dhan's last-price API
  (Data API). Every action is in the log (`pm2 logs`).
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
