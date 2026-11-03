# Installation guide (local / development)

You only need a local install to develop or test changes. Production runs on Render (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## Prerequisites

* **Node.js 20 LTS** (20.12 or later) or 22: https://nodejs.org
* **PostgreSQL 14+** with the `pg_trgm` extension (bundled with standard PostgreSQL). Options:
  * install PostgreSQL locally, or
  * run `docker run -d --name spg-db -e POSTGRES_USER=spg_app -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=spg_assets -p 5432:5432 postgres:16`, or
  * create a free development database on Render and use its **External Database URL** (set `DATABASE_SSL=true`).
* **Git**

## Steps

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/<your-account>/spg-asset-platform.git
   cd spg-asset-platform
   npm install
   ```
   Commit the generated `package-lock.json` (then switch the Render build command to `npm ci --omit=dev`).
2. Create `.env` from the template and fill in at least:
   ```
   DATABASE_URL=postgres://spg_app:change-me@localhost:5432/spg_assets
   SEED_ADMIN_EMAIL=you@example.com
   SEED_ADMIN_PASSWORD=<12+ characters, three of: lower, upper, number, symbol>
   ```
3. Start:
   ```bash
   npm start          # = migrate + seed + server
   # or, with auto-reload while developing:
   npm run migrate && npm run seed && npm run dev
   ```
4. Open http://localhost:3000, sign in with the seed admin, and choose a new password when prompted.

## First data

1. **Register Hub → Upload new register**: upload the confirmed master register (e.g. the Maximo "List of Assets" export).
2. Review the change summary → **Approve & publish**.
3. **Upload inspection**: drop a subcontractor PDF. The inspection register is ready to generate and export.

## Demo accounts

Set `SEED_DEMO_USERS=true` and `SEED_DEMO_PASSWORD=<strong password>` before starting. Four accounts are created
(`demo.superadmin@`, `demo.admin@`, `demo.user@`, `demo.readonly@` + `SEED_DEMO_DOMAIN`), one per role, all with that
password. Turn this off for production.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `DATABASE_URL is not set` | Create `.env` in the project folder (it is loaded automatically) or set the environment variable. |
| `extension "pg_trgm" is not available` | Install the PostgreSQL contrib package (`postgresql-contrib`). |
| `SEED_ADMIN_PASSWORD needs …` | Use a stronger password. |
| Port in use | Set `PORT=3001`. |
