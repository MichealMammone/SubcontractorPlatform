// Asset Register Hub: dashboard, upload centre (map -> validate -> compare -> review -> approve -> publish), versions, compare.
import { get, post, api, qs, download } from '../api.js';
import { h, raw, $, $$, toast, toastError, busy, modal, confirmDialog, fmtDate, fmtDateTime, fmtInt, ago, kpi, statusTag, empty, pager, loadScript, wireDropzone, icon, esc } from '../ui.js';
import { REGISTER_FIELDS, guessMapping, detectHeaderRow } from '/shared/register-fields.js';

const STATUS = { active: ['Active', 'ok'], archived: ['Archived', ''], pending_approval: ['Awaiting approval', 'warn'], staging: ['Upload incomplete', 'blue'], rejected: ['Rejected', 'bad'] };
const vTag = (s) => statusTag((STATUS[s] || [s])[0], (STATUS[s] || [])[1] || '');
const ISSUE = { missing_asset_id: 'Missing Asset ID', missing_description: 'Missing description', duplicate_asset_id: 'Duplicate Asset ID', asset_id_contains_spaces: 'Asset ID contains spaces', description_truncated: 'Description over 1,000 characters' };
const FIELD_LABEL = Object.fromEntries(REGISTER_FIELDS.map((f) => [f.key, f.label]));

/* ---------------- hub ---------------- */
export async function hub({ el, can }) {
  const d = await get('/registers/hub');
  const m = d.metrics;
  el.innerHTML = String(h`
    <div class="page-head"><div><h1>Asset Register Hub</h1><p>The master asset register is the single source of truth for every inspection, match and report. Upload a new confirmed register only when it changes: it is validated, compared, approved and then published, and the previous version is archived.</p></div>
      <div class="row">${can('registers.upload') ? h`<a class="btn btn-primary" href="#/registers/upload">${icon('upload')} Upload new register</a>` : ''}<a class="btn btn-secondary" href="#/assets">Manage assets</a><a class="btn btn-ghost" href="#/registers/versions">Version history</a><a class="btn btn-ghost" href="#/registers/compare">Compare versions</a></div></div>
    ${d.pending ? h`<div class="banner ${d.pending.status === 'staging' ? 'info' : 'warn'}"><span><b>Version ${d.pending.version_no} ${d.pending.status === 'staging' ? 'upload is incomplete' : 'is awaiting approval'}:</b> ${d.pending.source_filename} · uploaded ${ago(d.pending.uploaded_at)} by ${d.pending.uploaded_by_name || ''}${d.pending.change_summary ? h` · ${fmtInt(d.pending.change_summary.added)} added, ${fmtInt(d.pending.change_summary.modified)} modified, ${fmtInt(d.pending.change_summary.removed)} removed` : ''}</span><a class="btn btn-primary btn-sm" href="#/registers/versions/${d.pending.id}">Review changes</a></div>` : ''}
    ${!d.active ? h`<div class="card">${empty('No active register yet', 'Upload the confirmed master asset register. After validation and approval it becomes the active register used for all inspections.', can('registers.upload') ? h`<a class="btn btn-primary" href="#/registers/upload">Upload the master register</a>` : '')}</div>` : h`
    <div class="kpis">
      ${kpi('Total assets', m.totalAssets, 'In the active version')}
      ${kpi('Active assets', m.activeAssets, '', 'ok')}
      ${kpi('Archived assets', m.archivedAssets, 'Removed or archived', 'grey')}
      ${kpi('New assets added', m.newAssets, 'In the latest update', 'ok')}
      ${kpi('Modified assets', m.modifiedAssets, 'In the latest update', 'warn')}
      ${kpi('Removed assets', m.removedAssets, 'In the latest update', 'bad')}
      ${kpi('Last register update', fmtDate(m.lastUpdate), ago(m.lastUpdate), 'grey')}
      ${kpi('Active register version', 'v' + m.activeVersion, d.active.source_filename, '')}
    </div>`}
    <div class="card flush"><div class="card-head"><h2>Recent versions</h2><a class="small" href="#/registers/versions">All versions</a></div>${versionTable(d.versions)}</div>`);
  el.addEventListener('click', (e) => { const tr = e.target.closest('[data-href]'); if (tr) location.hash = tr.dataset.href; });
}

