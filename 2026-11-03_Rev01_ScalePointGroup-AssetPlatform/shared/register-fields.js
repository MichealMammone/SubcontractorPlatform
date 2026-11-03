// Register fields a spreadsheet column can be mapped to, with heading names recognised automatically.
// Shared by the browser (mapping screen) and the server (validation).
export const REGISTER_FIELDS = [
  { key: 'assetCode', label: 'Asset ID', required: true, syn: ['assetnum', 'assetnumber', 'assetno', 'asset', 'assetid', 'assetcode', 'assetnbr'] },
  { key: 'description', label: 'Asset Description', required: true, syn: ['description', 'assetdescription', 'assetdesc', 'desc', 'assetname', 'name'] },
  { key: 'category', label: 'Asset Category', syn: ['category', 'assetcategory', 'assetclass', 'class', 'classification', 'assettype', 'type', 'assetrotatingitem', 'rotatingitem', 'itemnum'] },
  { key: 'location', label: 'Location', syn: ['location', 'loc', 'functionallocation', 'funcloc', 'floc', 'locationcode', 'locationid'] },
  { key: 'locationDescription', label: 'Location Description', syn: ['locationdescription', 'locationdesc', 'locdesc', 'locationname'] },
  { key: 'status', label: 'Status', syn: ['status', 'assetstatus'] },
  { key: 'site', label: 'Site', syn: ['siteid', 'site', 'sitecode', 'sitename'] },
  { key: 'criticality', label: 'Criticality', syn: ['criticality', 'assetcriticality', 'priority', 'assetpriority', 'risk'] },
  { key: 'parentAsset', label: 'Parent Asset', syn: ['parent', 'parentasset', 'parentassetnum'] },
  { key: 'altId', label: 'Alternate ID', syn: ['assetuid', 'assettag', 'tag', 'tagnumber', 'serialnum', 'serialnumber', 'altid', 'legacyid', 'externalid'] }
];

export const FIELD_COLUMNS = {
  assetCode: 'asset_code', description: 'description', category: 'category', location: 'location',
  locationDescription: 'location_description', status: 'status', site: 'site', criticality: 'criticality',
  parentAsset: 'parent_asset', altId: 'alt_id'
};

const normKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

export function guessMapping(headers, previous) {
  const keys = headers.map(normKey);
  const map = {};
  const used = new Set();
  // 1. carry the previous version's mapping where the heading is unchanged
  if (previous && previous.mapping && previous.headers) {
    Object.entries(previous.mapping).forEach(([field, i]) => {
      const h = previous.headers[i];
      const j = h == null ? -1 : keys.indexOf(normKey(h));
      if (j >= 0 && !used.has(j)) { map[field] = j; used.add(j); }
    });
  }
  // 2. exact heading matches, 3. partial matches
  REGISTER_FIELDS.forEach((f) => {
    if (map[f.key] != null) return;
    for (const s of f.syn) { const i = keys.indexOf(s); if (i >= 0 && !used.has(i)) { map[f.key] = i; used.add(i); return; } }
  });
  REGISTER_FIELDS.forEach((f) => {
    if (map[f.key] != null) return;
    for (const s of f.syn) {
      if (s.length < 6) continue;
      const i = keys.findIndex((k, j) => !used.has(j) && k.includes(s));
      if (i >= 0) { map[f.key] = i; used.add(i); return; }
    }
  });
  return map;
}

export function detectHeaderRow(aoa) {
  const all = new Set();
  REGISTER_FIELDS.forEach((f) => f.syn.forEach((s) => all.add(s)));
  let best = 0; let bestScore = -1;
  for (let r = 0; r < Math.min(aoa.length, 25); r++) {
    let hits = 0; let filled = 0;
    (aoa[r] || []).forEach((c) => { const k = normKey(c); if (k) { filled++; if (all.has(k)) hits++; } });
    const score = hits * 10 + filled * 0.1;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}
