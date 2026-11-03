// Help centre: onboarding guides, FAQs and troubleshooting. Screenshot placeholders are marked for replacement.
import { h, raw } from '../ui.js';

const shot = (label) => h`<div class="shot">Screenshot placeholder: ${label}</div>`;

const TOPICS = [
  ['first-login', 'First login', () => h`
    <h2>First login</h2>
    <ol><li>Open the platform address your administrator gave you and sign in with your email and the temporary password.</li>
      <li>You are asked to choose your own password straight away: at least 12 characters using three of lower-case, upper-case, numbers and symbols.</li>
      <li>The dashboard opens. The menu on the left only shows the areas your role can use.</li></ol>
    ${shot('Sign-in page and first-login password change')}
    <h3>Roles at a glance</h3>
    <ul><li><b>Super Admin</b>: everything, including the Asset Register Hub, approvals, users, audit logs and settings.</li>
      <li><b>Administrator</b>: uploads and approves inspection reports, manages Standard and Read Only users, dashboards.</li>
      <li><b>Standard User</b>: uploads inspection reports, generates and exports registers.</li>
      <li><b>Read Only</b>: views reports and asset data and searches records.</li></ul>`],
  ['register-hub', 'Asset Register Hub', () => h`
    <h2>The Asset Register Hub</h2>
    <p>The Hub holds the master asset register: the single source of truth every inspection is matched against. You do not upload the register with each report; it stays stored until a newer confirmed version is approved.</p>
    <ul><li><b>Dashboard</b>: total, active, archived, new, modified and removed assets, last update and active version.</li>
      <li><b>Versions</b>: every version with upload date, uploader, asset count, status and notes. Open one to compare, export or restore it.</li>
      <li><b>Assets</b>: search and maintain individual assets.</li></ul>
    ${shot('Asset Register Hub dashboard')}`],
  ['upload-register', 'Uploading a new asset register', () => h`
    <h2>Uploading a new asset register (Super Admin)</h2>
    <ol><li>Go to <b>Register Hub → Upload new register</b>.</li>
      <li>Drop the Excel or CSV file. The sheet and header row are detected automatically.</li>
      <li>Check the column mapping. Asset ID and Asset Description are required. Every other column is kept with each asset.</li>
      <li>Add notes for the approver and click <b>Validate &amp; compare</b>. The file is checked in batches.</li>
      <li>The change review opens: assets added, updated, removed, description changes, possible Asset ID changes, duplicates and data-integrity issues, with side-by-side comparisons.</li></ol>
    ${shot('Column mapping step')}
    <p>Nothing changes for other users until the version is approved and published.</p>`],
  ['update-register', 'Updating an existing register', () => h`
    <h2>Approving, publishing and rolling back</h2>
    <ol><li>Open the version awaiting approval (a banner appears on the dashboard and in the Hub).</li>
      <li>Review each change category. Duplicate Asset IDs and rows without an Asset ID are excluded automatically.</li>
      <li>Click <b>Approve &amp; publish</b>. The new version becomes the active register and the previous one is archived.</li>
      <li>To undo, open the archived version and click <b>Restore this version</b>. The current version is archived, so no data is lost.</li></ol>
    <p>If the "second approver" setting is on, a different Super Admin must approve.</p>${shot('Change review with side-by-side comparison')}`],
  ['upload-inspection', 'Uploading inspection reports', () => h`
    <h2>Uploading an inspection report</h2>
    <ol><li>Click <b>Upload inspection</b>.</li><li>Drop the subcontractor PDF. It is read in your browser (a progress bar shows the page count) and the results are sent to the platform.</li>
      <li>Every asset in the report is matched against the active register automatically. The assessment date is read from the report.</li>
      <li>The inspection page opens with matched, flagged and unmatched counts.</li></ol>
    <h3>Reviewing flagged items</h3>
    <p>Items below the auto-accept confidence are marked <b>Review</b> with a confidence score and a plain-English reason (for example "zone differs"). Click a row to see the comparison and candidates, then confirm, choose another asset, search the register, or mark it as not in the register. Every change is audited.</p>
    ${shot('Inspection review with drill-down drawer')}`],
  ['generate', 'Generating reports', () => h`
    <h2>Generating the inspection register</h2>
    <ol><li>On the inspection page click <b>Generate report</b>.</li><li>Confirm the title, client ("prepared for") and "prepared by".</li>
      <li>The register lists Asset ID, Asset Description, Asset Condition, Assessment Date, Inspection Notes, Page Number, Match Confidence and Report Reference.</li></ol>
    <p>The report is a frozen snapshot: re-downloading it later gives identical files even if the register changes. Generate again to produce a new revision.</p>
    <p>When approval is required, reports by Standard Users are drafts (watermarked) until an Administrator approves them.</p>`],
  ['export', 'Exporting reports', () => h`
    <h2>Exporting</h2>
    <ul><li><b>PDF</b>: branded client copy with summary, colour-coded conditions, flagged-items section and notes.</li>
      <li><b>Excel</b>: register sheet, flagged-for-review sheet and summary sheet.</li><li><b>CSV</b>: flat table for other systems.</li></ul>
    <p>Files are named <code>YYYY-MM-DD_RevNN_InspectionRegister_&lt;report&gt;</code>. Every export is recorded in the report's export history.</p>`],
  ['users', 'User management', () => h`
    <h2>User management</h2>
    <ol><li>Go to <b>Users → Create user</b>. Enter name, email and role. Leave the password blank to generate a temporary one (shown once).</li>
      <li>Use <b>Reset password</b> to issue a one-time link (emailed when email is configured; otherwise copy it to the user securely).</li>
      <li><b>Disable</b> signs the user out immediately; <b>Delete</b> removes the account but keeps its audit history.</li>
      <li>Accounts lock for 15 minutes after repeated failed sign-ins; use <b>Unlock</b> to release them early.</li></ol>`],
  ['permissions', 'Permissions', () => h`
    <h2>Permissions</h2>
    <table class="table"><thead><tr><th>Capability</th><th>Super Admin</th><th>Administrator</th><th>Standard</th><th>Read Only</th></tr></thead><tbody>
      ${[['View dashboards & reports', 1, 1, 1, 1], ['Search assets', 1, 1, 1, 1], ['Upload inspection reports', 1, 1, 1, 0], ['Correct matches', 1, 1, 1, 0], ['Generate & export reports', 1, 1, 1, 0],
        ['Approve reports', 1, 1, 0, 0], ['Manage standard users', 1, 1, 0, 0], ['Analytics', 1, 1, 0, 0], ['Upload / approve / roll back registers', 1, 0, 0, 0], ['Edit assets', 1, 0, 0, 0],
        ['Audit logs', 1, 0, 0, 0], ['Settings', 1, 0, 0, 0], ['Delete users', 1, 0, 0, 0]].map((r) => h`<tr><td>${r[0]}</td>${r.slice(1).map((x) => h`<td>${x ? '✓' : '—'}</td>`)}</tr>`)}
    </tbody></table><p class="small muted mt8">Permissions are enforced by the server on every request, not just hidden in the menu.</p>`],
  ['faq', 'Frequently asked questions', () => h`
    <h2>Frequently asked questions</h2>
    <h3>Do I need to upload the asset register each time?</h3><p>No. The active register in the Hub is used automatically. Only upload a register when a newer confirmed version is issued.</p>
    <h3>Why is an item flagged for review?</h3><p>Its best match scored below the auto-accept level, or two register assets scored almost the same (common for identically described assets such as hydrants). The reason is shown on the row.</p>
    <h3>What happens to old inspections when the register changes?</h3><p>Findings keep the Asset ID and description they were matched to, and stay linked to the asset. Use <b>Re-match</b> to match a report against the new register.</p>
    <h3>Where does the assessment date come from?</h3><p>From the date stated in the report (for example "performed on …"). If none is labelled, the first date on the first two pages is used and flagged for checking.</p>
    <h3>Which page number is shown?</h3><p>The page where the condition rating was recorded, or where the asset first appears if it was not rated.</p>`],
  ['troubleshooting', 'Troubleshooting', () => h`
    <h2>Troubleshooting</h2>
    <ul><li><b>"No assets were found"</b>: the PDF is probably a scanned image. Ask for a text-based PDF.</li>
      <li><b>"There is no active asset register"</b>: a Super Admin must publish the master register first.</li>
      <li><b>"Version N is still awaiting approval"</b>: approve or reject the pending upload before uploading another.</li>
      <li><b>"Your session token is out of date"</b>: refresh the page (you were signed in on another tab or the session expired).</li>
      <li><b>Locked account</b>: wait 15 minutes or ask an administrator to unlock it.</li>
      <li><b>Large registers</b>: very large files are sent in batches; keep the tab open until the change review appears.</li></ul>`]
];

export function help({ el, params }) {
  const topic = TOPICS.find((t) => t[0] === params.topic) || TOPICS[0];
  el.innerHTML = String(h`<div class="page-head"><div><h1>Help centre</h1><p>Guides for every part of the Scale Point Group platform.</p></div></div>
    <div class="help"><nav class="card help-nav">${TOPICS.map((t, i) => h`<a href="#/help/${t[0]}" class="${t === topic ? 'active' : ''}">${i + 1}. ${t[1]}</a>`)}</nav>
      <article class="card help-body">${topic[2]()}</article></div>`);
}
export { raw };
