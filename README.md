# Trade Journal (Cloudflare version)

A personal trading journal web app: trades with automatic pips / risk / P&L, rules, reviews, prop firm challenge journeys, money tracking, weekly notes, calendar and performance dashboard.

Runs **entirely on Cloudflare**:

| Part | Cloudflare service | What it does |
|---|---|---|
| Website | **Pages** | Serves the app, auto-deploys from GitHub |
| API | **Pages Functions** (`functions/`) | Login, saving data, image uploads |
| Database | **D1** (SQL) | Users, trades, transactions, weekly notes, settings, image paths |
| Images | **R2** (storage bucket) | Chart screenshots saved as files in folders `<userId>/<YYYY-MM>/<id>.jpg` |

Login: **email + password** (PBKDF2 hashed) and optional **Continue with Google**.
Each user only ever sees their own data and images.

---

## Project structure

```
trade-journal/
├─ public/                 ← the website (Pages "build output directory")
│  ├─ index.html           ← the whole app + login screen
│  ├─ _headers             ← security headers
│  └─ vendor/              ← Chart.js and SheetJS
├─ functions/
│  ├─ api/[[route]].js     ← all /api/* routes (login, data, upload)
│  └─ uploads/[[path]].js  ← serves private images from R2
├─ lib/core.js             ← shared helpers (sessions, password hashing)
├─ db/schema.sql           ← D1 tables
├─ wrangler.toml.example   ← only for command-line use (optional)
├─ package.json
└─ README.md
```

### Database tables (D1)

| Table | Stores |
|---|---|
| `users` | Email, name, password hash or Google ID |
| `sessions` | Login sessions (only a hash of the cookie is stored) |
| `settings` | Accounts, rules, goals, sessions, setups (one row per user) |
| `trades` | One row per trade: pair, direction, entry/exit time & price, lot, SL/TP, fees, rating as columns + full trade as JSON |
| `trade_images` | One row per image: `file_path` (R2 key, e.g. `3/2026-10/abc….jpg`), `url`, trade, before/after, size |
| `transactions` | Deposits, withdrawals, challenge fees, payouts, refunds |
| `weekly_notes` | Weekly reviews and goals |
| `auth_attempts` | Login attempt counter (blocks password guessing) |

---

## Setup in the Cloudflare dashboard (no command line needed)

Menu names in the Cloudflare dashboard change from time to time — if something looks different, search for the same words.

### 1. Put this code in your GitHub repo
Replace the old files in your repository with the contents of this folder (the old `server/` folder and MySQL files are no longer needed). Commit and push.

### 2. Create the database (D1)
1. Cloudflare dashboard → **Storage & Databases → D1** → **Create database**.
2. Name: `trade-journal-db` → Create.
3. Open the database → **Console** tab.
4. Open `db/schema.sql` from this project, copy everything, paste it into the console and press **Execute**.
5. You should now see the tables (users, trades, …) in the **Tables** tab.

### 3. Create the image storage (R2)
1. Dashboard → **R2 Object Storage** → **Create bucket**.
2. Name: `trade-journal-images` → Create. Keep it **private** (don't enable public access — the app serves images only to their owner).
3. Cloudflare may ask you to add a payment method before you can use R2, even on the free tier.

### 4. Create the Pages project
1. Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Pick your GitHub repository.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **`public`**
4. **Save and Deploy**. You get a link like `https://trade-journal.pages.dev`.

### 5. Connect the database and storage (bindings)
1. Open your Pages project → **Settings** → **Bindings** (in some layouts: *Settings → Functions → Bindings*).
2. **Add → D1 database**: Variable name **`DB`** → database `trade-journal-db`.
3. **Add → R2 bucket**: Variable name **`IMAGES`** → bucket `trade-journal-images`.
4. Add the bindings for **Production** (and Preview if you use preview deployments).
5. Go to **Deployments** → on the latest deployment choose **Retry deployment** (bindings only apply to new deployments).

The names must be exactly `DB` and `IMAGES`.

### 6. Open your site and bring your data
1. Open `https://<your-project>.pages.dev` → **Create an account**.
2. In your old journal: *Settings → Full backup → Download full backup*.
3. In the new site: *Settings → Restore from backup* → **Replace my journal**.
   Trades, screenshots (uploaded into R2), accounts, journeys, transactions and weekly notes all come across.

---

## Optional: Google sign-in

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. *APIs & Services → OAuth consent screen* → External → fill in app name and email → save.
3. *APIs & Services → Credentials → Create credentials → OAuth client ID* → type **Web application**.
4. **Authorized JavaScript origins**: add `https://<your-project>.pages.dev` (and your custom domain if you add one later).
5. Copy the **Client ID**.
6. Cloudflare → your Pages project → **Settings → Variables and Secrets** → add variable **`GOOGLE_CLIENT_ID`** = your Client ID.
7. Retry the latest deployment. The **Continue with Google** button appears on the login screen.

If someone registered with email and later uses Google with the same verified email, both open the same journal.

---

## Updating the app
Push changes to GitHub — Cloudflare Pages deploys automatically. Your D1 data and R2 images are not affected.
If a future version adds new tables, run its SQL once in the D1 console.

## Backups
- **D1:** Cloudflare keeps point-in-time history (*Time Travel*) for recent days. For your own copy: `npx wrangler d1 export trade-journal-db --remote --output=backup.sql`.
- **In the app:** *Settings → Full backup* downloads everything including images — do this now and then.

## Optional: run it locally
```bash
npm install
cp wrangler.toml.example wrangler.toml     # fill in your D1 database_id
npm run db:local                           # create local tables
npm run dev                                # http://localhost:8788
```
Don't commit `wrangler.toml` if you use dashboard bindings — when it exists in the repo, Cloudflare uses it instead of the dashboard settings (it's in `.gitignore`).