function versionTable(versions) {
  if (!versions.length) return empty('No versions yet');
  return h`<div class="table-wrap"><table class="table"><thead><tr><th>Version</th><th>Upload date</th><th>Uploaded by</th><th class="num">Asset count</th><th>Changes</th><th>Status</th><th>Notes</th></tr></thead><tbody>
    ${versions.map((v) => h`<tr class="clickable" data-href="#/registers/versions/${v.id}"><td class="cell-main">v${v.version_no}<div class="cell-sub">${v.source_filename}</div></td>
      <td>${fmtDateTime(v.uploaded_at)}</td><td>${v.uploaded_by_name || ''}${v.approved_by_name ? h`<div class="cell-sub">approved by ${v.approved_by_name}</div>` : ''}</td>
      <td class="num">${fmtInt(v.asset_count)}</td>
      <td class="small">${v.change_summary ? `+${fmtInt(v.change_summary.added)} / ~${fmtInt(v.change_summary.modified)} / −${fmtInt(v.change_summary.removed)}` : '—'}</td>
      <td>${vTag(v.status)}</td><td class="small"><div class="clamp2">${v.notes || ''}</div></td></tr>`)}</tbody></table></div>`;
}

export async function versions({ el, query }) {
  const page = +query.page || 1;
  const d = await get('/registers/versions' + qs({ page, status: query.status, pageSize: 25 }));
  el.innerHTML = String(h`<div class="crumbs"><a href="#/registers">Asset Register Hub</a> / Versions</div>
    <div class="page-head"><div><h1>Register version history</h1><p>Every published, archived and rejected register version. Open a version to view its changes, export it or restore it.</p></div><a class="btn btn-secondary" href="#/registers/compare">Compare versions</a></div>
    <div class="card flush">${versionTable(d.versions)}${pager(d.total, d.page, d.pageSize)}</div>`);
  el.addEventListener('click', (e) => {
    const tr = e.target.closest('[data-href]'); if (tr) location.hash = tr.dataset.href;
    const pg = e.target.closest('[data-page]'); if (pg) location.hash = '#/registers/versions' + qs({ ...query, page: pg.dataset.page });
  });
}

