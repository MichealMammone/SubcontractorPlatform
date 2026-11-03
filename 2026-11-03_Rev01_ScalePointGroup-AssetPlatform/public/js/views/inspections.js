// Inspections: history, upload (browser extraction + server matching), review with drill-down and corrections.
import { get, post, patch, api, qs, download } from '../api.js';
import {
  h, raw, $, $$, toast, toastError, busy, modal, formDialog, confirmDialog, drawer, debounce, fmtDate, fmtDateTime, ago, fmtInt,
  condBadge, matchTag, confBar, statusTag, empty, pager, chips, wireDropzone, icon, kpi
} from '../ui.js';
import { readPdfPages } from '../pdf.js';
import { interpretPages, buildFindings, pageList } from '/shared/report-parser.js';

const thresholds = (session) => (session.settings && session.settings.matching && session.settings.matching.thresholds) || { match: 95, likely: 80, review: 60 };

/* ---------------- history ---------------- */
export async function list({ el, query, can }) {
  const page = +query.page || 1;
  const data = await get('/inspections' + qs({ q: query.q, from: query.from, to: query.to, status: query.status, page, pageSize: 25 }));
  el.innerHTML = String(h`
    <div class="page-head"><div><h1>Inspections</h1><p>Every uploaded inspection report, the register version it was matched against, and its review status.</p></div>
      ${can('inspections.upload') ? h`<a class="btn btn-primary" href="#/inspections/new">${icon('upload')} Upload inspection report</a>` : ''}</div>
    <div class="card flush">
      <form class="toolbar" id="filters">
        <input class="input" type="search" name="q" placeholder="Search file name, report reference or site" value="${query.q || ''}">
        <label class="small muted">From <input class="input" type="date" name="from" value="${query.from || ''}"></label>
        <label class="small muted">To <input class="input" type="date" name="to" value="${query.to || ''}"></label>
        <select class="input" name="status"><option value="">All statuses</option>${['processed', 'processing', 'failed'].map((s) => h`<option ${query.status === s ? raw('selected') : ''}>${s}</option>`)}</select>
        <button class="btn btn-secondary btn-sm">Apply</button>
      </form>
      ${data.inspections.length ? h`<div class="table-wrap"><table class="table"><thead><tr><th>Report</th><th>Assessment date</th><th>Uploaded</th><th class="num">Assets</th><th class="num">Matched</th><th class="num">Review</th><th class="num">Not in register</th><th>Register</th><th>Status</th></tr></thead><tbody>
        ${data.inspections.map((r) => h`<tr class="clickable" data-href="#/inspections/${r.id}">
          <td><div class="cell-main">${r.report_ref || r.file_name}</div><div class="cell-sub">${r.file_name} · ${r.page_count} pages${r.generated_count ? ' · ' + r.generated_count + ' report(s)' : ''}</div></td>
          <td>${fmtDate(r.assessment_date) || h`<span class="tag warn">Not found</span>`}</td>
          <td><div>${fmtDateTime(r.uploaded_at)}</div><div class="cell-sub">${r.uploaded_by_name || ''}</div></td>
          <td class="num">${r.finding_count}</td><td class="num">${r.matched_count}</td>
          <td class="num">${r.review_count ? statusTag(r.review_count, 'warn') : '0'}</td><td class="num">${r.unmatched_count ? statusTag(r.unmatched_count, 'bad') : '0'}</td>
          <td>${r.version_no ? 'v' + r.version_no : '—'}</td>
          <td>${r.status === 'processed' ? statusTag('Processed', 'ok') : r.status === 'failed' ? statusTag('Failed', 'bad') : statusTag('Processing', 'blue')}</td></tr>`)}
      </tbody></table></div>${pager(data.total, data.page, data.pageSize)}` : empty('No inspections found', query.q ? 'Try a different search.' : 'Upload the first inspection report to get started.')}
    </div>`);
  $('#filters', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    location.hash = '#/inspections' + qs({ q: f.get('q'), from: f.get('from'), to: f.get('to'), status: f.get('status') });
  });
  el.addEventListener('click', (e) => {
    const tr = e.target.closest('[data-href]'); if (tr) location.hash = tr.dataset.href;
    const pg = e.target.closest('[data-page]'); if (pg) location.hash = '#/inspections' + qs({ ...query, page: pg.dataset.page });
  });
}

