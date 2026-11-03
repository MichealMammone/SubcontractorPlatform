// My profile: account details, change password (forced on first sign-in), signed-in devices.
import { get, post, del } from '../api.js';
import { h, $, toast, toastError, fmtDateTime, ago } from '../ui.js';

export async function profile({ el, user, query, session, navigate }) {
  const force = query.force === '1' || user.mustChangePassword;
  const sessions = force ? { sessions: [] } : await get('/auth/sessions');
  el.innerHTML = String(h`
    <div class="page-head"><div><h1>My profile</h1><p>${user.name} · ${user.email} · ${user.roleName}</p></div></div>
    ${force ? h`<div class="banner warn"><span><b>Choose a new password to continue.</b> Your account was created or reset with a temporary password.</span></div>` : ''}
    <div class="grid-2">
      <div class="card"><h2 class="mb16">Change password</h2>
        <form id="pwForm">
          <div class="field"><label for="cur">Current password</label><input class="input" id="cur" name="cur" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="pw">New password</label><input class="input" id="pw" name="pw" type="password" autocomplete="new-password" required>
            <div class="hint">At least 12 characters, using three of: lower-case, upper-case, numbers and symbols.</div></div>
          <div class="field"><label for="pw2">Confirm new password</label><input class="input" id="pw2" name="pw2" type="password" autocomplete="new-password" required></div>
          <div class="form-error" id="err" hidden></div>
          <button class="btn btn-primary">Update password</button>
        </form></div>
      <div class="card"><h2 class="mb16">Account</h2>
        <dl class="kv"><dt>Name</dt><dd>${user.name}</dd><dt>Email</dt><dd>${user.email}</dd><dt>Role</dt><dd>${user.roleName}</dd><dt>Organisation</dt><dd>${user.organisation.name}</dd>
        <dt>Permissions</dt><dd class="small">${user.permissions.join(', ')}</dd></dl></div>
    </div>
    ${force ? '' : h`<div class="card flush"><div class="card-head"><h2>Signed-in devices</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Last active</th><th></th></tr></thead><tbody>
      ${sessions.sessions.map((s) => h`<tr><td class="small">${s.userAgent || 'Unknown'}</td><td>${s.ip || ''}</td><td>${fmtDateTime(s.createdAt)}</td><td>${ago(s.lastSeenAt)}</td>
        <td class="num">${s.current ? h`<span class="tag blue">This device</span>` : h`<button class="btn btn-ghost btn-sm" data-revoke="${s.id}">Sign out</button>`}</td></tr>`)}
    </tbody></table></div></div>`}`);
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.pw.value !== f.pw2.value) { $('#err').textContent = 'The new passwords do not match.'; $('#err').hidden = false; return; }
    try {
      await post('/auth/password/change', { currentPassword: f.cur.value, newPassword: f.pw.value });
      toast('Password updated.', 'ok');
      if (force) { session.user.mustChangePassword = false; user.mustChangePassword = false; navigate('#/dashboard'); }
      else f.reset();
    } catch (err) { $('#err').textContent = err.message; $('#err').hidden = false; }
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    try { await del('/auth/sessions/' + b.dataset.revoke); toast('Device signed out.', 'ok'); b.closest('tr').remove(); } catch (err) { toastError(err); }
  });
}
