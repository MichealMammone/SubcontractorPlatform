// HTTP helpers: typed errors, async route wrapper, input readers and pagination.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg);
export const notFound = (what = 'Record') => new HttpError(404, what + ' not found.');
export const conflict = (msg) => new HttpError(409, msg);

// Express 4 does not catch rejected promises; this forwards them to the error handler.
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function str(v, { max = 500, required = false, name = 'value' } = {}) {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
  if (required && !s) throw badRequest(name + ' is required.');
  if (s.length > max) throw badRequest(name + ' must be ' + max + ' characters or fewer.');
  return s;
}

export function text(v, { max = 5000 } = {}) {
  const s = v == null ? '' : String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

export function intParam(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export function isoDate(v, name = 'date') {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) throw badRequest(name + ' must be a date (YYYY-MM-DD).');
  return s;
}

export const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
export function uuidParam(v, what = 'Record') { if (!isUuid(v)) throw notFound(what); return v; }
export function idParam(v, what = 'Record') { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw notFound(what); return n; }

export function paging(q, defSize = 50, maxSize = 200) {
  const page = intParam(q.page, 1, 1, 100000);
  const pageSize = intParam(q.pageSize, defSize, 1, maxSize);
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

// Escapes LIKE wildcards in user search text.
export const likeTerm = (q) => '%' + String(q || '').replace(/[\\%_]/g, (c) => '\\' + c) + '%';

export function clientIp(req) {
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export function safeFileName(s) {
  return String(s || 'file').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'file';
}

export function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
