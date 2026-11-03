// Thin fetch wrapper: JSON in/out, CSRF header, consistent errors, downloads.
let csrfToken = null;
export const setCsrf = (t) => { csrfToken = t; };

export class ApiError extends Error {
  constructor(message, status, details) { super(message); this.status = status; this.details = details; }
}

export async function api(path, { method = 'GET', body, form, raw = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(data.error || `Request failed (${res.status}).`, res.status, data.details);
    if (res.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new CustomEvent('spg:signed-out'));
    if (data.details && data.details.code === 'password_change_required') window.dispatchEvent(new CustomEvent('spg:password-required'));
    throw err;
  }
  return data;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body || {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body: body || {} });
export const put = (p, body) => api(p, { method: 'PUT', body: body || {} });
export const del = (p) => api(p, { method: 'DELETE' });

export function qs(obj) {
  const p = new URLSearchParams();
  Object.entries(obj || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, v); });
  const s = p.toString();
  return s ? '?' + s : '';
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export async function download(path, fallbackName = 'download') {
  const res = await api(path, { raw: true });
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename="([^"]+)"/.exec(cd);
  saveBlob(await res.blob(), m ? m[1] : fallbackName);
}
