/* ==========================================================================
   Scale Point Group - asset matching engine
   Pure functions shared by the server (matching, register staging) and the browser.
   A report asset is compared with register assets on description words, zone,
   carriageway / location codes, keywords and exact identifiers, giving a 0-100 score.
   ========================================================================== */

export const DEFAULT_SYNONYMS = [
  '# One rule per line:  CANONICAL = variant, variant, ...',
  '# Every variant is treated as the canonical term when matching. Edit to suit site naming.',
  'ZONE = ZN, ZNE',
  'DELUGE ZONE = DZ',
  'DELUGE VALVE = DV, DLV',
  'SB = SOUTHBOUND, SOUTH BOUND, S',
  'NB = NORTHBOUND, NORTH BOUND, N',
  'EB = EASTBOUND, EAST BOUND',
  'WB = WESTBOUND, WEST BOUND',
  'CP = CROSS PASSAGE, XP',
  'PIPE = PIPING, PIPEWORK, PIPELINE',
  'VALVE = VLV',
  'FIRE WATER RING = FWR, FIRE RING, FIRERING, RING MAIN, FIRE MAIN',
  'SPRINKLER = SPK, SPRK, SPR',
  'TUNNEL = TUN, TNL',
  'NORTHERN PORTAL = NPTL, NORTH PORTAL, NTH PORTAL',
  'SOUTHERN PORTAL = SPTL, SOUTH PORTAL, STH PORTAL',
  'HOSE REEL = FHR',
  'HYDRANT = HYD',
  'PUMP = PMP',
  'DETECTOR = DET',
  'PORTAL = PTL'
].join('\n');

export const DEFAULT_MATCHING = Object.freeze({
  weights: { assetNumber: 100, assetId: 100, description: 50, zone: 20, location: 20, keyword: 10 },
  thresholds: { match: 95, likely: 80, review: 60 },
  conflictPenalty: 25,
  ambiguityMargin: 3,
  inactivePenalty: 10,
  synonyms: DEFAULT_SYNONYMS
});

export const COND_LABELS = { 1: 'Very Good', 2: 'Good', 3: 'Fair', 4: 'Poor', 5: 'Very Poor' };
export const ACCEPTED_STATUSES = new Set(['match', 'likely', 'confirmed', 'manual']);

const DIRECTIONS = new Set(['NB', 'SB', 'EB', 'WB']);
const STOP = new Set(['A', 'AN', 'AND', 'OF', 'THE', 'FOR', 'TO', 'IN', 'ON', 'AT', 'BY', 'WITH', 'FROM', 'OR',
  'NO', 'NUMBER', 'NUM', 'ASSET', 'ASSETS', 'ITEM', 'UNIT', 'LOC', 'LOCATION', 'SYSTEM', 'PTY', 'LTD', 'TYPE', 'SITEID']);
export const INACTIVE_RE = /^(DECOMMISSIONED|INACTIVE|MISSING|DISPOSED|SCRAPPED)$/i;

const normSpace = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function intersects(a, b) { const [s, l] = a.size <= b.size ? [a, b] : [b, a]; for (const x of s) if (l.has(x)) return true; return false; }
function countInter(a, b) { let n = 0; for (const x of a) if (b.has(x)) n++; return n; }

export function mergeMatchingSettings(saved) {
  const base = JSON.parse(JSON.stringify(DEFAULT_MATCHING));
  const s = saved && typeof saved === 'object' ? saved : {};
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (s.weights) Object.keys(base.weights).forEach((k) => { if (num(s.weights[k])) base.weights[k] = s.weights[k]; });
  if (s.thresholds) Object.keys(base.thresholds).forEach((k) => { if (num(s.thresholds[k])) base.thresholds[k] = s.thresholds[k]; });
  ['conflictPenalty', 'ambiguityMargin', 'inactivePenalty'].forEach((k) => { if (num(s[k])) base[k] = s[k]; });
  if (typeof s.synonyms === 'string' && s.synonyms.trim()) base.synonyms = s.synonyms;
  return base;
}

