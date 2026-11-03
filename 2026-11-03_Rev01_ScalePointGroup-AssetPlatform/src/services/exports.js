// Branded Excel / CSV / PDF output for generated inspection registers, plus generic table exports.
import { createRequire } from 'node:module';
import { COND_LABELS } from '../../shared/engine.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const autoTable = autoTableModule.autoTable || autoTableModule.default || autoTableModule;

const BLUE = [29, 95, 209];
const CHARCOAL = [34, 39, 46];
const GREY = [96, 104, 114];
const LINE = [222, 226, 232];
const COND_FILL = {
  1: { fill: [36, 161, 72], text: [255, 255, 255] }, 2: { fill: [111, 220, 140], text: [22, 22, 22] }, 3: { fill: [241, 194, 27], text: [22, 22, 22] },
  4: { fill: [255, 131, 43], text: [22, 22, 22] }, 5: { fill: [218, 30, 40], text: [255, 255, 255] }
};

/* ---------- CSV ---------- */
export function csvCell(v) {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-(?!\d)/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const csvLine = (cells) => cells.map(csvCell).join(',') + '\r\n';
export function toCsv(headers, rows) { return '﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

/* ---------- XLSX ---------- */
// sheets: [{ name, aoa, headerRow, noFilter }]
export function toXlsx(sheets) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa, { dateNF: 'dd/mm/yyyy' });
    const hr = s.headerRow || 0;
    const width = Math.max(1, ...s.aoa.map((r) => r.length));
    const cols = [];
    for (let i = 0; i < width; i++) {
      let w = 6;
      for (let r = hr; r < Math.min(s.aoa.length, hr + 300); r++) {
        const v = (s.aoa[r] || [])[i];
        w = Math.max(w, v instanceof Date ? 10 : String(v == null ? '' : v).length);
      }
      cols.push({ wch: Math.min(60, Math.max(8, w + 2)) });
    }
    ws['!cols'] = cols;
    if (!s.noFilter && s.aoa.length > hr) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: hr, c: 0 }, e: { r: s.aoa.length - 1, c: width - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

const isoToDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : null; };
const pageCell = (p) => (/^\d+$/.test(p) ? Number(p) : p);

const REGISTER_HEADERS = ['Item', 'Asset ID', 'Asset Description', 'Asset Condition', 'Condition Description', 'Assessment Date', 'Inspection Notes',
  'Page Number Found', 'Match Confidence %', 'Report Reference', 'Status', 'Description in Report', 'Inspection Findings', 'Matching Notes'];

function registerLine(snap, r, dateCell) {
  return [r.item, r.assetId, r.assetDescription, r.condition == null ? '' : r.condition, r.condition == null ? 'Not rated' : (COND_LABELS[r.condition] || ''),
    dateCell, r.inspectionNotes, pageCell(r.page), r.confidence == null ? '' : r.confidence, snap.reportRef, r.statusText, r.reportDescription, r.findings, r.reason];
}