/* ---------------- upload centre ---------------- */
export async function upload({ el, navigate }) {
  const hint = (await get('/registers/mapping-hint')).previous;
  const st = { wb: null, file: null, sheet: null, aoa: null, headerRow: 0, headers: [], mapping: {} };
  el.innerHTML = String(h`<div class="crumbs"><a href="#/registers">Asset Register Hub</a> / Upload centre</div>
    <div class="page-head"><div><h1>Register upload centre</h1><p>Upload the confirmed asset register (Excel or CSV). It is validated and compared with the active register; nothing changes until it is approved and published.</p></div></div>
    <div class="steps"><div class="step current" data-s="1">1 · Upload</div><div class="step" data-s="2">2 · Map columns</div><div class="step">3 · Validate &amp; compare</div><div class="step">4 · Review changes</div><div class="step">5 · Approve &amp; publish</div></div>
    ${hint ? h`<div class="banner info"><span>Current active register: version ${hint.versionNo}, ${fmtInt(hint.assetCount)} assets. Column mapping is carried over automatically when the headings are unchanged.</span></div>` : ''}
    <div class="card" id="pick"><label class="dropzone" id="dz">${icon('file')}<b>Drop the asset register here, or click to browse</b><span class="muted small">.xlsx, .xls or .csv · the file is read in your browser and sent in batches</span><input type="file" accept=".xlsx,.xls,.xlsm,.csv,.txt"></label></div>
    <div id="mapCard"></div>`);

  wireDropzone($('#dz', el), async (files) => {
    const file = files[0];
    busy.show('Reading ' + file.name + '…');
    try {
      await loadScript('/vendor/xlsx/xlsx.full.min.js');
      const buf = await file.arrayBuffer();
      const XLSX = window.XLSX;
      if (/\.(csv|txt)$/i.test(file.name)) {
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
        st.wb = XLSX.read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
      } else st.wb = XLSX.read(buf, { type: 'array', cellDates: true });
      st.file = file;
      selectSheet(st.wb.SheetNames[0]);
      busy.hide();
    } catch (err) { busy.hide(); toastError(err); }
  });

  function selectSheet(name, headerRow) {
    st.sheet = name;
    st.aoa = window.XLSX.utils.sheet_to_json(st.wb.Sheets[name], { header: 1, defval: '', raw: false, blankrows: false, dateNF: 'dd/mm/yyyy' });
    st.headerRow = headerRow != null ? headerRow : detectHeaderRow(st.aoa);
    const row = st.aoa[st.headerRow] || [];
    let width = row.length;
    for (let i = st.headerRow + 1; i < Math.min(st.aoa.length, st.headerRow + 50); i++) width = Math.max(width, (st.aoa[i] || []).length);
    st.headers = Array.from({ length: width }, (v, i) => String(row[i] == null ? '' : row[i]).trim() || 'Column ' + (i + 1));
    st.mapping = guessMapping(st.headers, hint);
    renderMapping();
  }

  function renderMapping() {
    $$('.step', el).forEach((s) => { const n = +s.dataset.s; s.classList.toggle('done', n === 1); s.classList.toggle('current', n === 2); });
    const data = st.aoa.slice(st.headerRow + 1);
    const sample = (i) => { for (const r of data.slice(0, 8)) { const v = String(r[i] == null ? '' : r[i]).trim(); if (v) return v; } return ''; };
    $('#mapCard', el).innerHTML = String(h`<div class="card"><div class="card-head"><h2>Map columns · ${st.file.name}</h2>
        <div class="row"><label class="small muted">Sheet <select class="input" id="sheet" style="width:auto">${st.wb.SheetNames.map((n) => h`<option ${n === st.sheet ? raw('selected') : ''}>${n}</option>`)}</select></label>
        <label class="small muted">Header row <select class="input" id="hrow" style="width:auto">${st.aoa.slice(0, 20).map((r, i) => h`<option value="${i}" ${i === st.headerRow ? raw('selected') : ''}>Row ${i + 1}: ${r.filter(Boolean).slice(0, 3).join(' | ').slice(0, 50)}</option>`)}</select></label></div></div>
      <p class="muted">${fmtInt(data.length)} data rows found. Columns were mapped from their headings${hint ? ' and the current register' : ''}. Asset ID and Asset Description are required; every original column is kept with each asset.</p>
      <div class="map-grid">${REGISTER_FIELDS.map((f) => h`<div class="map-row"><label class="label" for="m_${f.key}">${f.label}${f.required ? h` <span class="req">*</span>` : ''}</label>
        <select class="input" id="m_${f.key}" data-field="${f.key}"><option value="-1">— Not mapped —</option>${st.headers.map((hd, i) => h`<option value="${i}" ${st.mapping[f.key] === i ? raw('selected') : ''}>${hd}</option>`)}</select>
        <div class="sample">${st.mapping[f.key] != null ? 'e.g. ' + sample(st.mapping[f.key]) : ''}</div></div>`)}</div>
      <div class="field mt16"><label for="notes">Notes for the approver (optional)</label><textarea class="input" id="notes" rows="2" placeholder="e.g. Quarterly register refresh from Maximo, includes new deluge valves"></textarea></div>
      <div class="form-error" id="mErr" hidden></div>
      <div class="row"><button class="btn btn-primary" id="go">Validate &amp; compare</button><span class="muted small">Nothing is published until an approver reviews the changes.</span></div></div>`);
    $('#sheet', el).addEventListener('change', (e) => selectSheet(e.target.value));
    $('#hrow', el).addEventListener('change', (e) => selectSheet(st.sheet, +e.target.value));
    $$('[data-field]', el).forEach((s) => s.addEventListener('change', () => { const v = +s.value; if (v >= 0) st.mapping[s.dataset.field] = v; else delete st.mapping[s.dataset.field]; s.parentElement.querySelector('.sample').textContent = v >= 0 ? 'e.g. ' + sample(v) : ''; }));
    $('#go', el).addEventListener('click', submit);
  }

  async function submit() {
    const missing = REGISTER_FIELDS.filter((f) => f.required && st.mapping[f.key] == null);
    if (missing.length) { $('#mErr', el).textContent = 'Map: ' + missing.map((f) => f.label).join(', '); $('#mErr', el).hidden = false; return; }
    const rows = st.aoa.slice(st.headerRow + 1);
    busy.show('Creating the upload…');
    let version = null;
    try {
      version = await post('/registers/staging', { fileName: st.file.name, sheetName: st.sheet, headerRow: st.headerRow, headers: st.headers, mapping: st.mapping, notes: $('#notes', el).value });
      const form = new FormData(); form.append('file', st.file);
      await api(`/registers/staging/${version.id}/file`, { method: 'POST', form }).catch(() => null); // original kept for audit (optional)
      const BATCH = 2000;
      for (let i = 0; i < rows.length; i += BATCH) {
        busy.progress(i / rows.length * 0.85, `Validating rows ${fmtInt(i + 1)}–${fmtInt(Math.min(rows.length, i + BATCH))} of ${fmtInt(rows.length)}…`);
        await post(`/registers/staging/${version.id}/rows`, { rows: rows.slice(i, i + BATCH).map((r) => r.map((c) => (c == null ? '' : String(c)))), startRow: i });
      }
      busy.progress(0.92, 'Comparing with the active register…');
      const res = await post(`/registers/staging/${version.id}/finalize`);
      busy.hide();
      toast(`Version ${version.version_no} ready for review: ${fmtInt(res.summary.added)} added, ${fmtInt(res.summary.modified)} modified, ${fmtInt(res.summary.removed)} removed.`, 'ok', 7000);
      navigate('#/registers/versions/' + version.id);
    } catch (err) {
      busy.hide(); toastError(err);
      if (version) toast('The incomplete upload can be discarded from its version page.', 'warn', 7000);
    }
  }
}