/* ---------- synonyms, zones and tokens ---------- */
export function parseSynonyms(text) {
  const single = new Map();
  const phrases = [];
  const groups = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const l = line.replace(/#.*$/, '').trim();
    const eq = l.indexOf('=');
    if (!l || eq < 1) return;
    const canon = normSpace(l.slice(0, eq).toUpperCase());
    if (!canon) return;
    const variants = l.slice(eq + 1).split(',').map((v) => normSpace(v.toUpperCase())).filter(Boolean);
    groups.push(canon);
    [canon].concat(variants).forEach((v) => {
      if (v.indexOf(' ') >= 0) {
        phrases.push({ variant: v, canon, key: canon.replace(/ /g, ''), re: new RegExp('(^|[^A-Z0-9])' + escRe(v).replace(/ /g, '[\\s\\-_/]+') + '(?=[^A-Z0-9]|$)', 'g') });
      } else if (!single.has(v)) {
        single.set(v, canon);
      }
    });
  });
  phrases.sort((a, b) => b.variant.length - a.variant.length);
  // "<WORD> ZONE" groups (e.g. DELUGE ZONE = DZ) let a zone number plus the word imply the code.
  const zonePhrases = groups.filter((c) => /^[A-Z]+ ZONE$/.test(c)).map((c) => ({ word: c.split(' ')[0], key: c.replace(/ /g, '') }));
  return { single, phrases, zonePhrases };
}

function dirFromLetter(ch, syn) {
  const c = syn && syn.single.get(ch);
  if (c && DIRECTIONS.has(c)) return c;
  return { N: 'NB', S: 'SB', E: 'EB', W: 'WB' }[ch] || null;
}

