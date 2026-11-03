// Administration portal: user management dashboard, audit log, platform settings.
import { get, post, patch, put, del, qs, download } from '../api.js';
import { h, raw, $, $$, toast, toastError, formDialog, confirmDialog, modal, fmtDate, fmtDateTime, ago, kpi, statusTag, empty, pager, esc } from '../ui.js';

/* ---------------- users ---------------- */
export async function users({ el, query, can, user: me }) {
  const page = +query.page || 1;
  const [list, roles, metrics] = await Promise.all([get('/users' + qs({ ...query, page })), get('/users/roles'), get('/users/metrics')]);
  const m = metrics.metrics;
  const assignable = roles.roles.filter((r) => me.role === 'super_admin' || r.level < me.level);
  const manageable = (u) => can('users.manage') && u.id !== me.id && (me.role === 'super_admin' || u.level < me.level);
  el.innerHTML = String(h`
    <div class="page-head"><div><h1>User management</h1><p>Create and manage staff accounts. Administrators can manage Standard and Read Only users; Super Admins manage everyone.</p></div>
      ${can('users.manage') ? h`<button class="btn btn-primary" id="newUser">Create user</button>` : ''}</div>
    <div class="kpis">
      ${kpi('Total users', m.total_users)}${kpi('Active users', m.active_users, m.active_30d + ' signed in within 30 days', 'ok')}${kpi('Signed in now', m.signed_in_now, '', 'grey')}
      ${kpi('Reports generated', m.reports_generated, '', 'ok')}${kpi('Reports uploaded', m.reports_uploaded, '', 'ok')}${kpi('Total assets', m.total_assets, '', '')}
      ${kpi('Register versions', m.register_versions, '', 'grey')}${kpi('Last login activity', m.last_login_at ? ago(m.last_login_at) : '—', m.last_login_at ? fmtDateTime(m.last_login_at) : '', 'grey')}
    </div>
    <div class="card flush">
      <form class="toolbar" id="filters"><input class="input" type="search" name="q" placeholder="Search name or email" value="${query.q || ''}">
        <select class="input" name="role"><option value="">All roles</option>${roles.roles.map((r) => h`<option value="${r.key}" ${query.role === r.key ? raw('selected') : ''}>${r.name}</option>`)}</select>
        <select class="input" name="status"><option value="">All statuses</option><option value="active" ${query.status === 'active' ? raw('selected') : ''}>Active</option><option value="disabled" ${query.status === 'disabled' ? raw('selected') : ''}>Disabled</option></select>
        <button class="btn btn-secondary btn-sm">Filter</button></form>
      ${list.users.length ? h`<div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th>Created</th><th></th></tr></thead><tbody>
        ${list.users.map((u) => h`<tr><td><div class="cell-main">${u.name}${u.id === me.id ? ' (you)' : ''}</div><div class="cell-sub">${u.email}</div></td><td>${statusTag(u.role_name, u.role === 'super_admin' ? 'blue' : u.role === 'admin' ? 'violet' : '')}</td>
          <td>${u.status === 'active' ? statusTag('Active', 'ok') : statusTag('Disabled', 'bad')} ${u.locked ? statusTag('Locked', 'warn') : ''} ${u.must_change_password ? statusTag('Must change password', '') : ''}</td>
          <td>${u.last_login_at ? h`${ago(u.last_login_at)}<div class="cell-sub">${u.last_login_ip || ''}</div>` : h`<span class="muted">Never</span>`}</td><td class="small">${fmtDate(u.created_at)}</td>
          <td class="nowrap num">${manageable(u) ? h`<button class="btn btn-ghost btn-sm" data-act="edit" data-id="${u.id}">Edit</button><button class="btn btn-ghost btn-sm" data-act="reset" data-id="${u.id}">Reset password</button>
            ${u.locked ? h`<button class="btn btn-ghost btn-sm" data-act="unlock" data-id="${u.id}">Unlock</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-act="${u.status === 'active' ? 'disable' : 'enable'}" data-id="${u.id}">${u.status === 'active' ? 'Disable' : 'Enable'}</button>
            ${can('users.delete') ? h`<button class="btn btn-ghost btn-sm" data-act="delete" data-id="${u.id}" style="color:var(--bad)">Delete</button>` : ''}` : ''}
            <button class="btn btn-ghost btn-sm" data-act="activity" data-id="${u.id}">Activity</button></td></tr>`)}
      </tbody></table></div>${pager(list.total, list.page, list.pageSize)}` : empty('No users found')}
    </div>
    <div class="card flush"><div class="card-head"><h2>Recent sign-ins</h2></div><table class="table"><tbody>${metrics.recentLogins.map((r) => h`<tr><td>${r.name}<div class="cell-sub">${r.email}</div></td><td>${r.role_name}</td><td>${fmtDateTime(r.last_login_at)}</td></tr>`)}</tbody></table></div>`);
  const roleOptions = assignable.map((r) => ({ value: r.id, label: `${r.name} – ${r.description}` }));
  const reload = () => { location.hash = '#/admin/users' + qs({ ...query, _: Date.now() }); };

  $('#filters', el).addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/admin/users' + qs(Object.fromEntries(new FormData(e.target))); });
  el.addEventListener('click', async (e) => {
    const pg = e.target.closest('[data-page]'); if (pg) { location.hash = '#/admin/users' + qs({ ...query, page: pg.dataset.page }); return; }
    if (e.target.closest('#newUser')) {
      const v = await formDialog({ title: 'Create user', submitLabel: 'Create user', intro: 'Leave the password blank to generate a temporary one. The user must choose their own password at first sign-in.',
        fields: [{ name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'roleId', label: 'Role', type: 'select', options: roleOptions, value: roleOptions.length ? roleOptions[roleOptions.length - 1].value : '' },
          { name: 'password', label: 'Temporary password (optional)', type: 'password', autocomplete: 'new-password' }] });
      if (!v) return;
      try {
        const r = await post('/users', { ...v, roleId: +v.roleId });
        if (r.temporaryPassword) await modal({ title: 'User created', body: h`<p>Give ${v.name} this temporary password through a secure channel. It is shown only once.</p><p class="mono" style="font-size:18px">${r.temporaryPassword}</p>` });
        else toast('User created.', 'ok');
        reload();
      } catch (err) { toastError(err); }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const u = list.users.find((x) => x.id === b.dataset.id);
    try {
      if (b.dataset.act === 'edit') {
        const v = await formDialog({ title: 'Edit ' + u.name, fields: [{ name: 'name', label: 'Full name', value: u.name, required: true }, { name: 'email', label: 'Email', type: 'email', value: u.email, required: true },
          { name: 'roleId', label: 'Role', type: 'select', options: roleOptions, value: u.role_id }] });
        if (!v) return;
        await patch('/users/' + u.id, { ...v, roleId: +v.roleId }); toast('User updated.', 'ok'); reload();
      } else if (b.dataset.act === 'reset') {
        if (!(await confirmDialog(`Issue a password reset link for ${u.name}? Any earlier links stop working.`, { confirmLabel: 'Issue link' }))) return;
        const r = await post(`/users/${u.id}/reset-password`);
        await modal({ title: 'Password reset link', body: h`<p>${r.emailed ? 'The link has been emailed to the user. ' : ''}Share this link with ${u.name} through a secure channel. It works once and expires in ${r.expiresHours} hours.</p><textarea class="input mono" rows="3" readonly>${r.link}</textarea>` });
      } else if (b.dataset.act === 'unlock') { await post(`/users/${u.id}/unlock`); toast('Account unlocked.', 'ok'); reload(); }
      else if (b.dataset.act === 'disable') { if (await confirmDialog(`Disable ${u.name}? They are signed out immediately.`, { danger: true, confirmLabel: 'Disable' })) { await post(`/users/${u.id}/disable`); toast('User disabled.', 'ok'); reload(); } }
      else if (b.dataset.act === 'enable') { await post(`/users/${u.id}/enable`); toast('User enabled.', 'ok'); reload(); }
      else if (b.dataset.act === 'delete') { if (await confirmDialog(`Delete ${u.name}? The account is removed; its audit history is kept.`, { danger: true, confirmLabel: 'Delete user' })) { await del('/users/' + u.id); toast('User deleted.', 'ok'); reload(); } }
      else if (b.dataset.act === 'activity') {
        const d = await get('/users/' + u.id);
        await modal({ title: 'Activity · ' + u.name, wide: true, body: d.activity.length ? h`<table class="table"><tbody>${d.activity.map((a) => h`<tr><td class="small nowrap">${fmtDateTime(a.created_at)}</td><td class="mono small">${a.action}</td><td class="small">${a.summary}</td><td class="small muted">${a.ip || ''}</td></tr>`)}</tbody></table>` : empty('No activity recorded') });
      }
    } catch (err) { toastError(err); }
  });
}

/* ---------------- audit ---------------- */
export async function auditLog({ el, query }) {
  const page = +query.page || 1;
  const d = await get('/audit' + qs({ ...query, page, pageSize: 50 }));
  el.innerHTML = String(h`
    <div class="page-head"><div><h1>Audit log</h1><p>Every sign-in, failed sign-in, register upload, publish and rollback, asset change, inspection upload, correction, report generation and export.</p></div>
      <button class="btn btn-secondary" id="exp">Export CSV</button></div>
    <div class="card flush">
      <form class="toolbar" id="filters"><input class="input" type="search" name="q" placeholder="Search user, action or details" value="${query.q || ''}">
        <select class="input" name="action"><option value="">All actions</option>${d.actionGroups.map((a) => h`<option value="${a}." ${query.action === a + '.' ? raw('selected') : ''}>${a}</option>`)}</select>
        <label class="small muted">From <input class="input" type="date" name="from" value="${query.from || ''}"></label><label class="small muted">To <input class="input" type="date" name="to" value="${query.to || ''}"></label>
        <button class="btn btn-secondary btn-sm">Filter</button></form>
      ${d.logs.length ? h`<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Time</th><th>User</th><th>Action</th><th>Details</th><th></th></tr></thead><tbody>
        ${d.logs.map((l) => h`<tr><td class="nowrap">${fmtDate(l.created_at)}</td><td class="nowrap small">${new Date(l.created_at).toLocaleTimeString('en-AU')}</td><td>${l.user_name || ''}<div class="cell-sub">${l.user_email}</div></td>
          <td><span class="tag ${/failed|locked|delete|reject|rollback/.test(l.action) ? 'warn' : ''} mono">${l.action}</span></td><td class="small">${l.summary}</td>
          <td>${Object.keys(l.details || {}).length ? h`<button class="btn btn-ghost btn-sm" data-log="${l.id}">Change record</button>` : ''}</td></tr>`)}
      </tbody></table></div>${pager(d.total, d.page, d.pageSize)}` : empty('No audit entries match')}
    </div>`);
  $('#filters', el).addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/admin/audit' + qs(Object.fromEntries(new FormData(e.target))); });
  $('#exp', el).addEventListener('click', () => download('/audit/export' + qs({ q: query.q, action: query.action, from: query.from, to: query.to })).catch(toastError));
  el.addEventListener('click', (e) => {
    const pg = e.target.closest('[data-page]'); if (pg) location.hash = '#/admin/audit' + qs({ ...query, page: pg.dataset.page });
    const b = e.target.closest('[data-log]');
    if (b) { const l = d.logs.find((x) => String(x.id) === b.dataset.log); modal({ title: l.action, wide: true, body: h`<p>${l.summary}</p><p class="small muted">${fmtDateTime(l.created_at)} · ${l.user_email} · ${l.ip || ''}</p><pre class="mono small" style="white-space:pre-wrap;background:var(--surface-2);padding:12px;border-radius:6px">${JSON.stringify(l.details, null, 2)}</pre>` }); }
  });
}

/* ---------------- settings ---------------- */
export async function settings({ el, session }) {
  const d = await get('/settings');
  const s = d.settings;
  const num = (group, path, label, attrs = '') => { const v = path.split('.').reduce((o, k) => o[k], s[group]); return h`<div class="field"><label>${label}</label><input class="input" type="number" data-g="${group}" data-p="${path}" value="${v}" ${raw(attrs)}></div>`; };
  const bool = (group, key, label, hint) => h`<label class="check mb16"><input type="checkbox" data-g="${group}" data-p="${key}" ${s[group][key] ? raw('checked') : ''}><span>${label}${hint ? h`<br><span class="small muted">${hint}</span>` : ''}</span></label>`;
  const txt = (group, key, label) => h`<div class="field"><label>${label}</label><input class="input" data-g="${group}" data-p="${key}" value="${s[group][key]}"></div>`;
  el.innerHTML = String(h`
    <div class="page-head"><div><h1>Settings</h1><p>Organisation-wide settings for matching, reports and approvals. Changes are audited.</p></div></div>
    <div class="grid-2">
      <div class="card"><h2 class="mb16">Matching weights</h2><p class="muted small">An exact Asset ID / Asset Number match scores its weight outright. Otherwise the score is the weighted sum of description, zone, location and keyword, scaled to 100.</p>
        <div class="form-grid">${num('matching', 'weights.assetNumber', 'Asset Number')}${num('matching', 'weights.assetId', 'Alternate ID / location code')}${num('matching', 'weights.description', 'Description')}${num('matching', 'weights.zone', 'Zone')}${num('matching', 'weights.location', 'Location')}${num('matching', 'weights.keyword', 'Keyword')}</div></div>
      <div class="card"><h2 class="mb16">Confidence bands</h2><p class="muted small">Match and Likely Match are accepted automatically; lower scores are flagged for review.</p>
        <div class="form-grid">${num('matching', 'thresholds.match', 'Match at or above (%)')}${num('matching', 'thresholds.likely', 'Likely Match at or above (%)')}${num('matching', 'thresholds.review', 'Review at or above (%)')}
        ${num('matching', 'conflictPenalty', 'Zone / direction conflict penalty')}${num('matching', 'ambiguityMargin', 'Ambiguity margin (points)', 'step="0.5"')}${num('matching', 'inactivePenalty', 'Decommissioned asset penalty')}</div></div>
    </div>
    <div class="card"><h2 class="mb8">Abbreviations &amp; synonyms</h2><p class="muted small">One rule per line: <code>CANONICAL = variant, variant</code>. Changes apply to new matches; publish a new register version or re-match a report to apply them to existing data.</p>
      <textarea class="input mono" rows="12" data-g="matching" data-p="synonyms">${s.matching.synonyms}</textarea>
      <div class="row mt16"><button class="btn btn-primary" data-save="matching">Save matching settings</button><span class="form-ok" id="ok-matching"></span></div></div>
    <div class="grid-2">
      <div class="card"><h2 class="mb16">Reports</h2>${txt('reports', 'defaultTitle', 'Default document title')}${txt('reports', 'defaultPreparedBy', 'Default "prepared by"')}${txt('reports', 'footerText', 'PDF footer text')}
        ${num('reports', 'minAcceptableCondition', 'Minimum acceptable condition (breach threshold)', 'min="1" max="4"')}
        ${bool('reports', 'requireApproval', 'Require approval before client delivery', 'Reports generated by Standard Users are drafts until an Administrator approves them.')}
        ${bool('reports', 'mergeDuplicates', 'Combine repeat entries of the same asset by default')}
        <button class="btn btn-primary" data-save="reports">Save report settings</button> <span class="form-ok" id="ok-reports"></span></div>
      <div class="card"><h2 class="mb16">Registers &amp; files</h2>
        ${bool('registers', 'requireSecondApprover', 'Require a second approver for register updates', 'The person who uploaded a register cannot approve it.')}
        ${bool('registers', 'storeOriginalFiles', 'Store original register files')}
        <button class="btn btn-primary" data-save="registers">Save register settings</button> <span class="form-ok" id="ok-registers"></span>
        <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
        ${bool('inspections', 'storeOriginalFiles', 'Store original inspection PDFs', 'Allows re-download of the source report from the inspection page.')}
        <button class="btn btn-primary" data-save="inspections">Save inspection settings</button> <span class="form-ok" id="ok-inspections"></span></div>
    </div>`);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-save]');
    if (!b) return;
    const g = b.dataset.save;
    const value = JSON.parse(JSON.stringify(s[g]));
    $$(`[data-g="${g}"]`, el).forEach((inp) => {
      const path = inp.dataset.p.split('.');
      const last = path.pop();
      const target = path.reduce((o, k) => o[k], value);
      target[last] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
    });
    try {
      const r = await put('/settings/' + g, value);
      s[g] = r.settings;
      if (session.settings) session.settings[g] = r.settings;
      $('#ok-' + g, el).textContent = 'Saved.';
      toast('Settings saved.', 'ok');
    } catch (err) { toastError(err); }
  });
}
