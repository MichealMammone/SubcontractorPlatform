# Testing guide

## Automated tests

```bash
npm install
npm test
```

Uses Node's built-in test runner (no extra dependencies, no database needed):

| File | Covers |
|---|---|
| `tests/engine.test.js` | The specification example (`SB,DBS05, Z13 - Sprinkler Deluge Valve` → `Deluge Valve S (ZONE 13)`), zone/carriageway conflicts, description-zone priority, `ZONES 11&12`, identical-description ambiguity, location-code IDs, decommissioned penalty, token round trip, shortlist filtering |
| `tests/parser.test.js` | Date formats, page ranges, extraction from a synthetic report, merge rules, auto-mapping of the confirmed Maximo headings, mapping carry-over |
| `tests/security.test.js` | Password hashing/policy, temporary passwords, CSV formula neutralisation, RBAC matrix |
| `tests/exports.test.js` | PDF, Excel and CSV generation for a sample report |

## Manual acceptance checklist (staging deployment)

Use a separate Render deployment with demo accounts enabled.

**Authentication & security**
- [ ] Sign in as each demo role; the menu shows only permitted areas; a direct URL to a forbidden page shows "No access".
- [ ] Five wrong passwords lock the account; Admin **Unlock** works; the audit log shows failed logins and the lockout.
- [ ] New user → temporary password shown once → first sign-in forces a password change.
- [ ] Reset-password link works once and then reports "invalid or expired".
- [ ] Disabling a signed-in user signs them out on their next action.

**Asset Register Hub**
- [ ] Upload the Maximo register (6,804 assets): columns auto-map; change review shows 6,804 added.
- [ ] Approve: Hub shows version 1 active, 6,804 total assets.
- [ ] Upload a modified copy (edit 3 descriptions, delete 2 rows, add 1 row, duplicate 1 Asset ID): review shows 1 added, 3 updated (side-by-side), 2 removed, 1 duplicate.
- [ ] Approve → v2 active, v1 archived; **Compare** v1→v2 matches; **Restore** v1 works; exports open in Excel.
- [ ] Standard user cannot see the upload button and receives 403 from `POST /api/registers/staging`.

**Inspections & reports**
- [ ] Upload the R-80685 PDF as a Standard user: progress shows pages; the inspection opens with counts and an assessment date of the report date.
- [ ] Deluge valve `SB,DBS05, Z13` is matched to `A1004034`; hydrant entries without numbers are flagged for review with "other assets scored within …".
- [ ] Confirm, assign via search, and reject one item each; counts update; the audit log has before/after records.
- [ ] Generate report as a Standard user → Draft; PDF is watermarked DRAFT; Admin approves; the PDF is clean; export history lists both exports.
- [ ] Re-download gives identical content; reports search/filter by asset, condition, user, date and version work.

**Admin & analytics**
- [ ] User dashboard metrics match reality; audit log filters and CSV export work; analytics charts render.
- [ ] Settings changes are saved and audited; changing thresholds affects new uploads or a Re-match.

**Responsive**
- [ ] Phone width: the menu collapses behind the ☰ button; tables scroll horizontally; forms stack.
