# User guide

The in-app **Help centre** (left menu → Help centre) holds the full step-by-step guides with screenshot placeholders.
This page summarises them for training and onboarding.

## Roles

| | Super Admin | Administrator | Standard User | Read Only |
|---|:-:|:-:|:-:|:-:|
| Dashboard, view reports, search assets | ✓ | ✓ | ✓ | ✓ |
| Upload inspection reports, correct matches | ✓ | ✓ | ✓ | |
| Generate and export reports | ✓ | ✓ | ✓ | |
| Approve reports for client delivery | ✓ | ✓ | | |
| Manage Standard / Read Only users, analytics | ✓ | ✓ | | |
| Upload, approve, roll back registers; edit assets | ✓ | | | |
| Audit logs, settings, delete users, manage admins | ✓ | | | |

## Everyday workflow

1. **Upload inspection** → drop the subcontractor PDF. A progress bar shows the pages being read.
2. The inspection page opens with counts: matched, flagged for review, not in register. The assessment date is read from the report.
3. Check **Flagged for review** items (optional): click a row → confirm, choose a candidate, search the register, or mark as not in the register.
4. **Generate report** → title, prepared for, prepared by.
5. **Export** PDF (client copy), Excel or CSV. If approval is required, an Administrator clicks **Approve for client delivery** first; drafts are watermarked.

## Generated register columns

Asset ID · Asset Description · Asset Condition (as stated in the report) · Assessment Date · Inspection Notes ·
Page Number Found · Match Confidence · Report Reference (plus Status, Description in Report, Inspection Findings and
Matching Notes in Excel/CSV). Items flagged for review are listed again in a separate section with the reason.

## Asset Register Hub (Super Admin)

* Upload the confirmed register only when it changes: **Register Hub → Upload new register → map columns → Validate & compare**.
* Review the changes (added, updated, removed, description changes, possible Asset ID changes, duplicates, data issues; side-by-side).
* **Approve & publish**: the new version becomes active and the old one is archived. **Restore this version** rolls back.
* **Assets**: search, add, edit, archive / restore, bulk import / update, and view each asset's version and inspection history.

## Administration

* **Users**: create (a temporary password is shown once), edit role, reset password (one-time link), unlock, disable, delete.
* **Audit log**: filter by text, action, date; open the "change record" for before/after details; export CSV.
* **Settings**: matching weights and bands, synonyms, report defaults and approval rule, second-approver rule, file storage.

## Demo accounts

Enabled with `SEED_DEMO_USERS=true` and `SEED_DEMO_PASSWORD` (see INSTALLATION.md). Emails use `SEED_DEMO_DOMAIN`
(default `demo.spg.local`):

| Email | Role |
|---|---|
| `demo.superadmin@demo.spg.local` | Super Admin |
| `demo.admin@demo.spg.local` | Administrator |
| `demo.user@demo.spg.local` | Standard User |
| `demo.readonly@demo.spg.local` | Read Only |

All four use the `SEED_DEMO_PASSWORD` you set. Use demo accounts only in a separate demo deployment, never alongside client data.