## Free plan notes
Cloudflare's free plans (Pages, Functions, D1, R2) cover a personal journal comfortably, but limits and terms change — check Cloudflare's current pricing. On the free Workers plan each request has a small CPU budget; password hashing is tuned for it (50,000 PBKDF2 iterations). If you ever see "exceeded CPU" errors on login, upgrade the plan or lower `ITERATIONS` in `lib/core.js`.

## Security
- Passwords: PBKDF2-SHA256 with random salt. Sessions: random token in an httpOnly, Secure, SameSite cookie; only its hash is stored.
- Every query is filtered by the logged-in user; images are served only to their owner.
- Login attempts are limited (30 per 15 minutes per IP).
- Uploads: JPG/PNG/WEBP/GIF only, max 10 MB, random file names. Unused uploads are cleaned up automatically.
- `DELETE /api/account` deletes a user with all data and images.

Trading involves risk. This app is a journal and coaching tool, not financial advice.

---

## Chart tab (price data)

The **Chart** tab shows candles with a Long/Short position tool: drag Entry / SL / TP, see pips, R:R, risk $ and risk %, then **Log this trade** to open the trade form already filled in. Any saved trade can be shown on the chart with *View this trade on the chart* (entry/exit markers and its SL/TP lines).

Price data comes from **Twelve Data** (free plan, prices may be delayed):
1. Create a free account at twelvedata.com and copy your **API key**.
2. Cloudflare → your Pages project → **Settings → Variables and Secrets** → add **`TWELVEDATA_API_KEY`** (type **Secret**) → paste the key.
3. **Deployments → Retry deployment**, then open the Chart tab.

Prices are cached at Cloudflare (60 s for live charts, 1 day for history) so the free request limit goes further. If a symbol doesn't load, set its **Chart data symbol** in *Settings → Instrument settings* (e.g. `XAU/USD`, `EUR/USD`). Some symbols (indices, oil) may need a paid data plan — check Twelve Data's current plans.

Charts use TradingView Lightweight Charts™ (Apache 2.0). The TradingView attribution link on the chart is required by its licence — keep it.

---

## News on the dashboard

The **Economic news** card shows today's (or this week's) events for the currencies of your **favourite pairs** (★ in the pair picker), with time in your timezone, countdown, impact, forecast and previous. Filters: *Today / This week*, *My pairs / All*, *High / High + Medium*.

- A warning banner appears when a high-impact event for your pairs is coming within the **news warning window** (default 30 min, change it in *Settings → Risk rules*), and for 15 minutes after the release.
- In the trade form, a warning appears if the entry time is within that window of high-impact news for the trade's currencies.
- The **News checked** rule ticks itself automatically for trades in the dates covered by the feed (this week and next week); older trades stay manual.

Data comes from the public **Forex Factory** weekly calendar feed (no API key needed), cached at Cloudflare for 1 hour. It is an unofficial feed, so it can change or be unavailable at times — the card then shows a message and the rest of the app keeps working. Always double-check event times before trading.
