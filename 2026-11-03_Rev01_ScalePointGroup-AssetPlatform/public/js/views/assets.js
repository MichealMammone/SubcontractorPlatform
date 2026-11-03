// Asset Management: search & filter, add, edit, archive/restore, bulk import/update, asset history.
import { get, post, patch, qs } from '../api.js';
import { h, raw, $, $$, toast, toastError, busy, formDialog, confirmDialog, modal, fmtDate, fmtDateTime, fmtInt, condBadge, matchTag, statusTag, empty, pager, loadScript, wireDropzone, icon } from '../ui.js';
import { REGISTER_FIELDS, guessMapping, detectHeaderRow } from '/shared/register-fields.js';
import { pageList } from '/shared/report-parser.js';

const EDIT_FIELDS = [
  { name: 'description', label: 'Asset Description', required: true }, { name: 'category', label: 'Asset Category' }, { name: 'location', label: 'Location' },
  { name: 'locationDescription', label: 'Location Description' }, { name: 'status', label: 'Status' }, { name: 'site', label: 'Site' }, { name: 'criticality', label: 'Criticality' }
];

export async function list({ el, query, can, navigate }) {
  const page = +query.page || 1;
  const state = query.state || 'active';
  const [d, meta] = await Promise.all([get('/assets' + qs({ ...query, state, page, pageSize: 50 })), get('/assets/categories')]);
  el.innerHTML = String(h`
    <div class="crumbs"><a href="#/registers">Asset Register Hub</a> / Assets</div>
    <div class="page-head"><div><h1>Asset management</h1><p>${d.version ? `Active register version ${d.version.versionNo}. ` : ''}Search, edit and maintain assets. Every change is recorded in the audit trail.</p></div>
      <div class="row">${can('assets.edit') && d.version ? h`<button class="btn btn-primary" id="add">Add asset</button><button class="btn btn-secondary" id="bulk">Bulk import / update</button>` : ''}</div></div>
    ${!d.version ? h`<div class="card">${empty('No active register', 'Publish a master register in the Asset Register Hub first.')}</div>` : h`
    <div class="card flush">
      <form class="toolbar" id="filters">
        <input class="input" type="search" name="q" placeholder="Search Asset ID, description or location" value="${query.q || ''}">
        <select class="input" name="category"><option value="">All categories</option>${meta.categories.map((c) => h`<option ${query.category === c.name ? raw('selected') : ''} value="${c.name}">${c.name} (${fmtInt(c.n)})</option>`)}</select>
        <select class="input" name="status"><option value="">All statuses</option>${meta.statuses.map((s) => h`<option ${query.status === s.name ? raw('selected') : ''} value="${s.name}">${s.name} (${fmtInt(s.n)})</option>`)}</select>
        <select class="input" name="state">${[['active', 'Active assets'], ['archived', 'Archived assets'], ['all', 'All assets']].map(([v, l]) => h`<option value="${v}" ${state === v ? raw('selected') : ''}>${l}</option>`)}</select>
        <select class="input" name="sort">${[['', 'Register order'], ['code', 'Asset ID'], ['description', 'Description'], ['modified', 'Last modified'], ['added', 'Date added']].map(([v, l]) => h`<option value="${v}" ${(query.sort || '') === v ? raw('selected') : ''}>${l}</option>`)}</select>
        <button class="btn btn-secondary btn-sm">Search</button>
      </form>
      ${d.assets.length ? h`<div class="table-wrap"><table class="table"><thead><tr><th>Asset ID</th><th>Asset description</th><th>Category</th><th>Location</th><th>Status</th><th>Date added</th><th>Last modified</th><th></th></tr></thead><tbody>
        ${d.assets.map((a) => h`<tr class="clickable" data-href="#/assets/${a.id}"><td class="mono nowrap cell-main">${a.asset_code}</td><td><div class="clamp2">${a.description}</div>${a.notes ? h`<div class="cell-sub">📝 ${a.notes.slice(0, 80)}</div>` : ''}</td>
          <td class="small">${a.category}</td><td class="small">${a.location}</td><td class="small">${a.status}</td><td class="small nowrap">${fmtDate(a.date_added)}</td><td class="small nowrap">${fmtDate(a.last_modified_at)}</td>
          <td>${a.state === 'archived' ? statusTag('Archived', '') : ''}</td></tr>`)}
      </tbody></table></div>${pager(d.total, d.page, d.pageSize)}` : empty('No assets match', 'Try a different search or filter.')}
    </div>`}`);
  const f = $('#filters', el);
  if (f) f.addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/assets' + qs(Object.fromEntries(new FormData(e.target))); });
  el.addEventListener('click', async (e) => {
    const tr = e.target.closest('[data-href]'); if (tr) { location.hash = tr.dataset.href; return; }
    const pg = e.target.closest('[data-page]'); if (pg) { location.hash = '#/assets' + qs({ ...query, page: pg.dataset.page }); return; }
    if (e.target.closest('#add')) {
      const v = await formDialog({ title: 'Add asset', wide: true, submitLabel: 'Add asset', intro: 'The asset is added to the active register version and is available for matching immediately.',
        fields: [{ name: 'assetCode', label: 'Asset ID', required: true }, ...EDIT_FIELDS, { name: 'notes', label: 'Notes', type: 'textarea', rows: 3 }] });
      if (!v) return;
      try { const r = await post('/assets', v); toast('Asset added.', 'ok'); navigate('#/assets/' + r.id); } catch (err) { toastError(err); }
    }
    if (e.target.closest('#bulk')) bulkImport(navigate);
  });
}

