# Scale Point Group — Asset Inspection & Register Management Platform

A multi-user web platform that keeps a **permanent, version-controlled master asset register** and turns subcontractor
inspection reports (PDF) into **client-ready condition registers** automatically.

```
Asset Register Hub (master data)  +  Inspection report (input)  →  Generated register (output)
```

## What it does

| Area | Highlights |
|---|---|
| **Asset Register Hub** | Upload once; validate → compare → change review (added / updated / removed / duplicates / ID changes / integrity issues, side-by-side) → approve → publish. Previous versions archived; compare, export, roll back. |
| **Asset management** | Search, add, edit, archive, restore, bulk import / update, per-asset version and inspection history. |
| **Inspection processing** | Upload only the report. Assets identified, matched to the active register with confidence scores and plain-English reasons; assessment date and page numbers extracted automatically. |
| **Review** | Flagged items, candidate comparison, manual correction (audited), re-match against a newer register. |
| **Reports** | Frozen snapshots; branded PDF, Excel and CSV; draft → approval workflow; export history; re-download. |
| **Security** | Server-side sessions, CSRF protection, scrypt password hashing, lockout, RBAC (4 roles, 21 permissions) enforced on every API call, full audit log. |
| **Admin & insight** | User management dashboard, audit log (filter + CSV export), executive analytics, global search, settings. |
| **SaaS-ready** | Every table is scoped by `organisation_id`; tenants, client users and client registers need no schema change. |

## Stack

Node.js 20 · Express 4 · PostgreSQL 16 (Render) · vanilla ES-module front end (no build step) ·
PDF.js (browser-side PDF reading) · SheetJS · jsPDF · Chart.js. One web service + one database on Render.

## Quick start (local)

```bash
cp .env.example .env          # set DATABASE_URL, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD
npm install
npm start                     # migrates, seeds the first Super Admin, starts on http://localhost:3000
npm test                      # unit tests (no database needed)
```

## Documentation

| Guide | Contents |
|---|---|
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Local installation and first run |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | GitHub + Render deployment, environment variables, custom domain, backups |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | How to use every module, demo accounts |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture diagrams, matching engine, data flow, scaling, multi-tenancy |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema reference and ER diagram |
| [docs/DEVELOPER.md](docs/DEVELOPER.md) | Code layout, conventions, adding features and permissions |
| [docs/SECURITY.md](docs/SECURITY.md) | Security controls and operational checklist |
| [docs/TESTING.md](docs/TESTING.md) | Automated tests and the manual acceptance checklist |
| [docs/UPGRADE.md](docs/UPGRADE.md) | Upgrading, migrations, rollback, roadmap |

## Repository layout

```
db/migrations/        SQL migrations (applied automatically on start)
scripts/              migrate.js, seed.js
shared/               matching engine, report parser, register fields (used by server AND browser)
src/                  Express app: config, db, middleware, routes, services
public/               branded web front end (index.html, css, js/views)
tests/                node:test unit tests
docs/                 guides
render.yaml           Render Blueprint (web service + PostgreSQL)
```

© Scale Point Group. All rights reserved.
