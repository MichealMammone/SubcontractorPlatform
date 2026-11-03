/* ==========================================================================
   Scale Point Group - inspection report interpreter
   Turns positioned PDF text (from PDF.js) into asset records: asset header,
   sub-location, check results, condition ratings (with the page they were on),
   defects and report metadata (reference, assessment date, site).
   Pure functions; runs in the browser so large PDFs never load the server.
   ========================================================================== */
import { extractZones, isCodeLike, COND_LABELS } from './engine.js';

const RESULT_RE = /^(PASS(?:ED)?|FAIL(?:ED)?|NO\s*TEST|NOT\s*TESTED|N\/T|DEFECTIVE)$/i;
const VALUE_RE = /^(P|F|N|NA|N\/A|Y|X|\d{1,3}(?:\.\d+)?)$/i;
const CHECK_RE = /^(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)\.?\s+(.*)$/;
const COND_LABEL_RE = /^(?:a\s?sset\s+)?condition(?:\s+(?:rating|score|grade|index))?\s*:?$/i;
const COND_SUBLABEL_RE = /condition\s+rating\s+(?:from\s+)?\d\s*(?:to|-)\s*\d/i;
const COND_INLINE_RE = /condition(?:\s+(?:rating|score|grade))?\s*[:=-]\s*([1-5])\b/i;
const HEADER_ROW_RE = /^asset\s*\/\s*location\b/i;
const SECTION_RE = /^\d{1,3}\s*[-–]\s*\S/;
const BAND_NOISE_RES = [/\S+@\S+\.\w{2,}/, /\bwww\.[\w-]+\.\w{2,}/i, /^\W{0,3}P\.?\s?O\.?\s*Box\b/i, /^\W{0,3}(?:ph|tel|phone)?\s*\d{2,4}[\s-]?\d{3}[\s-]?\d{3,4}\s*$/i];
const PAGE_NO_RE = /^page\s+\d+\s*(?:of|\/)\s*\d+$/i;
const DATE_LABEL_RE = /(?:performed\s+on|inspection\s+date|date\s+of\s+(?:inspection|service|report|visit|assessment)|service\s+date|inspected\s+on|report\s+date|assessment\s+date|completed\s+on|completion\s+date|date\s+completed|visit\s+date|attended\s+on)\s*:?\s*(.+)$/i;

const normSpace = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const uniq = (arr) => Array.from(new Set(arr.filter((x) => x != null && x !== '')));
const pad2 = (n) => String(n).padStart(2, '0');

/* ---------- dates ---------- */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function monthOf(name) { const n = name.toLowerCase(); return MONTHS[n.slice(0, 4)] || MONTHS[n.slice(0, 3)] || 0; }
function validISO(y, mo, d) {
  y = parseInt(y, 10); mo = parseInt(mo, 10); d = parseInt(d, 10);
  if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return ''; // 31 February etc.
  return y + '-' + pad2(mo) + '-' + pad2(d);
}
export function parseDateISO(str) {
  const s = String(str || '');
  let m;
  const dmy = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/g;   // 2nd October 2025
  while ((m = dmy.exec(s))) { const v = validISO(m[3], monthOf(m[2]), m[1]); if (v) return v; }
  const mdy = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/g;   // October 2, 2025
  while ((m = mdy.exec(s))) { const v = validISO(m[3], monthOf(m[1]), m[2]); if (v) return v; }
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
  while ((m = iso.exec(s))) { const v = validISO(m[1], m[2], m[3]); if (v) return v; }
  const num = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?!\d)/g;                    // Australian day/month/year
  while ((m = num.exec(s))) { const v = validISO(m[3].length === 2 ? '20' + m[3] : m[3], m[2], m[1]); if (v) return v; }
  return '';
}
export function fmtDate(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }

/* ---------- page text -> lines ---------- */
function detectColumns(pg, prev) {
  let res = null; let com = null;
  for (const it of pg.items) {
    const s = it.str.trim();
    if (res == null && /^Result$/i.test(s)) res = it.x;
    else if (com == null && /^Comments?$/i.test(s)) com = it.x;
  }
  if (res != null && com != null && com > res) return { result: res - 3, comment: com - 3 };
  return prev || { result: pg.width * 0.375, comment: pg.width * 0.455 };
}