// Zone numbers in free text: ZONE 13, ZONES 11&12, Zone S35, CZone 47, Z13, DZ13 and deluge sections S-35 / N-01.
export function extractZones(text, syn) {
  const zones = new Set();
  const dirs = new Set();
  let s = ' ' + String(text || '').toUpperCase().replace(/[‐-―]/g, '-') + ' ';
  s = s.replace(/ZONES?\s*(\d{1,4})\s*(?:&|AND|,|\/|\+)\s*(\d{1,4})(?!\d)/g, (m, a, b) => { zones.add(parseInt(a, 10)); zones.add(parseInt(b, 10)); return ' '; });
  s = s.replace(/ZONE\s*(?:NO\.?\s*|#\s*)?[-:]?\s*([NSEW])?\s*-?\s*(\d{1,4})(?!\d)/g, (m, d, n) => {
    zones.add(parseInt(n, 10)); if (d) { const x = dirFromLetter(d, syn); if (x) dirs.add(x); } return ' ';
  });
  s = s.replace(/(^|[^A-Z0-9])D?Z\s*[-:#]?\s*(\d{1,4})(?!\d)/g, (m, pre, n) => { zones.add(parseInt(n, 10)); return pre + ' '; });
  s = s.replace(/(^|[^A-Z0-9])([NS])\s?-\s?(\d{1,3})(?!\d)/g, (m, pre, d, n) => {
    zones.add(parseInt(n, 10)); const x = dirFromLetter(d, syn); if (x) dirs.add(x); return pre + ' ';
  });
  return { zones, dirs, rest: s };
}

// mode 'type': descriptive words (Deluge, Valve...). mode 'loc': location / identifier codes.
export function tokenize(text, mode, syn) {
  let s = ' ' + String(text || '').toUpperCase() + ' ';
  for (const p of syn.phrases) s = s.replace(p.re, (m, pre) => pre + ' ' + (mode === 'loc' ? p.key : p.canon) + ' ');
  const words = new Set();
  const codes = new Set();
  const dirs = new Set();
  for (const raw of s.split(/[^A-Z0-9]+/)) {
    if (!raw || /^\d+$/.test(raw)) continue; // bare numbers mean nothing on their own
    let t = raw;
    let canon = syn.single.get(t);
    if (!canon && t.length >= 5 && /S$/.test(t) && !/SS$/.test(t)) { t = t.slice(0, -1); canon = syn.single.get(t); }
    if (canon) {
      if (DIRECTIONS.has(canon)) { dirs.add(canon); continue; }
      const key = canon.replace(/ /g, '');
      if (mode === 'loc' || key.length <= 2) codes.add(key);
      else canon.split(' ').forEach((w) => { if (!STOP.has(w)) words.add(w); });
      continue;
    }
    const m = t.match(/^([A-Z]+)0*(\d+)([A-Z]*)$/);
    if (m) { // alphanumeric code: normalise leading zeros and known prefixes (XP04 -> CP4)
      const lc = syn.single.get(m[1]);
      const lead = lc && !DIRECTIONS.has(lc) ? lc.replace(/ /g, '') : m[1];
      codes.add(lead + m[2] + m[3]);
      const db = m[1].match(/^DB([NSEW])$/); // deluge bank DBN/DBS carries the carriageway
      if (db) dirs.add(dirFromLetter(db[1], syn));
      continue;
    }
    if (/\d/.test(t)) { codes.add(t); continue; }
    if (STOP.has(t) || t.length < 2) continue;
    if (mode === 'type' && t.length >= 3) words.add(t); else codes.add(t);
  }
  return { words, codes, dirs };
}

export function buildFeatures(typeText, locText, zoneText, syn) {
  const z = extractZones(zoneText, syn);
  const T = tokenize(extractZones(typeText, syn).rest, 'type', syn);
  const L = tokenize(extractZones(locText, syn).rest, 'loc', syn);
  const type = T.words;
  const loc = new Set(T.codes);
  L.codes.forEach((c) => { if (!type.has(c)) loc.add(c); });
  const dirs = new Set([...z.dirs, ...T.dirs, ...L.dirs]);
  // A location phrase that merely repeats the description (e.g. "Fire Water Ring - SB") is not a location code.
  syn.phrases.forEach((p) => { if (loc.has(p.key) && p.canon.split(' ').every((w) => type.has(w))) loc.delete(p.key); });
  if (z.zones.size) syn.zonePhrases.forEach((zp) => { if (type.has(zp.word) || loc.has(zp.word)) loc.add(zp.key); });
  return withKeywords({ type, loc, dirs, zones: z.zones, ids: new Map(), idCands: new Set(), inactive: '' });
}

function withKeywords(f) {
  f.kw = new Set(f.type);
  f.loc.forEach((c) => { if (c.length >= 3 && !/\d/.test(c)) f.kw.add(c); });
  return f;
}

export function normId(v) {
  const s = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 3 ? s : '';
}
export function isCodeLike(s) {
  s = String(s || '').trim();
  return /^[A-Z0-9]+(?:[-_./][A-Z0-9]+)+$/i.test(s) && /\d/.test(s) && /[A-Z]/i.test(s);
}

// Register side. row: { assetCode, description, location, locationDescription, status, altId }
export function registerFeatures(row, syn) {
  const desc = String(row.description || '');
  let bracket = '';
  const typeText = desc.replace(/\[([^\]]*)\]/g, (m, g) => { bracket += ' ' + g.replace(/^\s*LOC(?:ATION)?\s*:/i, ' ').replace(/Undefined Location\s*-?\s*Must Be Assigned/i, ' '); return ' '; });
  // A zone stated in the description itself (ZONE 13, S-34) wins over a deluge-zone code in the [LOC: ...] path.
  const own = typeText + ' ' + (row.locationDescription || '');
  const zoneText = extractZones(own, syn).zones.size ? own : [desc, row.location, row.locationDescription].join(' ');
  const f = buildFeatures(typeText, [row.location, row.locationDescription, bracket].join(' '), zoneText, syn);
  const a = normId(row.assetCode);
  const b = normId(row.altId);
  const c = isCodeLike(row.location) ? normId(row.location) : '';
  if (a) f.ids.set(a, 'assetNumber');
  if (b && !f.ids.has(b)) f.ids.set(b, 'assetId');
  if (c && !f.ids.has(c)) f.ids.set(c, 'location');
  f.inactive = INACTIVE_RE.test(String(row.status || '').trim()) ? String(row.status).trim().toUpperCase() : '';
  return f;
}

// Report side. rec: { header, prefix, description, subloc }
export function findingFeatures(rec, syn) {
  const prefix = rec.prefix || '';
  const prefixIsCode = isCodeLike(prefix);
  const f = buildFeatures(rec.description || rec.header, (prefixIsCode ? '' : prefix) + ' ' + (rec.subloc || ''), (rec.header || '') + ' ' + (rec.subloc || ''), syn);
  const add = (v) => { const n = normId(v); if (n && /\d/.test(n)) f.idCands.add(n); };
  if (prefixIsCode) add(prefix);
  // Only the asset header is searched for IDs: sub-location codes (CP01, DBN01) are places, not assets.
  String(rec.header || '').split(/[\s,;()[\]]+/).forEach((t) => { if ((isCodeLike(t) && t.length >= 5) || /^\d{5,}$/.test(t)) add(t); });
  return f;
}

/* ---------- persisted form of register features ---------- */
export function featuresToTokens(f) {
  const out = [];
  f.type.forEach((t) => out.push('T:' + t));
  f.loc.forEach((t) => out.push('L:' + t));
  f.zones.forEach((z) => out.push('Z:' + z));
  f.dirs.forEach((d) => out.push('D:' + d));
  f.ids.forEach((kind, id) => out.push('I:' + kind + ':' + id));
  if (f.inactive) out.push('S:' + f.inactive);
  return out;
}

export function tokensToFeatures(tokens) {
  const f = { type: new Set(), loc: new Set(), zones: new Set(), dirs: new Set(), ids: new Map(), idCands: new Set(), inactive: '' };
  for (const t of tokens || []) {
    const k = t.slice(0, 2);
    const v = t.slice(2);
    if (k === 'T:') f.type.add(v);
    else if (k === 'L:') f.loc.add(v);
    else if (k === 'Z:') f.zones.add(parseInt(v, 10));
    else if (k === 'D:') f.dirs.add(v);
    else if (k === 'S:') f.inactive = v;
    else if (k === 'I:') { const i = v.indexOf(':'); f.ids.set(v.slice(i + 1), v.slice(0, i)); }
  }
  return withKeywords(f);
}

// Tokens used to shortlist register rows in the database. Very common tokens (stats[token] > limit) are skipped.
export function prefilterTokens(pf, stats, assetCount) {
  const limit = Math.max(500, Math.round((assetCount || 0) * 0.2));
  const common = (t) => stats && stats[t] > limit;
  const want = [];
  pf.type.forEach((t) => want.push('T:' + t));
  pf.loc.forEach((t) => want.push('L:' + t));
  pf.zones.forEach((z) => want.push('Z:' + z));
  let list = want.filter((t) => !common(t));
  if (!list.length) list = want; // everything common: fall back to all tokens (query is still LIMITed)
  pf.idCands.forEach((id) => ['assetNumber', 'assetId', 'location'].forEach((k) => list.push('I:' + k + ':' + id)));
  return list;
}

/* ---------- scoring ---------- */
export function descSim(A, B) {
  if (!A.size || !B.size) return { sim: 0, common: [] };
  let m = 0;
  const common = [];
  for (const a of A) {
    if (B.has(a)) { m += 1; common.push(a); continue; }
    for (const b of B) {
      if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) { m += 0.8; common.push(a + '~' + b); break; }
    }
  }
  const containment = Math.min(1, m / Math.min(A.size, B.size));
  const dice = Math.min(1, (2 * m) / (A.size + B.size));
  return { sim: 0.6 * containment + 0.4 * dice, common };
}