export async function detail({ el, params, can, navigate }) {
  const d = await get('/assets/' + params.id);
  const a = d.asset; const c = d.current || {};
  const archived = a.state === 'archived';
  el.innerHTML = String(h`
    <div class="crumbs"><a href="#/assets">Assets</a> / ${a.asset_code}</div>
    <div class="page-head"><div><h1 class="mono">${a.asset_code} ${archived ? statusTag('Archived', '') : statusTag('Active', 'ok')}</h1><p>${c.description || ''}</p></div>
      <div class="row">${can('assets.edit') && !archived && c.version_status === 'active' ? h`<button class="btn btn-primary" id="edit">Edit asset</button><button class="btn btn-ghost" id="archive">Archive</button>` : ''}
        ${can('assets.edit') && archived && c.version_status === 'active' ? h`<button class="btn btn-secondary" id="restore">Restore asset</button>` : ''}</div></div>
    ${archived ? h`<div class="banner warn"><span>Archived ${fmtDateTime(a.archived_at)}${a.archived_reason ? ': ' + a.archived_reason : ''}. Inspection history is preserved.</span></div>` : ''}
    <div class="grid-2">
      <div class="card"><h2 class="mb16">Asset details</h2><dl class="kv">
        <dt>Asset ID</dt><dd class="mono">${a.asset_code}</dd><dt>Description</dt><dd>${c.description || '—'}</dd><dt>Category</dt><dd>${c.category || '—'}</dd>
        <dt>Location</dt><dd>${c.location || '—'}</dd><dt>Location description</dt><dd>${c.location_description || '—'}</dd><dt>Status</dt><dd>${c.status || '—'}</dd>
        <dt>Site</dt><dd>${c.site || '—'}</dd><dt>Criticality</dt><dd>${c.criticality || '—'}</dd><dt>Date added</dt><dd>${fmtDateTime(a.date_added)}</dd>
        <dt>Last modified</dt><dd>${fmtDateTime(c.last_modified_at)}</dd><dt>Register version</dt><dd>v${c.version_no || '—'}</dd><dt>Notes</dt><dd>${a.notes || '—'}</dd></dl></div>
      <div class="card"><h2 class="mb16">All register columns</h2>${c.attributes && Object.keys(c.attributes).length ? h`<dl class="kv">${Object.entries(c.attributes).map(([k, v]) => h`<dt>${k}</dt><dd>${v}</dd>`)}</dl>` : empty('Added manually: no original columns')}</div>
    </div>
    <div class="card flush"><div class="card-head"><h2>Inspection history</h2><span class="muted small">Linked findings stay attached even when the register changes</span></div>
      ${d.inspections.length ? h`<div class="table-wrap"><table class="table"><thead><tr><th>Assessment date</th><th>Report</th><th>Condition</th><th>Result</th><th>Match</th><th class="num">Page</th><th>Notes</th></tr></thead><tbody>
        ${d.inspections.map((f) => h`<tr class="clickable" data-href="#/inspections/${f.report_id}"><td>${fmtDate(f.assessment_date) || '—'}</td><td>${f.report_ref || f.file_name}</td><td class="nowrap">${condBadge(f.condition)}</td><td>${f.result || ''}</td><td>${matchTag(f.match_status)}</td>
          <td class="num">${pageList(f.condition_pages.length ? f.condition_pages : f.pages.slice(0, 1))}</td><td class="small"><div class="clamp2">${f.inspection_notes || ''}</div></td></tr>`)}</tbody></table></div>` : empty('No inspections linked yet')}</div>
    <div class="card flush"><div class="card-head"><h2>Version history</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>Version</th><th>Change</th><th>Description</th><th>Location</th><th>Status</th><th>Modified</th></tr></thead><tbody>
      ${d.history.map((x) => h`<tr class="clickable" data-href="#/registers/versions/${x.version_id}"><td>v${x.version_no} <span class="small muted">${x.version_status}</span></td><td>${statusTag(x.change_type, x.change_type === 'added' ? 'ok' : x.change_type === 'modified' ? 'warn' : '')}</td>
        <td class="small">${x.description}</td><td class="small">${x.location}</td><td class="small">${x.status}${x.is_archived ? ' (archived)' : ''}</td><td class="small nowrap">${fmtDateTime(x.last_modified_at)}</td></tr>`)}</tbody></table></div></div>`);
  el.addEventListener('click', async (e) => {
    const tr = e.target.closest('[data-href]'); if (tr) { location.hash = tr.dataset.href; return; }
    if (e.target.closest('#edit')) {
      const map = { description: c.description, category: c.category, location: c.location, locationDescription: c.location_description, status: c.status, site: c.site, criticality: c.criticality };
      const v = await formDialog({ title: 'Edit ' + a.asset_code, wide: true, fields: [...EDIT_FIELDS.map((f) => ({ ...f, value: map[f.name] })), { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, value: a.notes }] });
      if (!v) return;
      try { const r = await patch('/assets/' + a.id, v); toast(Object.keys(r.changes).length ? 'Asset updated.' : 'No changes.', 'ok'); navigate('#/assets/' + a.id); } catch (err) { toastError(err); }
    }
    if (e.target.closest('#archive')) {
      const v = await formDialog({ title: 'Archive ' + a.asset_code, submitLabel: 'Archive', intro: 'Archived assets are excluded from matching. Inspection history is kept and the asset can be restored.', fields: [{ name: 'reason', label: 'Reason', required: true }] });
      if (!v) return;
      try { await post(`/assets/${a.id}/archive`, v); toast('Asset archived.', 'ok'); navigate('#/assets/' + a.id); } catch (err) { toastError(err); }
    }
    if (e.target.closest('#restore')) {
      if (!(await confirmDialog('Restore this asset? It will be available for matching again.'))) return;
      try { await post(`/assets/${a.id}/restore`, {}); toast('Asset restored.', 'ok'); navigate('#/assets/' + a.id); } catch (err) { toastError(err); }
    }
  });
}