/* ---------------- version detail / change review ---------------- */
const TABS = [['added', 'Assets added'], ['modified', 'Assets updated'], ['removed', 'Assets removed'], ['description', 'Description changes'], ['id_changes', 'Possible Asset ID changes'], ['duplicates', 'Duplicates'], ['issues', 'Data integrity issues']];

function assetRow(a) {
  return h`<tr><td class="mono nowrap">${a.assetCode || h`<span class="tag bad">missing</span>`}</td><td>${a.description}</td><td class="small">${a.category}</td><td class="small">${a.location}</td><td class="small">${a.status}</td>
    <td>${(a.issues || []).map((i) => h`<span class="tag ${i === 'duplicate_asset_id' && !a.isPrimary ? 'bad' : 'warn'}">${ISSUE[i] || i}</span> `)}${a.isPrimary === false ? h`<span class="tag">excluded</span>` : ''}</td><td class="num small muted">${a.rowNo}</td></tr>`;
}
function diffBlock(x) {
  const fields = ['assetCode', 'description', 'category', 'location', 'locationDescription', 'status', 'site', 'criticality', 'parentAsset', 'altId'];
  const attrKeys = x.changed.filter((c) => c.startsWith('attr:')).map((c) => c.slice(5)).filter((k) => !Object.values(FIELD_LABEL).includes(k));
  const side = (a, cls) => h`<div class="${cls}"><dl>${fields.filter((f) => a[f] || x.changed.includes(f)).map((f) => h`<dt>${FIELD_LABEL[f] || f}</dt><dd><span class="${x.changed.includes(f) ? 'changed' : ''}">${a[f] || '—'}</span></dd>`)}
    ${attrKeys.slice(0, 8).map((k) => h`<dt>${k}</dt><dd><span class="changed">${(a.attributes || {})[k] || '—'}</span></dd>`)}</dl></div>`;
  return h`<div class="diff">${side(x.before, 'before')}${side(x.after, 'after')}</div>`;
}