// Scores report asset p against register asset r. detail=true returns the full breakdown.
export function scorePair(p, r, S, detail) {
  const W = S.weights;
  let idKind = null;
  let idVal = null;
  if (p.idCands.size && r.ids.size) {
    for (const id of p.idCands) { const k = r.ids.get(id); if (k) { idKind = k; idVal = id; break; } }
  }
  const d = descSim(p.type, r.type);

  let zone; let zoneState;
  if (p.zones.size && r.zones.size) { zone = intersects(p.zones, r.zones) ? 1 : 0; zoneState = zone ? 'match' : 'conflict'; }
  else if (!p.zones.size && !r.zones.size) { zone = 0.5; zoneState = 'none'; }
  else { zone = 0.25; zoneState = 'partial'; }

  let dir = null; let dirState = 'none';
  if (p.dirs.size && r.dirs.size) { dir = intersects(p.dirs, r.dirs) ? 1 : 0; dirState = dir ? 'match' : 'conflict'; }
  else if (p.dirs.size || r.dirs.size) dirState = 'partial';
  const overlap = p.loc.size ? countInter(p.loc, r.loc) / p.loc.size : 0;
  const loc = dir === null ? overlap : 0.6 * dir + 0.4 * overlap;
  const kw = p.kw.size ? countInter(p.kw, r.kw) / p.kw.size : 0;

  const T = (W.description + W.zone + W.location + W.keyword) || 1;
  const scale = 100 / T;
  const pts = { desc: d.sim * W.description * scale, zone: zone * W.zone * scale, loc: loc * W.location * scale, kw: kw * W.keyword * scale };
  const attribute = pts.desc + pts.zone + pts.loc + pts.kw;
  const pen = [];
  if (zoneState === 'conflict') pen.push({ reason: 'Zone conflict', points: S.conflictPenalty });
  if (dirState === 'conflict') pen.push({ reason: 'Carriageway / direction conflict', points: S.conflictPenalty });
  if (r.inactive) pen.push({ reason: 'Register status is ' + r.inactive, points: S.inactivePenalty });
  let score = attribute - pen.reduce((s, x) => s + x.points, 0);
  let idPoints = 0;
  if (idKind) { // an exact identifier is authoritative: it scores its weight outright
    idPoints = idKind === 'assetNumber' ? W.assetNumber : W.assetId;
    score = Math.max(idPoints, attribute) - (r.inactive ? S.inactivePenalty : 0);
  }
  score = clamp(Math.round(score * 10) / 10, 0, 100);
  if (!detail) return score;
  return {
    score,
    id: { kind: idKind, value: idVal, points: idPoints },
    desc: { sim: Math.round(d.sim * 1000) / 1000, points: pts.desc, max: W.description * scale, common: d.common, pdf: [...p.type], reg: [...r.type] },
    zone: { state: zoneState, points: pts.zone, max: W.zone * scale, pdf: [...p.zones], reg: [...r.zones] },
    loc: { points: pts.loc, max: W.location * scale, dirState, pdfDir: [...p.dirs], regDir: [...r.dirs], common: [...p.loc].filter((x) => r.loc.has(x)) },
    kw: { points: pts.kw, max: W.keyword * scale, common: [...p.kw].filter((x) => r.kw.has(x)) },
    penalties: pen,
    attribute: Math.round(attribute * 10) / 10
  };
}

