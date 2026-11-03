// Boot, session, hash router and the branded application shell.
import { api, get, post, setCsrf } from './api.js';
import { h, raw, $, $$, toast, toastError, icon, initials, esc } from './ui.js';

export const session = { user: null, settings: null, mailEnabled: false };
export const can = (p) => !!(session.user && session.user.permissions.includes(p));

const ROUTES = [
  { path: '/dashboard', perm: 'dashboard.view', mod: 'dashboard', fn: 'dashboard', title: 'Dashboard' },
  { path: '/analytics', perm: 'analytics.view', mod: 'dashboard', fn: 'analytics', title: 'Analytics' },
  { path: '/inspections', perm: 'inspections.view', mod: 'inspections', fn: 'list', title: 'Inspections' },
  { path: '/inspections/new', perm: 'inspections.upload', mod: 'inspections', fn: 'upload', title: 'Upload inspection report' },
  { path: '/inspections/:id', perm: 'inspections.view', mod: 'inspections', fn: 'detail', title: 'Inspection' },
  { path: '/reports', perm: 'reports.view', mod: 'reports', fn: 'list', title: 'Report history' },
  { path: '/reports/:id', perm: 'reports.view', mod: 'reports', fn: 'detail', title: 'Report' },
  { path: '/registers', perm: 'registers.view', mod: 'registers', fn: 'hub', title: 'Asset Register Hub' },
  { path: '/registers/upload', perm: 'registers.upload', mod: 'registers', fn: 'upload', title: 'Register upload centre' },
  { path: '/registers/versions', perm: 'registers.view', mod: 'registers', fn: 'versions', title: 'Register versions' },
  { path: '/registers/versions/:id', perm: 'registers.view', mod: 'registers', fn: 'version', title: 'Register version' },
  { path: '/registers/compare', perm: 'registers.view', mod: 'registers', fn: 'compare', title: 'Compare versions' },
  { path: '/assets', perm: 'assets.view', mod: 'assets', fn: 'list', title: 'Assets' },
  { path: '/assets/:id', perm: 'assets.view', mod: 'assets', fn: 'detail', title: 'Asset' },
  { path: '/admin/users', perm: 'users.view', mod: 'admin', fn: 'users', title: 'User management' },
  { path: '/admin/audit', perm: 'audit.view', mod: 'admin', fn: 'auditLog', title: 'Audit log' },
  { path: '/admin/settings', perm: 'settings.manage', mod: 'admin', fn: 'settings', title: 'Settings' },
  { path: '/search', mod: 'search', fn: 'search', title: 'Search' },
  { path: '/help', mod: 'help', fn: 'help', title: 'Help centre' },
  { path: '/help/:topic', mod: 'help', fn: 'help', title: 'Help centre' },
  { path: '/profile', mod: 'profile', fn: 'profile', title: 'My profile' }
];
const PUBLIC = { '/login': 'login', '/forgot-password': 'forgot', '/reset-password': 'reset' };

const NAV = [
  { group: 'Workspace' },
  { href: '#/dashboard', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view' },
  { href: '#/inspections/new', label: 'Upload inspection', icon: 'upload', perm: 'inspections.upload' },
  { href: '#/inspections', label: 'Inspections', icon: 'inspect', perm: 'inspections.view' },
  { href: '#/reports', label: 'Report history', icon: 'report', perm: 'reports.view' },
  { group: 'Asset Register Hub' },
  { href: '#/registers', label: 'Register Hub', icon: 'hub', perm: 'registers.view' },
  { href: '#/assets', label: 'Assets', icon: 'assets', perm: 'assets.view' },
  { group: 'Insights' },
  { href: '#/analytics', label: 'Analytics', icon: 'analytics', perm: 'analytics.view' },
  { group: 'Administration' },
  { href: '#/admin/users', label: 'Users', icon: 'users', perm: 'users.view' },
  { href: '#/admin/audit', label: 'Audit log', icon: 'audit', perm: 'audit.view' },
  { href: '#/admin/settings', label: 'Settings', icon: 'settings', perm: 'settings.manage' },
  { group: 'Support' },
  { href: '#/help', label: 'Help centre', icon: 'help' }
];

export function navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/dashboard';
  const [path, qs] = raw.split('?');
  return { path: path.replace(/\/+$/, '') || '/dashboard', query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
function matchRoute(path) {
  for (const r of ROUTES) {
    const a = r.path.split('/'); const b = path.split('/');
    if (a.length !== b.length) continue;
    const params = {};
    if (a.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(b[i])), true) : seg === b[i]))) return { route: r, params };
  }
  return null;
}

async function loadSession() {
  try {
    const me = await get('/auth/me');
    session.user = me.user; session.mailEnabled = me.mailEnabled; setCsrf(me.csrfToken);
    try { session.settings = (await get('/settings')).settings; } catch { session.settings = null; }
    return true;
  } catch { session.user = null; return false; }
}

