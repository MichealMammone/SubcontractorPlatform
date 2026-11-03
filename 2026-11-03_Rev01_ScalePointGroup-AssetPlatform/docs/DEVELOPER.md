# Developer guide

## Code layout

```
src/
  server.js            process entry (HTTP server, housekeeping, graceful shutdown)
  app.js               Express app: helmet CSP, static files, /api router, error handler
  config.js / db.js    environment configuration; pg pool, one(), tx()
  lib/http.js          HttpError helpers, ah() async wrapper, input readers, paging
  lib/security.js      scrypt hashing, tokens, password policy
  middleware/auth.js   sessions, CSRF, requireAuth, requirePerm, rate limiting
  routes/*.js          HTTP layer (validation, permission checks, audit calls)
  services/*.js        business logic: registers, matching, inspections, reports, exports, settings, audit, rbac, mailer
shared/                pure ES modules used by both server and browser
  engine.js            matching engine
  report-parser.js     PDF text -> findings
  register-fields.js   register field definitions and auto-mapping
public/
  index.html, css/app.css, img/logo.svg
  js/main.js           boot, session, hash router, shell
  js/api.js, ui.js     fetch wrapper; safe templating (h``), modals, drawers, components
  js/views/*.js        one module per area; each export renders a route
```

## Conventions

* **Every query is tenant-scoped**: include `organisation_id = req.user.orgId` (or join through a row that is).
* **Permissions are checked on the server** with `requirePerm('x.y')`. The front end only hides what the user cannot use.
* **Audit every change** with `audit(req, 'area.action', { entityType, entityId, summary, details })`; put before/after values in `details`.
* **Templating**: use `h\`...\`` (escapes interpolations); only wrap trusted markup in `raw()`.
* Front-end views receive `{ el, params, query, user, can, navigate, session }`; bind listeners on `el` (a fresh element per page).
* Keep `shared/` free of Node or DOM APIs so it runs in both places.

## Adding a permission

1. New migration, e.g. `db/migrations/003_add_permission.sql`:
   ```sql
   INSERT INTO permissions (key, category, description) VALUES ('reports.delete', 'Reports', 'Delete generated reports');
   INSERT INTO role_permissions (role_id, permission_key) VALUES (1, 'reports.delete');
   ```
2. Protect the route with `requirePerm('reports.delete')` and show the button only when `can('reports.delete')`.

## Adding a page

1. Create `public/js/views/thing.js` exporting `async function thing({ el, ... })`.
2. Add a route to `ROUTES` in `public/js/main.js` (and a `NAV` entry if it belongs in the menu).

## Supporting a new report layout

`shared/report-parser.js` recognises the common "Asset / Location | Result | Comments" table and falls back to
"description … PASS/FAIL" lines. For a new subcontractor format, add a detector in `interpretPages` and a unit test
with a small synthetic page in `tests/parser.test.js`. The *Extracted text* view (no assets found) helps.

## Tuning matching

Organisation settings (Settings page) override `DEFAULT_MATCHING` in `shared/engine.js`. Register tokens are computed when
a version is uploaded, so after changing synonyms, publish a new version (or re-upload) and use **Re-match** on reports.

## Local commands

```bash
npm run dev       # auto-restart on change (run npm run migrate && npm run seed first)
npm test          # unit tests
npm run migrate   # apply migrations
```
