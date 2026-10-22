# tradereye bot (Algo Live)

tradereye's **Algo Live** page decides the trades; this server places them, because Dhan only takes orders from this
server's fixed IP.

## What it does

- `POST /api/te`: the only door for tradereye. Every call is sealed (AES-256-GCM) with `TE_SHARED_SECRET`, so nobody
  without the secret can read it (it carries your Dhan token) or forge one. Calls older than a minute, or replayed, are
  refused. Actions: `ping`, `place`, `status`, `squareoff`.
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