export function reportXlsx(report) {
  const snap = report.snapshot;
  const c = snap.counts;
  const date = isoToDate(snap.assessmentDate) || 'Not stated';
  const info = [
    ['SCALE POINT GROUP'], [snap.title], [],
    ['Report reference', snap.reportRef || ''], ['Assessment date', date], ...(snap.site ? [['Site', snap.site]] : []),
    ['Prepared for', snap.preparedFor || ''], ['Prepared by', snap.preparedBy || ''], ['Generated', new Date(snap.generatedAt).toLocaleDateString('en-AU') + ' by ' + snap.generatedByName],
    ['Status', report.status === 'approved' ? 'Approved' : 'DRAFT - pending approval'],
    ['Source report file', snap.fileName], ['Asset register', snap.register ? `${snap.register.name} v${snap.register.versionNo} (${snap.register.assetCount} assets)` : ''], []
  ];
  const sheets = [{ name: 'Inspection Register', headerRow: info.length, aoa: [...info, REGISTER_HEADERS, ...snap.rows.map((r) => registerLine(snap, r, date))] }];
  const flagged = snap.rows.filter((r) => r.kind !== 'matched');
  if (flagged.length) {
    sheets.push({ name: 'Flagged for Review', headerRow: 0, aoa: [['Item', 'Description in Report', 'Page Number Found', 'Status', 'Proposed / Closest Asset ID', 'Match Confidence %', 'Reason'],
      ...flagged.map((r) => [r.item, r.reportDescription, pageCell(r.page), r.statusText, r.kind === 'review' ? r.assetId : r.closestAssetId, r.confidence == null ? '' : r.confidence, r.reason])] });
  }
  sheets.push({ name: 'Summary', headerRow: 0, noFilter: true, aoa: [['Measure', 'Assets'], ['Assets in report', c.total], ['Matched to register', c.matched], ['Flagged for review', c.review],
    ['Not in register', c.unmatched], [`Condition breaches (worse than ${snap.minCondition})`, c.breaches], [],
    ...[1, 2, 3, 4, 5].map((n) => [`Condition ${n} - ${COND_LABELS[n]}`, c.cond[n - 1]]), ['Not rated', c.cond[5]]] });
  return toXlsx(sheets);
}

export function reportCsv(report) {
  const snap = report.snapshot;
  return toCsv(REGISTER_HEADERS, snap.rows.map((r) => registerLine(snap, r, snap.assessmentDate || 'Not stated')));
}

/* ---------- PDF ---------- */
// jsPDF's built-in fonts cover Latin-1 only.
const P = (s) => String(s == null ? '' : s)
  .replace(/[‐-―−]/g, '-').replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"')
  .replace(/…/g, '...').replace(/≈/g, '~').replace(/→/g, '->').replace(/[^\x00-\xFF]/g, '?');

function logo(doc, x, y, scale = 1) {
  // Ascending bars mark + wordmark
  doc.setFillColor(...BLUE);
  [[0, 6, 2.2], [3, 4, 4.2], [6, 2, 6.2]].forEach(([dx, dy, h]) => doc.rect(x + dx * scale, y + dy * scale, 2.2 * scale, h * scale, 'F'));
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11 * scale); doc.setTextColor(...CHARCOAL);
  doc.text('SCALE POINT GROUP', x + 10.5 * scale, y + 6.2 * scale);
}

