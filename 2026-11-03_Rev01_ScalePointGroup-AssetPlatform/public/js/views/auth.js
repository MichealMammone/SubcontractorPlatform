// Sign-in, forgotten password and reset-password pages.
import { post, setCsrf } from '../api.js';
import { h, $, toast } from '../ui.js';

function frame(inner) {
  document.title = 'Sign in | Scale Point Group';
  $('#root').innerHTML = String(h`<div class="auth">
    <section class="auth-art">
      <div class="row"><img src="/img/logo.svg" alt="" width="44" height="44"><div><div class="brand-name">SCALE POINT GROUP</div><div class="brand-sub">Asset Inspection &amp; Register Management</div></div></div>
      <div>
        <h1>One master asset register. Every inspection matched automatically.</h1>
        <p>Upload a subcontractor inspection report and receive a client-ready condition register in minutes.</p>
        <ul><li>Asset Register Hub with version control and approvals</li><li>Automatic asset matching with confidence scoring</li><li>Branded Excel, CSV and PDF outputs</li><li>Full audit trail and role-based access</li></ul>
      </div>
      <div class="small" style="color:#9aa4b1">© ${new Date().getFullYear()} Scale Point Group</div>
    </section>
    <section class="auth-form"><div class="auth-box">${inner}</div></section></div>`);
}

export function login({ onSignedIn }) {
  frame(h`<h2>Sign in</h2><p class="muted">Use your Scale Point Group account.</p>
    <form id="loginForm" novalidate>
      <div class="field"><label for="email">Email</label><input class="input" id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input class="input" id="password" name="password" type="password" autocomplete="current-password" required></div>
      <div class="form-error" id="err" hidden></div>
      <button class="btn btn-primary" style="width:100%" type="submit">Sign in</button>
      <p class="mt16 small"><a href="#/forgot-password">Forgotten your password?</a></p>
    </form>`);
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const btn = f.querySelector('button'); btn.disabled = true;
    try {
      const r = await post('/auth/login', { email: f.email.value, password: f.password.value });
      setCsrf(r.csrfToken);
      await onSignedIn(r.mustChangePassword ? '#/profile?force=1' : '#/dashboard');
    } catch (err) {
      $('#err').textContent = err.message; $('#err').hidden = false; btn.disabled = false;
    }
  });
}

export function forgot() {
  frame(h`<h2>Reset your password</h2><p class="muted">Enter your email address. If password-reset email is enabled, a link is sent; otherwise ask your administrator to issue a reset link.</p>
    <form id="fForm"><div class="field"><label for="email">Email</label><input class="input" id="email" name="email" type="email" required></div>
    <div class="form-ok" id="ok" hidden></div><div class="form-error" id="err" hidden></div>
    <button class="btn btn-primary" style="width:100%">Send reset link</button><p class="mt16 small"><a href="#/login">Back to sign in</a></p></form>`);
  $('#fForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await post('/auth/password/forgot', { email: e.target.email.value }); $('#ok').textContent = r.message; $('#ok').hidden = false; $('#err').hidden = true; }
    catch (err) { $('#err').textContent = err.message; $('#err').hidden = false; }
  });
}

export function reset({ query }) {
  frame(h`<h2>Choose a new password</h2><p class="muted">At least 12 characters, using three of: lower-case, upper-case, numbers and symbols.</p>
    <form id="rForm"><div class="field"><label for="pw">New password</label><input class="input" id="pw" name="pw" type="password" autocomplete="new-password" required></div>
    <div class="field"><label for="pw2">Confirm new password</label><input class="input" id="pw2" name="pw2" type="password" autocomplete="new-password" required></div>
    <div class="form-error" id="err" hidden></div><button class="btn btn-primary" style="width:100%">Set password</button></form>`);
  $('#rForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.pw.value !== f.pw2.value) { $('#err').textContent = 'The passwords do not match.'; $('#err').hidden = false; return; }
    try {
      await post('/auth/password/reset', { token: query.token || '', newPassword: f.pw.value });
      toast('Password updated. Please sign in.', 'ok');
      location.hash = '#/login';
    } catch (err) { $('#err').textContent = err.message; $('#err').hidden = false; }
  });
}