// Bulk import / update from Excel or CSV into the active version (matched by Asset ID).
async function bulkImport(navigate) {
  let st = null;
  const res = await modal({
    title: 'Bulk import / update assets', wide: true,
    body: h`<p class="muted">Upload a spreadsheet with an Asset ID column. Existing assets are updated with any non-blank values; new Asset IDs are added (import mode). For a full register replacement use the Register upload centre instead, which includes change review and approval.</p>
      <label class="dropzone" id="bdz">${icon('file')}<b>Choose a spreadsheet</b><input type="file" accept=".xlsx,.xls,.csv"></label>
      <div id="bmap" class="mt16"></div>
      <div class="field mt16"><label for="bmode">Mode</label><select class="input" id="bmode"><option value="upsert">Import: update existing and add new assets</option><option value="update">Update only: never add new assets</option></select></div>`,
    actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Run', value: 'run' }],
    onOpen: (root) => {
      wireDropzone($('#bdz', root), async (files) => {
        await loadScript('/vendor/xlsx/xlsx.full.min.js');
        const wb = window.XLSX.read(await files[0].arrayBuffer(), { type: 'array', cellDates: true });
        const aoa = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false, blankrows: false });
        const hr = detectHeaderRow(aoa);
        const headers = (aoa[hr] || []).map((x, i) => String(x || '').trim() || 'Column ' + (i + 1));
        st = { aoa, hr, headers, mapping: guessMapping(headers), root, name: files[0].name };
        $('#bmap', root).innerHTML = String(h`<p><b>${files[0].name}</b>: ${fmtInt(aoa.length - hr - 1)} rows. Check the column mapping:</p><div class="map-grid">${REGISTER_FIELDS.filter((f) => f.key !== 'parentAsset').map((f) => h`<div class="map-row"><label class="label">${f.label}</label><select class="input" data-bf="${f.key}"><option value="-1">— Not mapped —</option>${headers.map((x, i) => h`<option value="${i}" ${st.mapping[f.key] === i ? raw('selected') : ''}>${x}</option>`)}</select></div>`)}</div>`);
        $$('[data-bf]', root).forEach((s) => s.addEventListener('change', () => { const v = +s.value; if (v >= 0) st.mapping[s.dataset.bf] = v; else delete st.mapping[s.dataset.bf]; }));
      });
    },
    validate: () => (!st ? 'Choose a spreadsheet first.' : st.mapping.assetCode == null ? 'Map the Asset ID column.' : null)
  });
  if (res !== 'run' || !st) return;
  const mode = $('#bmode', st.root).value;
  const rows = st.aoa.slice(st.hr + 1).map((r) => {
    const o = {};
    Object.entries(st.mapping).forEach(([k, i]) => { o[k] = String(r[i] == null ? '' : r[i]).trim(); });
    return o;
  }).filter((o) => o.assetCode);
  const total = { added: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  busy.show('Updating assets…');
  try {
    for (let i = 0; i < rows.length; i += 1000) {
      busy.progress(i / rows.length, `Processing rows ${fmtInt(i + 1)}–${fmtInt(Math.min(rows.length, i + 1000))} of ${fmtInt(rows.length)}…`);
      const r = await post('/assets/bulk', { mode, rows: rows.slice(i, i + 1000) });
      ['added', 'updated', 'unchanged', 'skipped'].forEach((k) => { total[k] += r[k]; });
      total.errors.push(...r.errors.map((x) => ({ ...x, row: x.row + i })));
    }
    busy.hide();
    await modal({ title: 'Bulk update complete', body: h`<p>${fmtInt(total.added)} added · ${fmtInt(total.updated)} updated · ${fmtInt(total.unchanged)} unchanged · ${fmtInt(total.skipped)} skipped</p>${total.errors.length ? h`<div class="note">${total.errors.slice(0, 20).map((x) => h`<div>Row ${x.row}: ${x.error}</div>`)}</div>` : ''}` });
    navigate('#/assets');
  } catch (err) { busy.hide(); toastError(err); }
}
