# Upgrade guide

## Releasing a new version

1. Branch from `main`, make the change, add or extend tests, run `npm test`.
2. Database changes go in a **new** numbered migration (`db/migrations/003_….sql`). Never edit an applied migration.
3. Keep migrations backward compatible with the running code (add columns as nullable or with defaults, backfill, then
   switch the code, and drop old columns in a later release). Render runs migrations on start, before the new code
   takes traffic.
4. Bump `version` in `package.json`, merge to `main`, and Render deploys automatically.
5. Smoke test: sign in, open the Hub, open one inspection and one report, export a PDF.

## Rolling back

* **Code**: Render → service → **Events / Deploys** → choose the previous deploy → **Rollback**.
* **Database**: migrations are forward-only; write a corrective migration. For a serious incident, restore the
  pre-deploy backup (Render point-in-time recovery) into a new database and repoint `DATABASE_URL`.
* **Register data**: use **Restore this version** in the Hub. No code rollback is needed.

## Upgrading dependencies

```bash
npm outdated
npm install <package>@<version>
npm test
npm audit
```

Front-end libraries (PDF.js, SheetJS, Chart.js) are served from `node_modules`, so upgrading the package upgrades the
browser copy. PDF.js 4+ ships ES-module builds; update `public/js/pdf.js` if you move off 3.x.

## Moving from the browser-only tool (Rev01/Rev02)

1. Deploy the platform and create users.
2. Upload the confirmed master register in the Hub (column mapping carries the same field meanings), then approve it.
3. Re-upload any inspection PDFs whose results need to be kept on the platform. Session `.json` files from the old
   tool are not imported (they lack the stored PDF and approval trail).

## Roadmap (designed for, not yet built)

* Client organisations and portals (multi-tenant data model already in place): platform-owner console, per-tenant branding.
* Object storage (S3 / Cloudflare R2) for PDFs and register files instead of database `bytea`.
* Optional AI assistance for low-confidence matches and new report layouts (needs an API key, cost approval and a
  client data-handling decision).
* Maximo integration (MXAPI / REST) to pull the register and push condition updates or service requests.
* Scheduled email digests of breaches and pending approvals.
