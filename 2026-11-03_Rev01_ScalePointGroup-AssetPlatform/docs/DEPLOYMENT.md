# Deployment guide: GitHub + Render

The platform is one Node.js web service and one PostgreSQL database. `render.yaml` (a Render **Blueprint**) creates both.

## 1. Put the code on GitHub

```bash
cd spg-asset-platform
git init
git add .
git commit -m "Scale Point Group platform v1.0"
git branch -M main
git remote add origin https://github.com/<your-account>/spg-asset-platform.git
git push -u origin main
```

Keep the repository **private**. `.env` is git-ignored: never commit secrets.

## 2. Create the services on Render

1. Sign in at https://dashboard.render.com, then click **New → Blueprint**.
2. Connect GitHub and choose the repository. Render reads `render.yaml` and proposes:
   * **spg-asset-platform** (web service, Node, Singapore, Starter plan)
   * **spg-asset-db** (PostgreSQL 16, Basic 256 MB)
3. Fill in the prompted values:

| Variable | Value |
|---|---|
| `APP_BASE_URL` | `https://spg-asset-platform.onrender.com` (or your custom domain), used in reset links |
| `SEED_ADMIN_EMAIL` | the first Super Admin's email |
| `SEED_ADMIN_PASSWORD` | strong temporary password; you must change it at first sign-in |
| `SEED_DEMO_PASSWORD` | only if you set `SEED_DEMO_USERS=true` for a demo environment |
| `SMTP_*` | optional, for password-reset emails (e.g. Microsoft 365 SMTP, SendGrid, Mailgun) |

4. Click **Apply**. The first deploy installs dependencies, runs migrations, creates the organisation and the Super Admin,
   and starts the server. Health checks use `/healthz`.
5. Open the service URL and sign in.

After the first successful sign-in, remove `SEED_ADMIN_PASSWORD` from the environment (the seed never changes existing users).

## 3. Environment variables (full list)

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `production` | Enables secure cookies, HSTS, hides internal errors |
| `PORT` | set by Render | HTTP port |
| `APP_BASE_URL` | — | Public URL for links in emails |
| `DATABASE_URL` | from database | PostgreSQL connection string |
| `DATABASE_SSL` | `false` | `true` for external (non-Render-internal) connections |
| `DB_POOL_MAX` | `8` | Connections per instance |
| `SESSION_IDLE_MINUTES` | `60` | Sign-out after inactivity |
| `SESSION_MAX_HOURS` | `12` | Absolute session lifetime |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES` | `5` / `15` | Account lockout |
| `RESET_TOKEN_HOURS` | `24` | Admin-issued reset link lifetime |
| `MAX_UPLOAD_MB` | `50` | Largest PDF / register file |
| `SEED_ORG_NAME` | `Scale Point Group` | First organisation name |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | — | First Super Admin (only when no users exist) |
| `SEED_DEMO_USERS` / `SEED_DEMO_PASSWORD` / `SEED_DEMO_DOMAIN` | `false` | Demo accounts |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | — | Optional email |

## 4. Custom domain

Render → service → **Settings → Custom Domains** → add `assets.scalepointgroup.com.au` (example) → create the CNAME
record at your DNS provider. TLS certificates are issued automatically. Update `APP_BASE_URL`.

## 5. Sizing and cost control

* **Starter (512 MB, 0.5 CPU)** is enough for one organisation: PDFs are read in the user's browser, so the server only
  matches and stores structured data.
* Register uploads are streamed in 2,000-row batches; memory stays flat even for 500k-asset registers.
* Scale **vertically** (Standard plan) for heavy concurrent use, or **horizontally** (more instances). Sessions live in
  PostgreSQL, so instances are stateless. The login rate limiter is per instance; account lockout is global.
* Upgrade the database plan as data grows. Storage estimate: ~2 KB per asset per register version, ~3 KB per finding,
  plus the original PDFs (can be turned off in Settings).

## 6. Backups and disaster recovery

* Render PostgreSQL paid plans include daily backups with point-in-time recovery. Check the retention for your plan.
* For an independent copy: `pg_dump "$EXTERNAL_DATABASE_URL" -Fc -f spg-$(date +%F).dump` on a schedule.
* Restore: create a new database, `pg_restore -d "$NEW_URL" spg-YYYY-MM-DD.dump`, point `DATABASE_URL` at it.

## 7. Deploying updates

Push to `main`: Render builds and deploys automatically (`autoDeploy: true`), running new migrations on start.
Zero-downtime deploys require migrations to be backward compatible. See [UPGRADE.md](UPGRADE.md).

## 8. Data location

The Blueprint uses Render's **Singapore** region, the nearest to Australia. Confirm this meets your clients'
data-handling requirements before loading client registers. Change `region` in `render.yaml` before the first deploy if needed.
