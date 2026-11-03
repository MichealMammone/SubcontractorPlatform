// UI toolkit: safe HTML templating, toasts, modals, drawers, busy overlay, formatters and small components.
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s == null ? '' : s));
export const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Tagged template: interpolated values are escaped unless wrapped in raw(); arrays are joined.
export function h(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += render(vals[i]);
  });
  return raw(out);
}
function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
export function setHtml(el, html) { el.innerHTML = String(html); return el; }
export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

export function toast(msg, kind = '', ms = 4500) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
export function toastError(err) { toast(err && err.message ? err.message : String(err), 'bad', 7000); }

/* ---------- busy overlay ---------- */
let busyEl = null;
export const busy = {
  show(text) {
    if (!busyEl) { busyEl = document.createElement('div'); busyEl.className = 'busy'; document.body.appendChild(busyEl); }
    busyEl.innerHTML = `<div class="busy-card"><div class="spinner"></div><div id="busyText">${esc(text || 'Working…')}</div><div class="progress mt8"><span id="busyBar" style="width:0%"></span></div></div>`;
  },
  progress(frac, text) {
    if (!busyEl) return;
    if (text != null) $('#busyText', busyEl).textContent = text;
    $('#busyBar', busyEl).style.width = Math.max(0, Math.min(100, frac * 100)).toFixed(1) + '%';
  },
  hide() { if (busyEl) { busyEl.remove(); busyEl = null; } }
};

/* ---------- modal ---------- */
// Resolves with the clicked action's value (or null when closed). onOpen(root) can wire inputs; validate(value, root) may return an error string.
export function modal({ title, body, actions = [{ label: 'Close', value: null, kind: 'ghost' }], wide = false, onOpen, validate }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'backdrop';
    bg.innerHTML = String(h`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-x aria-label="Close">✕</button></div>
      <div class="modal-body">${raw(String(body || ''))}<div class="form-error" data-err hidden></div></div>
      <div class="modal-foot">${actions.map((a, i) => h`<button class="btn btn-${a.kind || 'primary'}" data-i="${i}">${a.label}</button>`)}</div></div>`);
    document.body.appendChild(bg);
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    bg.addEventListener('click', async (e) => {
      if (e.target === bg || e.target.closest('[data-x]')) return close(null);
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const a = actions[+b.dataset.i];
      if (a.value != null && validate) {
        const err = await validate(a.value, bg);
        if (err) { const el = $('[data-err]', bg); el.textContent = err; el.hidden = false; return; }
      }
      close(a.value);
    });
    if (onOpen) onOpen(bg);
    const first = $('input, select, textarea', bg);
    if (first) setTimeout(() => first.focus(), 30);
  });
}