/* ---------------- upload ---------------- */
export async function upload({ el, session, navigate }) {
  const hub = await get('/registers/hub').catch(() => ({ active: null }));
  const merge = session.settings ? session.settings.reports.mergeDuplicates !== false : true;
  el.innerHTML = String(h`
    <div class="crumbs"><a href="#/inspections">Inspections</a> / Upload</div>
    <div class="page-head"><div><h1>Upload inspection report</h1><p>Upload the subcontractor maintenance / inspection report (PDF). Assets are identified, matched to the Asset Register Hub and the assessment date is read from the report automatically.</p></div></div>
    ${hub.active ? h`<div class="banner info"><span><b>Matching against:</b> ${hub.register ? hub.register.name : 'Master register'} · version ${hub.active.version_no} · ${fmtInt(hub.active.asset_count)} assets · published ${fmtDate(hub.active.published_at)}</span></div>`
      : h`<div class="banner bad"><span><b>No active asset register.</b> A Super Admin must upload and publish the master register before reports can be processed.</span></div>`}
    <div class="card">
      <label class="dropzone" id="dz">${icon('file')}<b>Drop the inspection report PDF here, or click to browse</b><span class="muted small">The PDF is read in your browser; the original is stored securely with the results.</span>
        <input type="file" accept="application/pdf,.pdf" ${hub.active ? '' : raw('disabled')}></label>
      <label class="check mt16"><input type="checkbox" id="merge" ${merge ? raw('checked') : ''}> <span>Combine repeat entries of the same asset (e.g. quarterly and annual sections). The worst result and worst condition are kept.</span></label>
    </div>
    <div id="result"></div>`);
  if (!hub.active) return;
  wireDropzone($('#dz', el), async (files) => {
    const file = files[0];
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return toast('Choose a PDF file.', 'warn');
    busy.show('Opening ' + file.name + '…');
    try {
      const pages = await readPdfPages(file, (n, total) => busy.progress(n / total * 0.7, `Reading page ${n} of ${total}…`));
      busy.progress(0.75, 'Identifying assets…');
      const parsed = interpretPages(pages, file.name);
      const findings = buildFindings(parsed.records, $('#merge').checked);
      if (!findings.length) { busy.hide(); return renderProblem(parsed); }
      busy.progress(0.85, `Matching ${findings.length} assets against the register…`);
      const form = new FormData();
      form.append('payload', JSON.stringify({ meta: parsed.meta, warnings: parsed.warnings, pageCount: parsed.pageCount, mergeDuplicates: $('#merge').checked, findings }));
      form.append('file', file);
      const r = await api('/inspections', { method: 'POST', form });
      busy.hide();
      if (r.duplicateOf) toast('Note: this exact file was uploaded before. A new inspection record has been created.', 'warn', 7000);
      if (parsed.warnings.length) toast(parsed.warnings.join(' '), 'warn', 8000);
      toast('Report processed.', 'ok');
      navigate('#/inspections/' + r.id);
    } catch (err) { busy.hide(); toastError(err); }
  });
  function renderProblem(parsed) {
    $('#result', el).innerHTML = String(h`<div class="card"><h2>No assets were found</h2><p>${parsed.warnings.join(' ')}</p>
      <p class="muted">If the PDF is a scanned image, ask the subcontractor for a text-based PDF. Otherwise send the file to your administrator so the layout can be added.</p>
      <details><summary class="small">Show extracted text (first 200 lines)</summary><pre class="small mono" style="white-space:pre-wrap">${parsed.textLines.slice(0, 200).join('\n')}</pre></details></div>`);
  }
}