export async function version({ el, params, can, navigate }) {
  const { version: v } = await get('/registers/versions/' + params.id);
  const s = v.change_summary || {};
  const counts = { added: s.added, modified: s.modified, removed: s.removed, description: s.descriptionChanged, id_changes: s.possibleIdChanges, duplicates: s.duplicates, issues: s.rowsWithIssues };
  const state = { tab: 'added', page: 1 };
  const reviewing = v.status === 'pending_approval';
  el.innerHTML = String(h`<div class="crumbs"><a href="#/registers">Asset Register Hub</a> / <a href="#/registers/versions">Versions</a> / v${v.version_no}</div>
    <div class="page-head"><div><h1>Register version ${v.version_no} ${vTag(v.status)}</h1>
      <p>${v.source_filename}${v.sheet_name ? ' (' + v.sheet_name + ')' : ''} · ${fmtInt(v.asset_count)} assets · uploaded ${fmtDateTime(v.uploaded_at)} by ${v.uploaded_by_name || ''}${v.approved_by_name ? ' · approved by ' + v.approved_by_name + ' ' + fmtDateTime(v.approved_at) : ''}${v.based_on_version_no ? ' · compared with v' + v.based_on_version_no : ''}</p></div>
      <div class="row">
        ${reviewing && can('registers.approve') ? h`<button class="btn btn-primary" id="approve">Approve &amp; publish</button><button class="btn btn-ghost" id="reject">Reject</button>` : ''}
        ${v.status === 'staging' && can('registers.upload') ? h`<button class="btn btn-danger" id="reject">Discard incomplete upload</button>` : ''}
        ${v.status === 'archived' && can('registers.rollback') ? h`<button class="btn btn-secondary" id="restore">Restore this version</button>` : ''}
        ${['active', 'archived'].includes(v.status) && can('registers.export') ? h`<button class="btn btn-secondary" data-exp="xlsx">Export Excel</button><button class="btn btn-ghost" data-exp="csv">Export CSV</button>` : ''}
        ${['active', 'archived'].includes(v.status) ? h`<a class="btn btn-ghost" href="#/registers/compare?to=${v.id}">Compare</a>` : ''}
      </div></div>
    ${v.status === 'rejected' ? h`<div class="banner bad"><span><b>Rejected</b> ${v.rejected_by_name ? 'by ' + v.rejected_by_name : ''} ${fmtDateTime(v.rejected_at)}${v.rejection_reason ? ': ' + v.rejection_reason : ''}</span></div>` : ''}
    ${v.status === 'staging' ? h`<div class="banner info"><span>This upload did not finish (${fmtInt(v.rows_received)} rows received). Discard it and upload the register again.</span></div>` : ''}
    ${reviewing ? h`<div class="banner warn"><span><b>Change review.</b> Check the changes below. Approving publishes this version as the active register and archives version ${v.based_on_version_no || '—'}. Duplicates and rows without an Asset ID are excluded.</span></div>` : ''}
    ${v.notes ? h`<div class="note info"><b>Notes:</b> ${v.notes}</div>` : ''}
    ${v.change_summary ? h`<div class="kpis">
      ${kpi('Assets added', s.added, '', 'ok')}${kpi('Assets updated', s.modified, fmtInt(s.descriptionChanged) + ' description changes', 'warn')}${kpi('Assets removed', s.removed, '', 'bad')}
      ${kpi('Total records changed', s.totalChanged, fmtInt(s.unchanged) + ' unchanged', '')}${kpi('Duplicates', s.duplicates, 'Excluded from the register', s.duplicates ? 'bad' : 'grey')}${kpi('Data integrity issues', s.rowsWithIssues, fmtInt(s.missingAssetId) + ' missing Asset ID', s.rowsWithIssues ? 'warn' : 'grey')}
    </div>
    <div class="card flush"><div class="toolbar"><div class="filter-chips" id="tabs" style="margin:0"></div></div><div id="items"></div></div>` : ''}`);

  const renderTabs = () => { const t = $('#tabs', el); if (t) t.innerHTML = String(TABS.map(([k, l]) => h`<button class="filter-chip ${state.tab === k ? 'active' : ''}" data-tab="${k}"><b>${fmtInt(counts[k] || 0)}</b>${l}</button>`).join('')); };
  async function loadItems() {
    if (!$('#items', el)) return;
    $('#items', el).innerHTML = '<div class="empty"><div class="spinner"></div></div>';
    const d = await get(`/registers/versions/${v.id}/changes` + qs({ type: state.tab, page: state.page, pageSize: 50 }));
    const total = counts[state.tab] || 0;
    $('#items', el).innerHTML = String(!d.items.length ? empty('Nothing in this category') : ['modified', 'description', 'id_changes'].includes(state.tab)
      ? h`<div style="padding:14px 18px"><div class="row small muted mb8"><span style="flex:1">Before (version ${v.based_on_version_no || '—'})</span><span style="flex:1">After (this upload)</span></div>${d.items.map(diffBlock)}</div>${pager(total, d.page, d.pageSize)}`
      : h`<div class="table-wrap"><table class="table"><thead><tr><th>Asset ID</th><th>Description</th><th>Category</th><th>Location</th><th>Status</th><th>Issues</th><th class="num">Row</th></tr></thead><tbody>${d.items.map(assetRow)}</tbody></table></div>${pager(total, d.page, d.pageSize)}`);
  }
  renderTabs(); await loadItems();

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]'); if (t) { state.tab = t.dataset.tab; state.page = 1; renderTabs(); loadItems(); return; }
    const pg = e.target.closest('#items [data-page]'); if (pg) { state.page = +pg.dataset.page; loadItems(); return; }
    const ex = e.target.closest('[data-exp]'); if (ex) { download(`/registers/versions/${v.id}/export?format=${ex.dataset.exp}`).then(() => toast('Export downloaded.', 'ok')).catch(toastError); return; }
    if (e.target.closest('#approve')) {
      const res = await modal({ title: `Approve and publish version ${v.version_no}?`, body: h`<p>${fmtInt(s.added)} added, ${fmtInt(s.modified)} updated and ${fmtInt(s.removed)} removed. Version ${v.based_on_version_no || '—'} will be archived (it can be restored later).</p><div class="field"><label for="an">Approval notes (optional)</label><textarea class="input" id="an" rows="2"></textarea></div>`,
        actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Approve & publish', value: 'ok' }], onOpen: (root) => { el._an = root; } });
      if (res !== 'ok') return;
      busy.show('Publishing the register…');
      try { await post(`/registers/versions/${v.id}/approve`, { notes: el._an ? $('#an', el._an).value : '' }); busy.hide(); toast(`Version ${v.version_no} is now the active register.`, 'ok'); navigate('#/registers'); }
      catch (err) { busy.hide(); toastError(err); }
    }
    if (e.target.closest('#reject')) {
      const res = await modal({ title: v.status === 'staging' ? 'Discard this upload?' : `Reject version ${v.version_no}?`, body: h`<div class="field"><label for="rr">Reason</label><textarea class="input" id="rr" rows="2"></textarea></div>`,
        actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: v.status === 'staging' ? 'Discard' : 'Reject', kind: 'danger', value: 'ok' }], onOpen: (root) => { el._rr = root; } });
      if (res !== 'ok') return;
      try { await post(`/registers/versions/${v.id}/reject`, { reason: el._rr ? $('#rr', el._rr).value : '' }); toast('Upload rejected. The active register is unchanged.', 'ok'); navigate('#/registers'); } catch (err) { toastError(err); }
    }
    if (e.target.closest('#restore')) {
      if (!(await confirmDialog(`Restore version ${v.version_no} as the active register? The current active version will be archived. Manual asset edits made after this version stay in the archived version.`, { confirmLabel: 'Restore version', danger: true }))) return;
      busy.show('Restoring…');
      try { await post(`/registers/versions/${v.id}/restore`, {}); busy.hide(); toast(`Version ${v.version_no} restored as the active register.`, 'ok'); navigate('#/registers'); } catch (err) { busy.hide(); toastError(err); }
    }
  });
}