export function confirmDialog(message, { title = 'Please confirm', confirmLabel = 'Confirm', danger = false } = {}) {
  return modal({ title, body: h`<p>${message}</p>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true }] }).then((v) => v === true);
}

// Form modal: returns an object of named field values, or null when cancelled.
export async function formDialog({ title, fields, submitLabel = 'Save', wide = false, intro = '' }) {
  let values = null;
  const body = h`${intro ? h`<p class="muted">${intro}</p>` : ''}${fields.map((f) => fieldHtml(f))}`;
  const v = await modal({
    title, wide, body,
    actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: submitLabel, value: 'ok' }],
    validate: async (val, root) => {
      values = {};
      for (const f of fields) {
        const el = root.querySelector(`[name="${f.name}"]`);
        values[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim();
        if (f.required && !values[f.name]) return `${f.label} is required.`;
      }
      return f_validate(fields, values);
    }
  });
  return v === 'ok' ? values : null;
}
function f_validate(fields, values) { for (const f of fields) if (f.check) { const e = f.check(values[f.name], values); if (e) return e; } return null; }
export function fieldHtml(f) {
  const id = 'f_' + f.name;
  if (f.type === 'checkbox') return h`<label class="check mb16"><input type="checkbox" name="${f.name}" ${f.value ? raw('checked') : ''}> <span>${f.label}</span></label>`;
  let control;
  if (f.type === 'select') control = h`<select class="input" id="${id}" name="${f.name}">${(f.options || []).map((o) => h`<option value="${o.value}" ${String(o.value) === String(f.value) ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
  else if (f.type === 'textarea') control = h`<textarea class="input" id="${id}" name="${f.name}" rows="${f.rows || 4}">${f.value || ''}</textarea>`;
  else control = h`<input class="input" id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${f.value == null ? '' : f.value}" ${f.placeholder ? raw(`placeholder="${esc(f.placeholder)}"`) : ''} autocomplete="${f.autocomplete || 'off'}">`;
  return h`<div class="field"><label for="${id}">${f.label}${f.required ? h` <span class="req">*</span>` : ''}</label>${control}${f.hint ? h`<div class="hint">${f.hint}</div>` : ''}</div>`;
}

/* ---------- drawer ---------- */
export function drawer({ title, kicker = '' }) {
  const bg = document.createElement('div'); bg.className = 'drawer-bg';
  const el = document.createElement('aside'); el.className = 'drawer'; el.setAttribute('role', 'dialog');
  el.innerHTML = String(h`<div class="drawer-head"><div><div class="muted small">${kicker}</div><h2>${title}</h2></div><button class="icon-btn" data-x aria-label="Close">✕</button></div><div class="drawer-body"></div><div class="drawer-foot" hidden></div>`);
  document.body.append(bg, el);
  const close = () => { bg.remove(); el.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('click', close);
  el.querySelector('[data-x]').addEventListener('click', close);
  return { el, body: el.querySelector('.drawer-body'), foot: el.querySelector('.drawer-foot'), close };
}

/* ---------- formatters ---------- */
export const fmtInt = (n) => Number(n || 0).toLocaleString('en-AU');
export function fmtDate(v) {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('en-AU');
}
export function fmtDateTime(v) { if (!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('en-AU') + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }); }
export function ago(v) {
  if (!v) return 'never';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.round(s / 86400) + ' days ago'; return fmtDate(v);
}
export const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

/* ---------- components ---------- */
export const COND_LABELS = { 1: 'Very Good', 2: 'Good', 3: 'Fair', 4: 'Poor', 5: 'Very Poor' };
export function condBadge(n) { return n == null ? h`<span class="muted small">Not rated</span>` : h`<span class="cond cond-${Math.max(1, Math.min(5, n))}" title="${COND_LABELS[n] || ''}">${n}</span> <span class="small muted">${COND_LABELS[n] || ''}</span>`; }
const MATCH = {
  match: ['Match', 'ok'], likely: ['Likely match', 'teal'], confirmed: ['Confirmed', 'blue'], manual: ['Manual match', 'violet'],
  review: ['Review', 'warn'], nomatch: ['Not in register', 'bad'], rejected: ['Not in register (confirmed)', '']
};
export function matchTag(st) { const m = MATCH[st] || [st, '']; return h`<span class="tag ${m[1]}">${m[0]}</span>`; }
export function statusTag(text, tone = '') { return h`<span class="tag ${tone}">${text}</span>`; }
export function confBar(score, thresholds = { match: 95, likely: 80, review: 60 }) {
  if (score == null) return h`<span class="muted">—</span>`;
  const tone = score >= thresholds.match ? 'ok' : score >= thresholds.likely ? 'teal' : score >= thresholds.review ? 'warn' : 'bad';
  return h`<div class="conf"><div class="conf-bar ${tone}"><span style="width:${Math.max(0, Math.min(100, score))}%"></span></div><b class="small">${Math.round(score)}%</b></div>`;
}
export function kpi(label, value, sub = '', tone = '') { return h`<div class="kpi ${tone}"><div class="kpi-label">${label}</div><div class="kpi-value">${typeof value === 'number' ? fmtInt(value) : value}</div><div class="kpi-sub">${sub}</div></div>`; }
export function empty(title, text = '', action = '') { return h`<div class="empty"><h3>${title}</h3><p>${text}</p>${action}</div>`; }
export function pager(total, page, pageSize) {
  if (total <= pageSize) return h`<div class="pager"><span>${fmtInt(total)} record${total === 1 ? '' : 's'}</span></div>`;
  const pages = Math.ceil(total / pageSize);
  return h`<div class="pager"><span>${fmtInt((page - 1) * pageSize + 1)}–${fmtInt(Math.min(total, page * pageSize))} of ${fmtInt(total)}</span>
    <span class="row"><button class="btn btn-ghost btn-sm" data-page="${page - 1}" ${page <= 1 ? raw('disabled') : ''}>Previous</button>
    <span class="small">Page ${page} of ${pages}</span>
    <button class="btn btn-ghost btn-sm" data-page="${page + 1}" ${page >= pages ? raw('disabled') : ''}>Next</button></span></div>`;
}
export function chips(arr, cls = '') { return arr && arr.length ? arr.map((x) => h`<span class="chip ${cls}">${x}</span>`) : h`<span class="muted small">none</span>`; }

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { const s = document.querySelector(`script[src="${src}"]`); if (s.dataset.loaded) return resolve(); s.addEventListener('load', () => resolve()); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = () => { s.dataset.loaded = '1'; resolve(); }; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

// Chart.js helper (destroys any previous chart on the canvas).
export function chart(canvas, config) {
  if (!canvas || typeof window.Chart === 'undefined') return null;
  const prev = window.Chart.getChart(canvas);
  if (prev) prev.destroy();
  window.Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  window.Chart.defaults.color = '#4a5360';
  return new window.Chart(canvas, config);
}

export function wireDropzone(zone, onFiles) {
  const input = zone.querySelector('input[type=file]');
  input.addEventListener('change', () => { if (input.files.length) onFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) onFiles(e.dataTransfer.files); });
}

export const ICONS = {
  dashboard: '<path d="M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z"/>',
  inspect: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9zM8 13h8v2H8zm0 4h5v2H8z"/>',
  upload: '<path d="M5 20h14v-2H5zm7-16-5.5 5.5 1.4 1.4L11 7.8V16h2V7.8l3.1 3.1 1.4-1.4z"/>',
  report: '<path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM9 17H7v-7h2zm4 0h-2V7h2zm4 0h-2v-4h2z"/>',
  hub: '<path d="M12 2 2 7l10 5 10-5zm-8.6 9.3L12 15.6l8.6-4.3L22 12l-10 5-10-5zm0 5L12 20.6l8.6-4.3L22 17l-10 5-10-5z"/>',
  assets: '<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>',
  analytics: '<path d="M3 3v18h18v-2H5V3zm4 12 4-5 3 3 5-6 1.5 1.3L14 16l-3-3-2.5 3.2z"/>',
  users: '<path d="M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1a4.2 4.2 0 0 1 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z"/>',
  audit: '<path d="M12 1 3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5zm-1 16-4-4 1.4-1.4L11 14.2l5.6-5.6L18 10z"/>',
  settings: '<path d="M19.4 13a7.7 7.7 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.3 7.3 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.3 7.3 0 0 0-1.7 1l-2.5-1-2 3.5L4.6 11a7.7 7.7 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.3 7.3 0 0 0 1.7 1L11 21h4l.4-2.9a7.3 7.3 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 3.5-3.5 3.5 3.5 0 0 1-3.5 3.5z"/>',
  help: '<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 17h-2v-2h2zm2.1-7.7-.9.9A3.3 3.3 0 0 0 13 15h-2v-.5a4.4 4.4 0 0 1 1.3-3.1l1.2-1.3a1.9 1.9 0 0 0 .5-1.4 2 2 0 0 0-4 0H8a4 4 0 0 1 8 0 3.2 3.2 0 0 1-.9 2.6z"/>',
  search: '<path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/>',
  menu: '<path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/>',
  file: '<path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5z"/>'
};
export const icon = (name) => raw(`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`);