export function reportPdf(report) {
  const snap = report.snapshot;
  const c = snap.counts;
  const draft = report.status !== 'approved';
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;
  const at = (opts) => autoTable(doc, opts);
  const finalY = () => (doc.lastAutoTable ? doc.lastAutoTable.finalY : 40);

  // Header band
  doc.setFillColor(...CHARCOAL); doc.rect(0, 0, W, 3, 'F');
  logo(doc, M, 8);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GREY);
  doc.text('Asset Inspection & Register Management', W - M, 12, { align: 'right' });
  doc.text('Issued ' + new Date(snap.generatedAt).toLocaleDateString('en-AU'), W - M, 16.5, { align: 'right' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(...CHARCOAL);
  doc.text(P(snap.title), M, 27);
  if (draft) { doc.setFontSize(9); doc.setTextColor(180, 83, 9); doc.text('DRAFT - PENDING APPROVAL', M, 32); }

  at({
    startY: draft ? 35 : 31, margin: { left: M, right: M }, theme: 'plain',
    styles: { fontSize: 8.5, cellPadding: { top: 0.7, bottom: 0.7, left: 0, right: 4 }, textColor: CHARCOAL, overflow: 'linebreak' },
    columnStyles: { 0: { fontStyle: 'bold', textColor: GREY, cellWidth: 36 }, 1: { cellWidth: 98 }, 2: { fontStyle: 'bold', textColor: GREY, cellWidth: 34 }, 3: { cellWidth: 'auto' } },
    body: [
      ['Report reference', P(snap.reportRef || '-'), 'Prepared for', P(snap.preparedFor || '-')],
      ['Assessment date', P(snap.assessmentDateText), 'Prepared by', P(snap.preparedBy || '-')],
      ['Site', P(snap.site || '-'), 'Asset register', P(snap.register ? `${snap.register.name} - version ${snap.register.versionNo}` : '-')],
      ['Source report file', P(snap.fileName), 'Report pages', String(snap.pageCount || '-')]
    ]
  });

  // KPI boxes
  let y = finalY() + 4;
  const boxes = [['Assets in report', c.total], ['Matched to register', c.matched], ['Flagged for review', c.review], ['Not in register', c.unmatched], [`Condition breaches (worse than ${snap.minCondition})`, c.breaches]];
  const gap = 4; const bw = (W - 2 * M - gap * (boxes.length - 1)) / boxes.length; const bh = 14;
  boxes.forEach((b, i) => {
    const x = M + i * (bw + gap);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.setFillColor(246, 248, 251); doc.rect(x, y, bw, bh, 'FD');
    doc.setFillColor(...BLUE); doc.rect(x, y, 1.2, bh, 'F');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...GREY); doc.text(P(b[0]), x + 4, y + 4.8);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...CHARCOAL); doc.text(String(b[1]), x + 4, y + 11.5);
  });
  y += bh + 5;
  doc.setFontSize(8); doc.setFont('helvetica', 'normal');
  let x = M;
  doc.setTextColor(...GREY); doc.text('Condition as reported:', x, y); x += doc.getTextWidth('Condition as reported:') + 4;
  [1, 2, 3, 4, 5].forEach((n) => {
    doc.setFillColor(...COND_FILL[n].fill); doc.rect(x, y - 2.6, 3, 3, 'F'); x += 4.2;
    const t = `${n} ${COND_LABELS[n]}: ${c.cond[n - 1]}`;
    doc.setTextColor(...CHARCOAL); doc.text(t, x, y); x += doc.getTextWidth(t) + 6;
  });
  doc.setTextColor(...GREY); doc.text('Not rated: ' + c.cond[5], x, y);

  const table = {
    theme: 'grid', margin: { left: M, right: M, top: 20, bottom: 15 },
    styles: { font: 'helvetica', fontSize: 7.8, cellPadding: 1.6, textColor: CHARCOAL, lineColor: LINE, lineWidth: 0.15, valign: 'middle', overflow: 'linebreak' },
    headStyles: { fillColor: CHARCOAL, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [249, 250, 252] }
  };
  at({
    ...table, startY: y + 4,
    head: [['Item', 'Asset ID', 'Asset Description', 'Condition', 'Assessment Date', 'Inspection Notes', 'Page', 'Confidence', 'Status']],
    body: snap.rows.map((r) => [r.item, P(r.assetId || '-'), P(r.assetDescription), P(r.conditionText), P(snap.assessmentDateText), P(r.inspectionNotes || '-'), P(r.page), r.confidence == null ? '-' : r.confidence + '%', P(r.statusText)]),
    columnStyles: { 0: { cellWidth: 10, halign: 'right' }, 1: { cellWidth: 28 }, 2: { cellWidth: 62 }, 3: { cellWidth: 24 }, 4: { cellWidth: 21 }, 5: { cellWidth: 'auto' }, 6: { cellWidth: 12, halign: 'center' }, 7: { cellWidth: 17, halign: 'center' }, 8: { cellWidth: 27 } },
    didParseCell: (h) => {
      if (h.section !== 'body') return;
      const r = snap.rows[h.row.index];
      if (!r) return;
      if (h.column.index === 3 && COND_FILL[r.condition]) { h.cell.styles.fillColor = COND_FILL[r.condition].fill; h.cell.styles.textColor = COND_FILL[r.condition].text; h.cell.styles.fontStyle = 'bold'; }
      if (h.column.index === 8 && r.kind !== 'matched') { h.cell.styles.textColor = r.kind === 'review' ? [146, 64, 14] : [162, 25, 31]; h.cell.styles.fontStyle = 'bold'; }
      if (h.column.index === 1 && !r.assetId) h.cell.styles.textColor = [150, 150, 150];
    }
  });

  const flagged = snap.rows.filter((r) => r.kind !== 'matched');
  y = finalY() + 9;
  if (flagged.length) {
    if (y > H - 45) { doc.addPage(); y = 24; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...CHARCOAL);
    doc.text(`Items flagged for review (${flagged.length})`, M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...GREY);
    const para = doc.splitTextToSize('These items could not be matched to the asset register with full confidence. Verify the proposed Asset ID before updating the register; items marked "Not in register" have no corresponding asset in the register version used.', W - 2 * M);
    doc.text(para, M, y + 5);
    at({
      ...table, startY: y + 6 + para.length * 3.8,
      head: [['Item', 'Description in report', 'Page', 'Proposed / closest Asset ID', 'Confidence', 'Reason']],
      body: flagged.map((r) => [r.item, P(r.reportDescription), P(r.page), P((r.kind === 'review' ? r.assetId : r.closestAssetId) || '-'), r.confidence == null ? '-' : r.confidence + '%', P(r.reason)]),
      columnStyles: { 0: { cellWidth: 10, halign: 'right' }, 1: { cellWidth: 70 }, 2: { cellWidth: 12, halign: 'center' }, 3: { cellWidth: 38 }, 4: { cellWidth: 20, halign: 'center' }, 5: { cellWidth: 'auto' } },
      headStyles: { fillColor: BLUE, textColor: 255, fontStyle: 'bold' }
    });
    y = finalY() + 9;
  }

  const notes = [
    'Asset condition is shown as stated in the subcontractor report (1 Very Good, 2 Good, 3 Fair, 4 Poor, 5 Very Poor). Where an asset was rated more than once, the worst rating is shown.',
    'Page numbers refer to the source report page on which the condition rating was recorded (or where the asset first appears, if it was not rated).',
    'Status: Matched = matched automatically to the asset register; Confirmed = verified by a reviewer; Review required = probable match to be verified; Not in register = no corresponding asset found.'
  ];
  doc.setFontSize(7.8);
  const lines = notes.map((n) => doc.splitTextToSize(n, W - 2 * M));
  if (y + 6 + lines.reduce((s, l) => s + l.length * 3.4 + 1, 0) > H - 15) { doc.addPage(); y = 24; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...CHARCOAL); doc.text('Notes', M, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor(...GREY);
  y += 4.5;
  lines.forEach((l) => { doc.text(l, M, y); y += l.length * 3.4 + 1; });

  // Running header, footer and draft watermark on every page
  const n = doc.internal.getNumberOfPages();
  const foot = P([snap.footerText || 'Scale Point Group', snap.reportRef ? 'Report ' + snap.reportRef : '', 'Assessment date ' + snap.assessmentDateText].filter(Boolean).join('  |  '));
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    if (i > 1) {
      logo(doc, M, 5, 0.8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...GREY);
      doc.text(P(snap.title), W - M, 10, { align: 'right' });
      doc.setDrawColor(...LINE); doc.line(M, 14, W - M, 14);
    }
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(M, H - 10, W - M, H - 10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...GREY);
    doc.text(foot, M, H - 6);
    doc.text(`Page ${i} of ${n}`, W - M, H - 6, { align: 'right' });
    if (draft) {
      try {
        doc.saveGraphicsState(); doc.setGState(new doc.GState({ opacity: 0.08 }));
        doc.setFont('helvetica', 'bold'); doc.setFontSize(70); doc.setTextColor(...CHARCOAL);
        doc.text('DRAFT', W / 2, H / 2 + 15, { align: 'center', angle: 25 });
        doc.restoreGraphicsState();
      } catch { /* watermark is cosmetic */ }
    }
  }
  doc.setProperties({ title: P(snap.title), subject: P('Inspection register ' + (snap.reportRef || '')), author: 'Scale Point Group', creator: 'Scale Point Group Asset Platform' });
  return Buffer.from(doc.output('arraybuffer'));
}