const RANK = { left: 0, result: 1, comment: 2 };
function buildLines(pg, cols) {
  const items = pg.items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - it.y) <= Math.max(1.5, Math.min(row.minSize, it.size) * 0.3)) { row.items.push(it); row.minSize = Math.min(row.minSize, it.size); }
    else rows.push({ y: it.y, minSize: it.size, items: [it] });
  }
  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);
    const parts = { left: '', result: '', comment: '' };
    const sizes = { left: 0, result: 0, comment: 0 };
    let cur = null; let lastEnd = -1e9;
    for (const it of row.items) {
      let col = it.x < cols.result ? 'left' : it.x < cols.comment ? 'result' : 'comment';
      if (cur && RANK[col] > RANK[cur] && it.x - lastEnd < it.size * 0.5) col = cur; // text running past a boundary stays put
      if (parts[col] && !/\s$/.test(parts[col]) && (col !== cur || it.x - lastEnd > it.size * 0.12)) parts[col] += ' ';
      parts[col] += it.str;
      sizes[col] = Math.max(sizes[col], it.size);
      cur = col; lastEnd = it.x + it.w;
    }
    const l = { page: pg.num, y: row.y, yRel: pg.height ? row.y / pg.height : 0.5, left: normSpace(parts.left), result: normSpace(parts.result), comment: normSpace(parts.comment), leftSize: sizes.left, value: null, assetResult: '', noise: false };
    l.full = [l.left, l.result, l.comment].filter(Boolean).join(' ');
    return l;
  });
}

function isLabelLine(l) { return !!l.left && (CHECK_RE.test(l.left) || COND_LABEL_RE.test(l.left)); }
function nearestLine(cands, y, lo, hi, ok) {
  let best = null; let bd = Infinity;
  for (const c of cands) {
    const dy = y - c.y;
    if (dy < lo || dy > hi || !ok(c)) continue;
    if (Math.abs(dy) < bd) { bd = Math.abs(dy); best = c; }
  }
  return best;
}
// Attach lone check results ("P", "F", "3") and lone PASS/FAIL tokens to the row they belong to.
function attachValues(lines) {
  const labels = lines.filter(isLabelLine);
  const headers = lines.filter((l) => l.left && /\s[-–]\s/.test(l.left));
  const out = [];
  for (const l of lines) {
    if (!l.left && !l.result && l.comment && VALUE_RE.test(l.comment)) {
      const t = nearestLine(labels, l.y, -4, 12, (x) => x.value == null && !(x.comment && VALUE_RE.test(x.comment)));
      if (t) { t.value = l.comment; continue; }
    }
    if (!l.left && !l.comment && l.result && RESULT_RE.test(l.result)) {
      const t = nearestLine(headers, l.y, -8, 8, (x) => !x.result && !x.assetResult);
      if (t) { t.assetResult = l.result; continue; }
    }
    out.push(l);
  }
  out.forEach((l) => { if (l.value == null && isLabelLine(l) && l.comment && VALUE_RE.test(l.comment)) { l.value = l.comment; l.comment = ''; } });
  return out;
}