function shell() {
  const u = session.user;
  const items = [];
  NAV.forEach((n, i) => {
    if (n.group) {
      // Only show a group heading when at least one following item (until the next group) is visible.
      const next = NAV.slice(i + 1); const end = next.findIndex((x) => x.group);
      if ((end < 0 ? next : next.slice(0, end)).some((x) => !x.perm || can(x.perm))) items.push(h`<div class="nav-group">${n.group}</div>`);
    } else if (!n.perm || can(n.perm)) items.push(h`<a href="${n.href}" data-nav="${n.href}">${icon(n.icon)}<span>${n.label}</span></a>`);
  });
  $('#root').innerHTML = String(h`<div class="app" id="app">
    <aside class="side">
      <div class="brand"><img src="/img/logo.svg" alt=""><div><div class="brand-name">SCALE POINT GROUP</div><div class="brand-sub">Asset Inspection &amp; Register</div></div></div>
      <nav class="nav" aria-label="Main">${items}</nav>
      <div class="side-foot">${u.organisation.name}<br>v1.0</div>
    </aside>
    <div class="main">
      <header class="top">
        <button class="icon-btn hamburger" id="navToggle" aria-label="Menu">${icon('menu')}</button>
        <form class="top-search" id="globalSearch" role="search">${icon('search')}<input type="search" name="q" placeholder="Search assets, reports, inspections${can('users.view') ? ', users' : ''}…" aria-label="Global search"></form>
        <div class="user-chip">
          <div class="user-meta"><b>${u.name}</b><span>${u.roleName}</span></div>
          <button class="icon-btn" id="userBtn" aria-label="Account menu"><span class="avatar">${initials(u.name)}</span></button>
          <div class="menu" id="userMenu" hidden>
            <a href="#/profile">My profile &amp; password</a>
            <a href="#/help">Help centre</a>
            <button id="signOut">Sign out</button>
          </div>
        </div>
      </header>
      <main class="content" id="view"></main>
    </div></div>`);
  $('#navToggle').addEventListener('click', () => $('#app').classList.toggle('nav-open'));
  $('#userBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#userMenu').hidden = !$('#userMenu').hidden; });
  document.addEventListener('click', () => { const m = $('#userMenu'); if (m) m.hidden = true; });
  $('#signOut').addEventListener('click', signOut);
  $('#globalSearch').addEventListener('submit', (e) => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) navigate('#/search?q=' + encodeURIComponent(q)); });
}

async function signOut() {
  try { await post('/auth/logout'); } catch { /* already signed out */ }
  session.user = null;
  location.hash = '#/login';
  location.reload();
}

let renderSeq = 0;
async function route() {
  const { path, query } = parseHash();
  const seq = ++renderSeq;
  if (PUBLIC[path]) {
    if (session.user && path === '/login') return navigate('#/dashboard');
    const m = await import('./views/auth.js');
    return m[PUBLIC[path]]({ query, onSignedIn: start });
  }
  if (!session.user) return navigate('#/login');
  if (session.user.mustChangePassword && path !== '/profile') return navigate('#/profile?force=1');
  if (!$('#app')) shell();
  $('#app').classList.remove('nav-open');
  const hit = matchRoute(path);
  // A fresh container per page, so event listeners from the previous page never accumulate.
  const old = $('#view');
  const el = old.cloneNode(false);
  old.replaceWith(el);
  $$('.nav a').forEach((a) => a.classList.toggle('active', path === a.dataset.nav.slice(1) || (a.dataset.nav !== '#/inspections/new' && path.startsWith(a.dataset.nav.slice(1) + '/') && !(path === '/inspections/new'))));
  if (!hit) { el.innerHTML = String(h`<div class="empty"><h3>Page not found</h3><p><a href="#/dashboard">Back to the dashboard</a></p></div>`); return; }
  if (hit.route.perm && !can(hit.route.perm)) { el.innerHTML = String(h`<div class="empty"><h3>No access</h3><p>Your role (${session.user.roleName}) does not include this area. Ask an administrator if you need access.</p></div>`); return; }
  document.title = hit.route.title + ' | Scale Point Group';
  el.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
  try {
    const mod = await import(`./views/${hit.route.mod}.js`);
    if (seq !== renderSeq) return; // user navigated away while loading
    await mod[hit.route.fn]({ el, params: hit.params, query, user: session.user, can, navigate, session, isCurrent: () => seq === renderSeq });
  } catch (err) {
    console.error(err);
    if (seq === renderSeq) el.innerHTML = String(h`<div class="banner bad">${err.message || 'This page could not be loaded.'}</div>`);
  }
  window.scrollTo(0, 0);
}

// target: where to go once signed in (used straight after login).
async function start(target) {
  await loadSession();
  if (session.user) shell();
  let want = location.hash;
  if (target && session.user) want = target;
  else if (!want || want === '#/' || (session.user && want.startsWith('#/login'))) want = session.user ? '#/dashboard' : '#/login';
  if (want !== location.hash) location.hash = want; // the hashchange event renders the page
  else route();
}

window.addEventListener('hashchange', route);
window.addEventListener('spg:signed-out', () => { if (session.user) { session.user = null; toast('Your session has ended. Please sign in again.', 'warn'); location.hash = '#/login'; location.reload(); } });
window.addEventListener('spg:password-required', () => { if (session.user) { session.user.mustChangePassword = true; navigate('#/profile?force=1'); } });
window.addEventListener('unhandledrejection', (e) => { if (e.reason && e.reason.status !== 401) toastError(e.reason); });

export { esc, raw };
start();
