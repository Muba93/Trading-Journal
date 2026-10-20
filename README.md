# Trade Journal

A personal trading journal web app: trades with automatic pips / risk / P&L, rules, reviews, prop firm challenge journeys, money tracking (deposits, withdrawals, fees, payouts), weekly notes, calendar and performance dashboard.

- **Backend:** Node.js + Express
- **Database:** MySQL (or MariaDB)
- **Login:** email + password, optional **Google sign-in**
- **Images:** chart screenshots are saved as files in the `uploads/` folder; their path and URL are stored in MySQL (`trade_images` table)
- **AI coaching:** the "Ask Claude" chat copies your question together with your journal data and opens Claude, so you get coaching with your own Claude account

---

## Project structure

```
trade-journal/
├─ public/
│  ├─ index.html            ← the whole app (UI)
│  └─ vendor/               ← Chart.js and SheetJS (charts, Excel import/export)
├─ server/
│  ├─ index.js              ← Express server: login, API, image uploads
│  ├─ db.js                 ← MySQL connection
│  ├─ schema.sql            ← database tables
│  └─ init-db.js            ← creates the database from schema.sql
├─ uploads/                 ← chart images are saved here (not committed to GitHub)
├─ .env.example             ← copy to .env and fill in
├─ package.json
└─ README.md
```

### Database tables

| Table | What it stores |
|---|---|
| `users` | Email, name, password hash (bcrypt) or Google ID |
| `settings` | Accounts/platforms, rules, goals, sessions, setups (one row per user, JSON) |
| `trades` | One row per trade. Main fields (pair, direction, entry/exit time and price, lot, SL/TP, fees, rating) are real columns; the full trade is also kept in `data` (JSON) |
| `trade_images` | One row per chart image: `file_path` (e.g. `3/2026-10/abc….jpg`), `url`, trade it belongs to, before/after, size |
| `transactions` | Deposits, withdrawals, challenge fees, payouts, fee refunds |
| `weekly_notes` | Weekly review notes and goals |

Images are saved as `uploads/<userId>/<YYYY-MM>/<random-id>.jpg`. They are **private**: only the logged-in owner can open them.

---

## 1. Run it on your computer

**You need:** [Node.js 18+](https://nodejs.org) and MySQL 8 (or MariaDB 10.5+). On Windows, [XAMPP](https://www.apachefriends.org) or [MySQL Installer](https://dev.mysql.com/downloads/installer/) are easy ways to get MySQL.

```bash
# 1. Install packages
npm install

# 2. Create your settings file
cp .env.example .env          # on Windows: copy .env.example .env
#    Open .env and set DB_USER / DB_PASSWORD, and a long random JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 3. Create the database and tables
npm run db:init

# 4. Start the app
npm start
```

Open **http://localhost:3000**, click **Create an account**, and you're in.

**Bring your existing data:** in your old journal (the Claude version) go to *Settings → Full backup → Download full backup*. In this app go to *Settings → Restore from backup* and choose **Replace my journal**. Trades, screenshots (saved into `uploads/`), accounts, journeys, transactions and weekly notes are all imported.

---

## 2. Optional: Google sign-in

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. *APIs & Services → OAuth consent screen*: choose **External**, fill in the app name and your email, save.
3. *APIs & Services → Credentials → Create credentials → OAuth client ID*, type **Web application**.
4. Under **Authorized JavaScript origins** add your site address, e.g. `http://localhost:3000` and later `https://your-domain.com`.
5. Copy the **Client ID** into `.env`:
   ```
   GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
   ```
6. Restart the server. A **Continue with Google** button appears on the login screen.

If someone first registered with email and later uses Google with the same (verified) email, both logins open the same journal.

---

## 3. Put the code on GitHub

```bash
git init
git add .
git commit -m "Trade Journal"
git branch -M main
git remote add origin https://github.com/<your-username>/trade-journal.git
git push -u origin main
```

`.gitignore` already keeps these **out of GitHub**: `.env` (passwords and secrets), `node_modules/`, and the `uploads/` images. Never commit `.env`.

---

## 4. Put it online

This app needs a host that runs **Node.js** and a **MySQL** database (static hosts like Netlify/GitHub Pages can't run it). Options:

- **VPS** (DigitalOcean, Hetzner, Contabo, AWS Lightsail…): install Node + MySQL, clone from GitHub, `npm install`, `npm run db:init`, run with [PM2](https://pm2.keymetrics.io/) (`pm2 start server/index.js --name trade-journal`) behind Nginx with a free Let's Encrypt HTTPS certificate.
- **Platforms** such as Railway or Render (Node app) together with a hosted MySQL database. Point the `DB_*` values in your environment variables to that database.
- **cPanel shared hosting** that offers "Setup Node.js App" plus MySQL also works.

Important for any host:
- Set `NODE_ENV=production` and serve the site over **HTTPS** (login cookies are marked secure in production).
- Set all `.env` values as environment variables on the host.
- The `uploads/` folder must be on **persistent storage** and be **backed up** together with the database. Some platforms wipe files on every deploy — attach a persistent volume there, or your images will be lost.
- Back up MySQL regularly (e.g. `mysqldump trade_journal > backup.sql`).

Prices and free plans of hosting providers change often — check their current offers.

---

## Updating the app

Edit the code (or get a new version), then:

```bash
git add .
git commit -m "Update"
git push
```

On a VPS: `git pull && npm install && pm2 restart trade-journal`. Your database and images are not affected.

---

## Security notes

- Passwords are hashed with bcrypt; sessions are signed JWTs in an httpOnly cookie (30 days).
- Every API query is filtered by the logged-in user, so users can never read each other's data or images.
- Login/register are rate-limited (30 attempts per 15 minutes per IP).
- Uploads: images only (JPG, PNG, WEBP, GIF), max 10 MB, random file names.
- Images uploaded but never attached to a saved trade are deleted automatically after one day.
- `DELETE /api/account` removes a user and all their data and images.

## API overview

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Google client ID (if enabled) |
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/google` · `/api/auth/logout` | Login |
| GET | `/api/auth/me` | Current user |
| GET | `/api/data` | All of the user's journal data |
| PUT | `/api/settings` | Save settings |
| PUT / DELETE | `/api/trades/:id` | Save / delete a trade (and its images) |
| PUT / DELETE | `/api/cash/:id` | Save / delete a money transaction |
| PUT / DELETE | `/api/weeks/:weekStart` | Save / delete a weekly note |
| POST | `/api/upload` | Upload a chart image → `{ id, url }` |
| GET | `/uploads/:userId/:month/:file` | View an image (owner only) |
| DELETE | `/api/account` | Delete account and all data |

Trading involves risk. This app is a journal and coaching tool, not financial advice.
