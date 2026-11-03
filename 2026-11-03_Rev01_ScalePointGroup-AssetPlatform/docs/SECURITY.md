# Security

## Controls in the code

| Area | Control |
|---|---|
| Passwords | scrypt (N=32768, r=8, p=1, 16-byte salt), timing-safe compare; policy of 12+ characters and 3 character classes, no email name, no common prefix |
| Sign-in | Generic error messages; dummy hash for unknown emails (no account enumeration by timing); per-IP rate limit; lockout after 5 failures for 15 minutes |
| Sessions | Random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` cookie; only its SHA-256 stored; 60-min idle and 12-h absolute expiry; revoked on password change, disable, role change and delete |
| CSRF | Per-session token required in `X-CSRF-Token` on every state-changing API call, plus SameSite cookies |
| Authorisation | RBAC permissions enforced server-side on every route; admins can only manage lower roles; all data scoped by organisation |
| Password reset | One-time, hashed, expiring tokens; links delivered by email (if SMTP configured) or issued by an admin |
| Headers | Helmet: strict CSP (`script-src 'self'`, no inline scripts), HSTS, frame-ancestors none, no-sniff, referrer policy |
| Input | Server re-validates browser-extracted data; size limits on bodies and files; PDF magic-number check; LIKE wildcard escaping; parameterised SQL throughout |
| Output | Front-end templating escapes by default; CSV formula-injection neutralised; filenames sanitised |
| Errors | Internal error details are logged, not returned, in production |
| Audit | Logins, failed logins, lockouts, user changes, register upload/publish/reject/rollback/export, asset changes, inspections, corrections, report generation/approval/export, settings changes |
| Dependencies | Local copies of front-end libraries (no third-party CDN at runtime); SheetJS from the official CDN tarball (the npm 0.18 build has known advisories) |

## Operational checklist

- [ ] Repository is private; `.env` never committed.
- [ ] Remove `SEED_ADMIN_PASSWORD` from Render after the first sign-in.
- [ ] Demo accounts disabled (`SEED_DEMO_USERS=false`) in production.
- [ ] Custom domain with HTTPS; `APP_BASE_URL` set.
- [ ] Database on a paid plan with backups; restore tested.
- [ ] At least two Super Admins (avoid lock-out); review the user list quarterly.
- [ ] Turn on **Require a second approver** if your governance requires four-eyes approval of register changes.
- [ ] Review the audit log export periodically; retain per your records policy.
- [ ] Confirm the hosting region meets client contractual and privacy requirements.
- [ ] Run `npm audit` before each release.