/* ---------------- detail & review ---------------- */
export async function detail({ el, params, query, can, session, navigate, isCurrent }) {
  const id = params.id;
  const T = thresholds(session);
  const state = { status: query.status || 'all', q: '', page: 1 };
  const d = await get('/inspections/' + id);
  const r = d.inspection;

  const head = () => h`
    <div class="crumbs"><a href="#/inspections">Inspections</a> / ${r.report_ref || r.file_name}</div>
    <div class="page-head"><div><h1>${r.report_ref || r.file_name}</h1>
      <p>${r.site ? r.site + ' · ' : ''}${r.file_name} · ${r.page_count} pages · uploaded ${fmtDateTime(r.uploaded_at)} by ${r.uploaded_by_name || 'unknown'} · matched against register v${r.version_no || '?'}</p></div>
      <div class="row">
        ${can('reports.generate') && r.status === 'processed' ? h`<button class="btn btn-primary" id="gen">${icon('report')} Generate report</button>` : ''}
        ${can('inspections.review') ? h`<button class="btn btn-secondary" id="rematch">Re-match</button>` : ''}
        ${r.file_id ? h`<button class="btn btn-ghost" id="orig">Download original</button>` : ''}
      </div></div>
    ${r.status === 'failed' ? h`<div class="banner bad"><span><b>Processing failed:</b> ${r.error || 'unknown error'}</span></div>` : ''}
    <div class="kpis">
      ${kpi('Assessment date', r.assessment_date ? fmtDate(r.assessment_date) : 'Not found', { report: 'Read from the report', first_date: 'First date in the report – check it', manual: 'Entered manually', not_found: 'Not stated in the report' }[r.assessment_date_source] || '', r.assessment_date && r.assessment_date_source === 'report' ? '' : 'warn')}
      ${kpi('Assets in report', r.finding_count)}
      ${kpi('Matched', r.matched_count, r.finding_count ? Math.round(r.matched_count / r.finding_count * 100) + '%' : '', 'ok')}
      ${kpi('Flagged for review', r.review_count, 'Confidence below auto-accept', r.review_count ? 'warn' : 'grey')}
      ${kpi('Not in register', r.unmatched_count, '', r.unmatched_count ? 'bad' : 'grey')}
    </div>
    ${r.warnings && r.warnings.length ? h`<div class="note">${r.warnings.join(' ')}</div>` : ''}
    ${can('inspections.review') && r.assessment_date_source !== 'report' ? h`<div class="banner warn"><span>${r.assessment_date ? 'The assessment date was taken from the first date in the report. Check it is correct.' : 'The report does not state an assessment date.'}</span><span class="row"><input class="input" type="date" id="adate" value="${r.assessment_date || ''}" style="width:170px"><button class="btn btn-primary btn-sm" id="saveDate">Save date</button></span></div>` : ''}`;

  el.innerHTML = String(h`<div id="head">${head()}</div>
    <div class="card flush">
      <div class="toolbar"><div class="filter-chips" id="chips" style="margin:0"></div><span class="grow"></span><input class="input" type="search" id="fq" placeholder="Search assets"></div>
      <div id="findings"><div class="empty"><div class="spinner"></div></div></div>
    </div>
    <div class="grid-2">
      <div class="card flush"><div class="card-head"><h2>Generated reports</h2></div><div id="genList"></div></div>
      <div class="card flush"><div class="card-head"><h2>Processing history</h2></div>
        <div class="table-wrap" style="max-height:320px"><table class="table"><tbody>${d.history.map((x) => h`<tr><td class="small nowrap">${fmtDateTime(x.created_at)}</td><td class="small">${x.summary}<div class="cell-sub">${x.user_email}</div></td></tr>`)}</tbody></table></div></div>
    </div>`);

  const renderGen = (reports) => {
    $('#genList', el).innerHTML = String(reports.length ? h`<table class="table"><tbody>${reports.map((g) => h`<tr class="clickable" data-href="#/reports/${g.id}"><td><div class="cell-main">${g.name}</div><div class="cell-sub">${g.generated_by_name || ''} · ${fmtDateTime(g.generated_at)}</div></td><td>${g.status === 'approved' ? statusTag('Approved', 'ok') : statusTag('Draft', 'warn')}</td></tr>`)}</tbody></table>` : empty('No reports generated yet', can('reports.generate') ? 'Use "Generate report" to produce the client register.' : ''));
  };
  renderGen(d.reports);

  const counts = { all: r.finding_count, matched: r.matched_count, review: r.review_count, unmatched: r.unmatched_count };
  const renderChips = () => {
    $('#chips', el).innerHTML = String([['all', 'All assets', ''], ['matched', 'Matched', ''], ['review', 'Flagged for review', 'warn'], ['unmatched', 'Not in register', 'bad']]
      .map(([k, label, tone]) => h`<button class="filter-chip ${tone} ${state.status === k ? 'active' : ''}" data-status="${k}"><b>${fmtInt(counts[k])}</b>${label}</button>`).join(''));
  };
  renderChips();

  let rows = [];
  async function load() {
    const res = await get(`/inspections/${id}/findings` + qs({ status: state.status === 'all' ? '' : state.status, q: state.q, page: state.page, pageSize: 100 }));
    if (!isCurrent()) return;
    rows = res.findings;
    $('#findings', el).innerHTML = String(rows.length ? h`<div class="table-wrap"><table class="table"><thead><tr><th class="num">#</th><th>Asset in report</th><th>Register asset</th><th>Confidence</th><th>Status</th><th>Condition</th><th class="num">Page</th><th></th></tr></thead><tbody>
      ${rows.map((f) => {
        const accepted = ['match', 'likely', 'confirmed', 'manual'].includes(f.match_status);
        const prop = !accepted && f.match_status === 'review' && f.candidates[0];
        return h`<tr class="clickable" data-fid="${f.id}"><td class="num muted">${f.seq}</td>
          <td><div class="cell-main">${f.report_asset_text}</div><div class="cell-sub">${f.sub_location || ''}</div></td>
          <td>${accepted ? h`<div class="cell-main mono">${f.asset_code_snapshot}</div><div class="cell-sub clamp2">${f.asset_description_snapshot}</div>`
            : prop ? h`<div class="cell-main mono" style="color:var(--warn)">${prop.assetCode} <span class="small">(proposed)</span></div><div class="cell-sub clamp2">${prop.description}</div>`
            : h`<span class="muted small">${f.match_status === 'rejected' ? 'Confirmed not in register' : 'No match found'}</span>`}</td>
          <td>${confBar(f.confidence == null ? null : Number(f.confidence), T)}</td><td>${matchTag(f.match_status)}</td><td class="nowrap">${condBadge(f.condition)}</td>
          <td class="num">${pageList(f.condition_pages.length ? f.condition_pages : f.pages.slice(0, 1))}</td>
          <td class="nowrap">${can('inspections.review') && (f.match_status === 'review' || f.match_status === 'likely') ? h`<button class="icon-btn" data-act="confirm" title="Confirm proposed match">✓</button>` : ''}
            ${can('inspections.review') && !['rejected'].includes(f.match_status) ? h`<button class="icon-btn" data-act="reject" title="Not in register">✕</button>` : ''}<button class="icon-btn" title="Details">›</button></td></tr>`;
      })}</tbody></table></div>${pager(res.total, res.page, res.pageSize)}` : empty('No assets in this view'));
  }
  await load();

  async function refreshHead() {
    const x = await get('/inspections/' + id);
    Object.assign(r, x.inspection);
    Object.assign(counts, { all: r.finding_count, matched: r.matched_count, review: r.review_count, unmatched: r.unmatched_count });
    $('#head', el).innerHTML = String(head());
    renderChips(); renderGen(x.reports); bindHead();
  }
  async function correct(fid, body) {
    try { await patch('/inspections/findings/' + fid, body); toast('Updated.', 'ok'); await Promise.all([load(), refreshHead()]); }
    catch (err) { toastError(err); }
  }

  function bindHead() {
    const gen = $('#gen', el);
    if (gen) gen.addEventListener('click', async () => {
      const rs = (session.settings && session.settings.reports) || {};
      const v = await formDialog({
        title: 'Generate inspection register', submitLabel: 'Generate',
        intro: r.review_count ? `${r.review_count} item(s) are still flagged for review. They will be listed in a "flagged for review" section of the report.` : 'All assets are matched.',
        fields: [{ name: 'title', label: 'Document title', value: rs.defaultTitle || 'Asset Condition Inspection Register', required: true },
          { name: 'preparedFor', label: 'Prepared for', placeholder: 'Client name' }, { name: 'preparedBy', label: 'Prepared by', value: rs.defaultPreparedBy || 'Scale Point Group' }]
      });
      if (!v) return;
      try { const g = await post(`/inspections/${id}/reports`, v); toast(g.status === 'approved' ? 'Report generated.' : 'Report generated as a draft; an administrator must approve it.', 'ok'); navigate('#/reports/' + g.id); }
      catch (err) { toastError(err); }
    });
    const rm = $('#rematch', el);
    if (rm) rm.addEventListener('click', async () => {
      if (!(await confirmDialog('Re-run automatic matching against the current active register? Reviewer decisions are kept and re-linked by Asset ID.'))) return;
      busy.show('Re-matching…');
      try { const o = await post(`/inspections/${id}/rematch`); busy.hide(); toast(`Re-matched against register v${o.versionNo}: ${o.relinked} decisions kept${o.lost ? ', ' + o.lost + ' need review' : ''}.`, 'ok'); await Promise.all([load(), refreshHead()]); }
      catch (err) { busy.hide(); toastError(err); }
    });
    const og = $('#orig', el);
    if (og) og.addEventListener('click', () => download(`/inspections/${id}/file`, r.file_name).catch(toastError));
    const sd = $('#saveDate', el);
    if (sd) sd.addEventListener('click', async () => {
      try { await patch('/inspections/' + id, { assessmentDate: $('#adate', el).value }); toast('Assessment date saved.', 'ok'); await refreshHead(); } catch (err) { toastError(err); }
    });
  }
  bindHead();

  $('#chips', el).addEventListener('click', (e) => { const b = e.target.closest('[data-status]'); if (!b) return; state.status = b.dataset.status; state.page = 1; renderChips(); load(); });
  $('#fq', el).addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); state.page = 1; load(); }, 300));
  el.addEventListener('click', (e) => {
    const g = e.target.closest('[data-href]'); if (g) { location.hash = g.dataset.href; return; }
    const pg = e.target.closest('#findings [data-page]'); if (pg) { state.page = +pg.dataset.page; load(); return; }
    const tr = e.target.closest('tr[data-fid]');
    if (!tr) return;
    const f = rows.find((x) => String(x.id) === tr.dataset.fid);
    const act = e.target.closest('[data-act]');
    if (act) { e.stopPropagation(); correct(f.id, { action: act.dataset.act }); return; }
    openFinding(f);
  });

  function breakdown(c) {
    const b = c && c.b;
    if (!b) return '';
    const row = (label, pts, max, detail) => h`<div class="bd"><div class="bd-head"><span>${label}</span><span class="muted">${pts.toFixed(1)} / ${Math.round(max * 10) / 10}</span></div><div class="progress mt8"><span style="width:${max ? Math.min(100, pts / max * 100) : 0}%"></span></div><div class="small muted mt8">${detail}</div></div>`;
    return h`${b.id.kind ? h`<div class="note info">Exact identifier match on <code>${b.id.value}</code>.</div>` : ''}
      ${row('Description', b.desc.points, b.desc.max, h`${Math.round(b.desc.sim * 100)}% similar · shared ${chips(b.desc.common, 'ok')}`)}
      ${row('Zone', b.zone.points, b.zone.max, h`report ${chips(b.zone.pdf.map((z) => 'Z' + z))} register ${chips(b.zone.reg.map((z) => 'Z' + z))} (${b.zone.state})`)}
      ${row('Location / carriageway', b.loc.points, b.loc.max, h`direction ${chips(b.loc.pdfDir)} vs ${chips(b.loc.regDir)} (${b.loc.dirState}) · shared ${chips(b.loc.common, 'ok')}`)}
      ${row('Keywords', b.kw.points, b.kw.max, h`shared ${chips(b.kw.common, 'ok')}`)}
      ${b.penalties.map((p) => h`<div class="small" style="color:var(--bad)">−${p.points} points: ${p.reason}</div>`)}`;
  }

  function openFinding(f) {
    const dr = drawer({ title: f.report_asset_text, kicker: `Item ${f.seq} · ${r.report_ref || r.file_name}` });
    const accepted = ['match', 'likely', 'confirmed', 'manual'].includes(f.match_status);
    const cur = accepted ? f.candidates.find((c) => c.assetVersionId === f.matched_asset_version_id) : f.candidates[0];
    dr.body.innerHTML = String(h`
      <div class="row mb16">${matchTag(f.match_status)} ${condBadge(f.condition)} ${f.result ? statusTag(f.result, f.result === 'FAIL' ? 'bad' : f.result === 'PASS' ? 'ok' : '') : ''}</div>
      <div class="section"><div class="compare">
        <div><h4>In the inspection report</h4><div class="cell-main mb8">${f.report_asset_text}</div><dl class="kv">
          ${f.sub_location ? h`<dt>Location</dt><dd>${f.sub_location}</dd>` : ''}<dt>Page(s)</dt><dd>${pageList(f.pages)}</dd>
          <dt>Rating page</dt><dd>${pageList(f.condition_pages) || '—'}</dd>${f.sections.length ? h`<dt>Section</dt><dd>${f.sections.join('; ')}</dd>` : ''}</dl></div>
        <div><h4>${accepted ? 'Matched register asset' : f.match_status === 'review' ? 'Proposed register asset' : 'Register'}</h4>
          ${cur && f.match_status !== 'rejected' && f.match_status !== 'nomatch' ? h`<div class="cell-main mono">${cur.assetCode}</div><div class="mb8">${cur.description}</div><dl class="kv"><dt>Location</dt><dd>${cur.location || '—'}</dd><dt>Status</dt><dd>${cur.status || '—'}</dd></dl>`
            : h`<div class="muted">${f.match_status === 'rejected' ? 'Confirmed as not in the register.' : 'No register asset reached the review threshold.'}</div>`}</div>
      </div></div>
      <div class="section"><h3>Why</h3><p>${f.match_explanation}</p>${cur ? breakdown(cur) : ''}${f.reviewed_by_name ? h`<p class="small muted mt8">Reviewed by ${f.reviewed_by_name} ${ago(f.reviewed_at)}${f.review_note ? ': ' + f.review_note : ''}</p>` : ''}</div>
      <div class="section"><h3>Inspection notes</h3><p>${f.inspection_notes || 'None recorded.'}</p><p class="small muted">${f.findings_summary}</p>
        ${f.checks.length ? h`<details><summary class="small">${f.checks.length} checks</summary><table class="table"><tbody>${f.checks.map((c) => h`<tr><td class="mono small">${c.code}</td><td class="small">${c.title}</td><td>${c.result ? statusTag(c.result, c.result === 'F' ? 'bad' : c.result === 'P' ? 'ok' : '') : ''}</td></tr>`)}</tbody></table></details>` : ''}</div>
      <div class="section"><h3>Candidates</h3>${f.candidates.length ? f.candidates.map((c) => h`<div class="cand ${cur && c.assetVersionId === cur.assetVersionId && accepted ? 'current' : ''}"><b class="num">${Math.round(c.score)}%</b><div><div class="cell-main mono">${c.assetCode}</div><div class="cell-sub">${c.description}${c.location ? ' · ' + c.location : ''}</div></div>
        ${can('inspections.review') ? h`<button class="btn btn-secondary btn-sm" data-assign="${c.assetVersionId}">Use this</button>` : ''}</div>`) : h`<p class="muted">No candidates.</p>`}</div>
      ${can('inspections.review') ? h`<div class="section"><h3>Find another asset</h3><input class="input" id="as" type="search" placeholder="Search the register by Asset ID, description or location"><div id="asr" class="mt8"></div>
        <div class="field mt16"><label for="note">Review note (optional, kept in the audit trail)</label><input class="input" id="note" maxlength="1000"></div></div>` : ''}`);
    if (can('inspections.review')) {
      dr.foot.hidden = false;
      dr.foot.innerHTML = String(h`${cur && !['confirmed', 'manual', 'rejected', 'nomatch'].includes(f.match_status) ? h`<button class="btn btn-primary" data-a="confirm">Confirm match</button>` : ''}
        ${f.match_status !== 'rejected' ? h`<button class="btn btn-secondary" data-a="reject">Not in register</button>` : ''}
        ${['confirmed', 'manual', 'rejected'].includes(f.match_status) ? h`<button class="btn btn-ghost" data-a="reset">Reset to automatic</button>` : ''}`);
      const note = () => ($('#note', dr.body) ? $('#note', dr.body).value : '');
      dr.foot.addEventListener('click', async (e) => { const b = e.target.closest('[data-a]'); if (!b) return; dr.close(); await correct(f.id, { action: b.dataset.a, note: note() }); });
      dr.body.addEventListener('click', async (e) => { const b = e.target.closest('[data-assign]'); if (!b) return; dr.close(); await correct(f.id, { action: 'assign', assetVersionId: +b.dataset.assign, note: note() }); });
      $('#as', dr.body).addEventListener('input', debounce(async (e) => {
        const q = e.target.value.trim();
        if (q.length < 2) { $('#asr', dr.body).innerHTML = ''; return; }
        const res = await get(`/inspections/${id}/asset-search` + qs({ q }));
        $('#asr', dr.body).innerHTML = String(res.assets.length ? res.assets.map((a) => h`<div class="cand"><span></span><div><div class="cell-main mono">${a.asset_code}</div><div class="cell-sub">${a.description}${a.location ? ' · ' + a.location : ''}</div></div><button class="btn btn-secondary btn-sm" data-assign="${a.id}">Assign</button></div>`) : h`<p class="muted small">No assets found.</p>`);
      }, 300));
    }
  }
}