// items: [{ ref, f }] -> top candidates [{ ref, score, b }]
export function rankCandidates(pf, items, S, top = 5) {
  const best = [];
  for (const it of items) {
    const s = scorePair(pf, it.f, S, false);
    if (s <= 0) continue;
    if (best.length < top + 1 || s > best[best.length - 1].s) {
      best.push({ it, s });
      best.sort((a, b) => b.s - a.s);
      if (best.length > top + 1) best.pop();
    }
  }
  return best.slice(0, top).map(({ it }) => {
    const b = scorePair(pf, it.f, S, true);
    return { ref: it.ref, score: b.score, b };
  });
}

// Runner-up candidates within the ambiguity margin. Behind an exact identifier only other exact identifiers count.
export function ambiguity(cands, S) {
  if (!cands || cands.length < 2) return 0;
  const idTop = !!(cands[0].b && cands[0].b.id.kind);
  let n = 0;
  for (let i = 1; i < cands.length; i++) {
    if (cands[0].score - cands[i].score < S.ambiguityMargin && (!idTop || (cands[i].b && cands[i].b.id.kind))) n++;
  }
  return n;
}

export function autoStatus(cands, S) {
  const best = cands && cands[0];
  if (!best) return 'nomatch';
  const T = S.thresholds;
  let st = best.score >= T.match ? 'match' : best.score >= T.likely ? 'likely' : best.score >= T.review ? 'review' : 'nomatch';
  if ((st === 'match' || st === 'likely') && ambiguity(cands, S) > 0) st = 'review';
  return st;
}