/* ---------------- compare any two versions ---------------- */
export async function compare({ el, query }) {
  const all = (await get('/registers/versions?pageSize=200')).versions.filter((x) => ['active', 'archived'].includes(x.status));
  const to = query.to || (all[0] && all[0].id);
  const idx = all.findIndex((x) => x.id === to);
  const from = query.from || (all[idx + 1] && all[idx + 1].id);
  const opt = (sel) => all.map((x) => h`<option value="${x.id}" ${x.id === sel ? raw('selected') : ''}>v${x.version_no} · ${fmtDate(x.published_at || x.uploaded_at)} · ${fmtInt(x.asset_count)} assets${x.status === 'active' ? ' (active)' : ''}</option>`);
  el.innerHTML = String(h`<div class="crumbs"><a href="#/registers">Asset Register Hub</a> / Compare</div>
    <div class="page-head"><div><h1>Compare register versions</h1><p>Side-by-side differences between any two published versions.</p></div></div>
    <form class="card row" id="cmp"><label class="small muted">From <select class="input" name="from" style="width:auto">${opt(from)}</select></label><label class="small muted">To <select class="input" name="to" style="width:auto">${opt(to)}</select></label><button class="btn btn-primary btn-sm">Compare</button></form>
    <div id="out"></div>`);
  $('#cmp', el).addEventListener('submit', (e) => { e.preventDefault(); const f = new FormData(e.target); location.hash = '#/registers/compare' + qs({ from: f.get('from'), to: f.get('to') }); });
  if (!from || !to || from === to) { $('#out', el).innerHTML = String(empty('Choose two different versions')); return; }
  const state = { type: 'added', page: 1 };
  const base = await get('/registers/compare' + qs({ from, to }));
  const c = base.counts;
  const counts = { added: c.added, modified: c.modified, removed: c.removed, description: c.descriptionChanged, id_changes: c.possibleIdChanges };
  $('#out', el).innerHTML = String(h`<div class="kpis">${kpi('Added', c.added, '', 'ok')}${kpi('Updated', c.modified, '', 'warn')}${kpi('Removed', c.removed, '', 'bad')}${kpi('Unchanged', c.unchanged, '', 'grey')}${kpi('Possible ID changes', c.possibleIdChanges, '', 'grey')}</div>
    <div class="card flush"><div class="toolbar"><div class="filter-chips" id="tabs" style="margin:0">${TABS.slice(0, 5).map(([k, l]) => h`<button class="filter-chip" data-tab="${k}"><b>${fmtInt(counts[k] || 0)}</b>${l}</button>`)}</div></div><div id="items"></div></div>`);
  async function load() {
    $$('#tabs [data-tab]', el).forEach((b) => b.classList.toggle('active', b.dataset.tab === state.type));
    const d = await get('/registers/compare' + qs({ from, to, type: state.type, page: state.page, pageSize: 50 }));
    $('#items', el).innerHTML = String(!d.items.length ? empty('No differences in this category') : ['modified', 'description', 'id_changes'].includes(state.type)
      ? h`<div style="padding:14px 18px">${d.items.map(diffBlock)}</div>${pager(counts[state.type], d.page, d.pageSize)}`
      : h`<div class="table-wrap"><table class="table"><thead><tr><th>Asset ID</th><th>Description</th><th>Category</th><th>Location</th><th>Status</th><th></th><th class="num">Row</th></tr></thead><tbody>${d.items.map(assetRow)}</tbody></table></div>${pager(counts[state.type], d.page, d.pageSize)}`);
  }
  await load();
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]'); if (t) { state.type = t.dataset.tab; state.page = 1; load(); }
    const pg = e.target.closest('#items [data-page]'); if (pg) { state.page = +pg.dataset.page; load(); }
  });
}