function median(arr) { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function normResult(t) {
  const u = String(t || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (/^PASS/.test(u)) return 'PASS';
  if (/^FAIL|^DEFECTIVE/.test(u)) return 'FAIL';
  if (/NO ?TEST|NOT ?TESTED|^N\/T$/.test(u)) return 'NO TEST';
  return u;
}
function normValue(v) {
  const u = String(v == null ? '' : v).toUpperCase().trim();
  if (!u) return '';
  if (u === 'PASS') return 'P';
  if (u === 'FAIL') return 'F';
  if (u === 'NA') return 'N/A';
  return u;
}

function harvestMeta(t, meta) {
  let m;
  if (!meta.reportRef && ((m = t.match(/SERVICE\s*REPORT\s*:?\s*([A-Z]{0,4}-?\d{3,}[A-Z0-9-]*)/i)) || (m = t.match(/\breport\s*(?:no\.?|number|#|ref(?:erence)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})/i)))) meta.reportRef = m[1];
  if (!meta.date && (m = t.match(DATE_LABEL_RE)) && parseDateISO(m[1])) meta.date = m[1].trim();
  if (!meta.taskRef && (m = t.match(/task\s+ref(?:erence)?\s*:?\s*(\S+)/i))) meta.taskRef = m[1];
  if (!meta.taskName && (m = t.match(/task\s+name\s*:?\s*(.+)$/i))) meta.taskName = m[1].trim();
  if (!meta.site && (m = t.match(/service\s+to\s+(.+?)\s+which\s+was/i))) meta.site = m[1].trim();
  if (!meta.signoff && (m = t.match(/^date\s*:\s*(.+)$/i))) meta.signoff = m[1].trim();
}

function splitHeader(header) {
  const parts = header.split(/\s+[-–]\s+/);
  if (parts.length < 2) return { prefix: '', description: header };
  let bi = 0; let best = -Infinity;
  parts.forEach((p, i) => {
    const toks = p.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const sc = toks.filter((t) => /^[A-Za-z]{3,}$/.test(t)).length - 2 * toks.filter((t) => /\d/.test(t)).length;
    if (sc >= best) { best = sc; bi = i; }
  });
  return { prefix: parts.filter((p, i) => i !== bi).join(' - ').trim(), description: parts[bi].trim() };
}

function parseDefects(text) {
  const out = [];
  const t = normSpace(text);
  if (!t) return out;
  const re = /(Critical\s+defect|Non[-\s]?critical\s+defect|Major\s+defect|Minor\s+defect|Recommendation|Defect)\s+(D-?\d+)?\s*(?:identified\s+(\d+)\s+days?\s+ago(?:\s+ago)?)?/gi;
  const marks = [];
  let m;
  while ((m = re.exec(t))) {
    if (/^(Recommendation|Defect)$/i.test(m[1]) && !m[2]) continue;
    marks.push({ idx: m.index, end: m.index + m[0].length, type: m[1], id: m[2] || '', age: m[3] ? parseInt(m[3], 10) : null });
  }
  const segment = (s) => {
    const rep = s.match(/Defects?\s+Reported\s*:\s*(.*?)(?=Repairs?\s+Required\s*:|$)/i);
    const fix = s.match(/Repairs?\s+Required\s*:\s*(.*)$/i);
    return { reported: rep ? normSpace(rep[1]) : '', repairs: fix ? normSpace(fix[1]) : '', rest: !rep && !fix ? normSpace(s) : '' };
  };
  if (!marks.length) {
    const sg = segment(t);
    if (sg.reported || sg.repairs) out.push({ type: 'Defect', id: '', age: null, reported: sg.reported, repairs: sg.repairs });
    else if (t.length > 3) out.push({ type: 'Note', id: '', age: null, reported: t, repairs: '' });
    return out;
  }
  marks.forEach((mk, i) => {
    const sg = segment(t.slice(mk.end, i + 1 < marks.length ? marks[i + 1].idx : t.length));
    const type = /non/i.test(mk.type) ? 'Non-critical defect' : /critical|major/i.test(mk.type) ? 'Critical defect' : /recommend/i.test(mk.type) ? 'Recommendation' : /minor/i.test(mk.type) ? 'Minor defect' : 'Defect';
    out.push({ type, id: mk.id, age: mk.age, reported: sg.reported || sg.rest, repairs: sg.repairs });
  });
  return out;
}

function finalizeRaw(r) {
  const hp = splitHeader(r.header);
  const pairs = r.conditions.map((v, i) => [v, r.condPages[i] || null]).filter((p) => p[0] >= 0 && p[0] <= 10);
  return {
    header: r.header, prefix: hp.prefix, description: hp.description, subloc: r.subloc || '',
    result: r.result || '', sections: r.sections.slice(),
    checks: r.checks.map((c) => ({ section: c.section, code: c.code, title: c.title, detail: c.detail, result: c.result })),
    conditions: pairs.map((p) => p[0]), condPages: pairs.map((p) => p[1]),
    defects: parseDefects(r.comments.join(' ')), comments: normSpace(r.comments.join(' ')), pages: r.pages.slice()
  };
}

/**
 * pages: [{ num, width, height, items: [{ str, x, y, w, size }] }]
 * returns { meta, records (raw), warnings, textLines, pageCount }
 */
export function interpretPages(pages, fileName) {
  const warnings = [];
  let cols = null;
  const lines = [];
  pages.forEach((pg) => { cols = detectColumns(pg, cols); attachValues(buildLines(pg, cols)).forEach((l) => lines.push(l)); });

  // Running headers / footers: identical text in the top or bottom band on many pages.
  const bandPages = new Map();
  lines.forEach((l) => {
    if (l.yRel > 0.9 || l.yRel < 0.08) {
      const k = l.full.toUpperCase();
      if (!bandPages.has(k)) bandPages.set(k, new Set());
      bandPages.get(k).add(l.page);
    }
  });
  const minRepeat = Math.max(3, Math.ceil(pages.length * 0.4));
  lines.forEach((l) => {
    if (PAGE_NO_RE.test(l.full)) { l.noise = true; return; }
    if (!(l.yRel > 0.9 || l.yRel < 0.08)) return;
    const set = bandPages.get(l.full.toUpperCase());
    if (pages.length >= 3 && set && set.size >= minRepeat) { l.noise = true; return; }
    if (BAND_NOISE_RES.some((re) => re.test(l.full))) l.noise = true;
  });

  const body = lines.filter((l) => !l.noise);
  const bodySize = median(body.filter((l) => l.left && CHECK_RE.test(l.left)).map((l) => l.leftSize)) || median(body.filter((l) => l.left).map((l) => l.leftSize)) || 9;
  const hasHeaderRow = body.some((l) => HEADER_ROW_RE.test(l.full));
  const meta = { reportRef: '', date: '', dateISO: '', dateSource: 'not_found', taskRef: '', taskName: '', site: '', signoff: '' };

  const raws = [];
  let cur = null; let curCheck = null; let section = ''; let inBody = !hasHeaderRow; let awaitingSub = false;
  const finish = () => { if (cur) raws.push(cur); cur = null; curCheck = null; awaitingSub = false; };
  const addCond = (v, page) => { cur.conditions.push(v); cur.condPages.push(page); };
  const isCond = (s) => COND_LABEL_RE.test(s);
  const isHeaderLine = (l, resTok) => {
    const left = l.left;
    if (!left || CHECK_RE.test(left) || isCond(left) || COND_SUBLABEL_RE.test(left)) return false;
    if (resTok) return left.length >= 3;
    return l.leftSize >= bodySize * 1.18 && /\s[-–]\s/.test(left) && !SECTION_RE.test(left);
  };

  for (const l of body) {
    if (!inBody || !cur) harvestMeta(l.full, meta);
    if (HEADER_ROW_RE.test(l.full)) { inBody = true; continue; }
    if (/^sign\s*-?\s*off\b/i.test(l.full)) { finish(); inBody = false; continue; }
    const resTok = (l.result && RESULT_RE.test(l.result)) ? normResult(l.result) : (l.assetResult ? normResult(l.assetResult) : '');
    if (l.left && !resTok && SECTION_RE.test(l.left) && !CHECK_RE.test(l.left) && l.leftSize >= bodySize) { finish(); section = l.left; continue; }
    if (!inBody) continue;
    const left = l.left;

    if (cur && awaitingSub && left && !CHECK_RE.test(left) && !isCond(left) && !COND_SUBLABEL_RE.test(left) && (l.leftSize < cur.headerSize - 0.4 || !resTok)) {
      cur.subloc = left; awaitingSub = false;
      if (resTok && !cur.result) cur.result = resTok;
      if (l.comment && !VALUE_RE.test(l.comment)) cur.comments.push(l.comment);
      if (!cur.pages.includes(l.page)) cur.pages.push(l.page);
      continue;
    }
    awaitingSub = false;

    if (isHeaderLine(l, resTok)) {
      finish();
      cur = { header: left, subloc: '', result: resTok, sections: section ? [section] : [], checks: [], conditions: [], condPages: [], comments: [], pages: [l.page], headerSize: l.leftSize };
      awaitingSub = true;
      if (l.comment && !VALUE_RE.test(l.comment)) cur.comments.push(l.comment);
      continue;
    }
    if (!cur) continue;
    if (!cur.pages.includes(l.page)) cur.pages.push(l.page);
    if (resTok && !cur.result) cur.result = resTok;

    const cm = left ? left.match(CHECK_RE) : null;
    if (cm && !isCond(left)) {
      curCheck = { section, code: cm[1], title: cm[2].trim(), detail: '', result: normValue(l.value) };
      cur.checks.push(curCheck);
    } else if (left && isCond(left)) {
      curCheck = { cond: true, done: false };
      if (l.value && /^\d/.test(l.value)) { addCond(parseFloat(l.value), l.page); curCheck.done = true; }
    } else if (left) {
      const im = COND_SUBLABEL_RE.test(left) ? null : left.match(COND_INLINE_RE);
      if (im) addCond(parseInt(im[1], 10), l.page);
      else if (!COND_SUBLABEL_RE.test(left) && curCheck && !curCheck.cond) curCheck.detail = normSpace(curCheck.detail + ' ' + left);
    }
    if (l.comment) {
      if (VALUE_RE.test(l.comment)) {
        if (curCheck && curCheck.cond && !curCheck.done && /^\d/.test(l.comment)) { addCond(parseFloat(l.comment), l.page); curCheck.done = true; }
        else if (curCheck && !curCheck.cond && !curCheck.result) curCheck.result = normValue(l.comment);
      } else cur.comments.push(l.comment);
    }
  }
  finish();

  // Fallback for unfamiliar layouts: "<asset description> ... PASS|FAIL ..." on one line.
  if (!raws.length) {
    warnings.push('Standard table layout not recognised; used line-based extraction.');
    let c = null;
    body.forEach((l) => {
      const m = l.full.match(/^(.{4,}?)\s+(PASS(?:ED)?|FAIL(?:ED)?|NO\s*TEST|NOT\s*TESTED)\b\s*(.*)$/i);
      if (m && !CHECK_RE.test(m[1])) {
        if (c) raws.push(c);
        c = { header: m[1].trim(), subloc: '', result: normResult(m[2]), sections: [], checks: [], conditions: [], condPages: [], comments: m[3] ? [m[3]] : [], pages: [l.page], headerSize: l.leftSize };
        return;
      }
      if (!c) return;
      const im = l.full.match(COND_INLINE_RE);
      if (im) { c.conditions.push(parseInt(im[1], 10)); c.condPages.push(l.page); }
      else if (/defect|repair|recommend|replace|corro|damage|leak/i.test(l.full)) c.comments.push(l.full);
    });
    if (c) raws.push(c);
  }

  meta.reportRef = meta.reportRef || String(fileName || '').replace(/\.pdf$/i, '');
  meta.dateISO = parseDateISO(meta.date || meta.signoff);
  if (meta.dateISO) meta.dateSource = 'report';
  else {
    for (const l of lines) { // no labelled date: the first date printed on the first two pages
      if (l.page > 2) break;
      const iso = parseDateISO(l.full);
      if (iso) { meta.dateISO = iso; meta.date = fmtDate(iso); meta.dateSource = 'first_date'; break; }
    }
  }
  if (!meta.dateISO) warnings.push('The report date was not found.');
  const records = raws.map(finalizeRaw);
  if (records.length && !records.some((r) => r.conditions.length)) warnings.push('No condition ratings were found in this report.');
  if (!records.length) warnings.push('No assets were found. The PDF may be scanned (image only) or use an unsupported layout.');
  const textLines = lines.map((l) => (l.noise ? '- ' : '  ') + 'p' + l.page + '\t' + [l.left, l.result, l.comment].join('\t|\t') + (l.value != null ? '\t[' + l.value + ']' : '') + (l.assetResult ? '\t[' + l.assetResult + ']' : ''));
  return { meta, records, warnings, textLines, pageCount: pages.length };
}

/* ---------- raw records -> findings payload ---------- */
const RESULT_RANK = { FAIL: 3, PASS: 2, 'NO TEST': 1 };

function defectsText(rec) {
  const parts = rec.defects.filter((d) => d.type !== 'Note').map((d) => d.type + (d.id ? ' ' + d.id : '') + (d.reported ? ': ' + d.reported : '') + (d.repairs ? ' (repairs required: ' + d.repairs + ')' : ''));
  const failed = rec.checks.filter((c) => c.result === 'F');
  if (failed.length) parts.push('Failed check(s): ' + uniq(failed.map((c) => c.code + ' ' + c.title)).join('; '));
  if (!parts.length && rec.comments) parts.push(rec.comments);
  return parts.join(' | ');
}
function findingsText(rec) {
  const n = { P: 0, F: 0, N: 0, other: 0 };
  rec.checks.forEach((c) => { if (c.result === 'P') n.P++; else if (c.result === 'F') n.F++; else if (c.result === 'N' || c.result === 'N/A') n.N++; else if (c.result) n.other++; });
  const scored = n.P + n.F + n.N + n.other;
  const res = rec.result ? 'Result ' + rec.result : '';
  return [res, scored ? scored + ' checks: ' + n.P + ' pass, ' + n.F + ' fail, ' + n.N + ' n/a' : ''].filter(Boolean).join('; ');
}

// Combines repeat entries of one asset (merge=true), then computes the reported condition and its page(s).
export function buildFindings(raws, merge) {
  const out = [];
  const seen = new Map();
  for (const raw of raws) {
    const key = raw.header.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'ASSET';
    const existing = merge ? seen.get(key) : null;
    if (existing) {
      raw.sections.forEach((s) => { if (!existing.sections.includes(s)) existing.sections.push(s); });
      existing.checks = existing.checks.concat(raw.checks);
      existing.conditions = existing.conditions.concat(raw.conditions);
      existing.condPages = existing.condPages.concat(raw.condPages);
      raw.defects.forEach((d) => { if (!existing.defects.some((x) => (d.id && x.id === d.id) || (!d.id && x.reported === d.reported))) existing.defects.push({ ...d }); });
      if (raw.comments && !existing.comments.includes(raw.comments)) existing.comments = normSpace(existing.comments + ' ' + raw.comments);
      raw.pages.forEach((p) => { if (!existing.pages.includes(p)) existing.pages.push(p); });
      if ((RESULT_RANK[raw.result] || 0) > (RESULT_RANK[existing.result] || 0)) existing.result = raw.result;
      if (!existing.subloc && raw.subloc) existing.subloc = raw.subloc;
      continue;
    }
    const rec = JSON.parse(JSON.stringify(raw));
    seen.set(key, rec);
    out.push(rec);
  }
  return out.map((rec, i) => {
    const condition = rec.conditions.length ? Math.round(Math.max(...rec.conditions)) : null;
    const conditionPages = condition == null ? [] : uniq(rec.conditions.map((v, j) => (Math.round(v) === condition ? rec.condPages[j] : null)));
    const z = extractZones(rec.header + ' ' + rec.subloc, null);
    return {
      seq: i + 1,
      header: rec.header, prefix: rec.prefix, description: rec.description, subloc: rec.subloc,
      result: rec.result, condition: condition != null && condition >= 0 && condition <= 10 ? condition : null,
      conditionLabel: condition != null ? (COND_LABELS[condition] || '') : '',
      conditionPages, pages: rec.pages, sections: rec.sections, checks: rec.checks, defects: rec.defects, comments: rec.comments,
      zoneRef: [...z.zones].sort((a, b) => a - b).map((n) => 'Zone ' + n).join(', '),
      locationRef: rec.subloc || (isCodeLike(rec.prefix) ? '' : rec.prefix),
      inspectionNotes: defectsText(rec),
      findingsSummary: findingsText(rec)
    };
  });
}

// "3, 4, 5, 9" -> "3-5, 9"
export function pageList(nums) {
  const a = uniq(nums || []).map(Number).filter((n) => n > 0).sort((x, y) => x - y);
  const out = [];
  let i = 0;
  while (i < a.length) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    out.push(j > i ? a[i] + '-' + a[j] : String(a[i]));
    i = j + 1;
  }
  return out.join(', ');
}