const idLabel = (kind) => (kind === 'assetNumber' ? 'asset number' : kind === 'location' ? 'location code' : 'asset ID');

// Plain-language reason for an automatic decision. cands carry { assetCode, status, score, b }.
export function explainMatch(status, cands, S) {
  const T = S.thresholds;
  const best = cands && cands[0];
  if (!best) return 'No asset in the register shares its description, zone or location.';
  const b = best.b;
  const why = [];
  if (b.id.kind) why.push('exact ' + idLabel(b.id.kind) + ' ' + b.id.value);
  else {
    why.push('description ' + Math.round(b.desc.sim * 100) + '% similar');
    if (b.zone.state === 'match') why.push('zone ' + b.zone.pdf.filter((z) => b.zone.reg.includes(z)).join('/') + ' agrees');
    else if (b.zone.state === 'conflict') why.push('zone differs (report ' + b.zone.pdf.join('/') + ', register ' + b.zone.reg.join('/') + ')');
    else if (b.zone.state === 'partial') why.push('zone stated on one side only');
    if (b.loc.dirState === 'match') why.push('carriageway ' + b.loc.pdfDir.filter((x) => b.loc.regDir.includes(x)).join('/') + ' agrees');
    else if (b.loc.dirState === 'conflict') why.push('carriageway differs (report ' + b.loc.pdfDir.join('/') + ', register ' + b.loc.regDir.join('/') + ')');
    if (b.loc.common.length) why.push('shared location ' + b.loc.common.slice(0, 3).join(', '));
  }
  if (best.status && INACTIVE_RE.test(String(best.status).trim())) why.push('register status ' + String(best.status).trim().toUpperCase());
  const score = Math.round(best.score);
  const tail = ': ' + why.join('; ');
  if (status === 'nomatch') return 'No confident match. Closest asset ' + (best.assetCode || '') + ' scored ' + score + '% (review threshold ' + T.review + '%)' + tail + '.';
  if (status === 'review') {
    const amb = ambiguity(cands, S);
    if (amb && best.score >= T.likely) {
      const others = cands.slice(1).filter((c) => best.score - c.score < S.ambiguityMargin).map((c) => c.assetCode).filter(Boolean).slice(0, 3);
      return score + '% but ' + amb + ' other asset' + (amb > 1 ? 's' : '') + ' scored within ' + S.ambiguityMargin + ' points (' + others.join(', ') + ')' + tail + '.';
    }
    return score + '% confidence, below the ' + T.likely + '% auto-accept level' + tail + '.';
  }
  return score + '% confidence' + tail + '.';
}
