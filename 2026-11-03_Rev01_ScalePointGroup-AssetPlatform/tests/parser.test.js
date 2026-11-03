import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateISO, fmtDate, interpretPages, buildFindings, pageList } from '../shared/report-parser.js';
import { guessMapping, detectHeaderRow } from '../shared/register-fields.js';

test('report dates in common Australian formats', () => {
  assert.equal(parseDateISO('Service performed on Thursday 2nd October 2025'), '2025-10-02');
  assert.equal(parseDateISO('Date: 03/11/2026'), '2026-11-03');
  assert.equal(parseDateISO('October 2, 2025'), '2025-10-02');
  assert.equal(parseDateISO('2026-01-31'), '2026-01-31');
  assert.equal(parseDateISO('31/02/2026'), ''); // invalid day
  assert.equal(parseDateISO('Page 3 of 12'), '');
  assert.equal(fmtDate('2026-11-03'), '03/11/2026');
});

test('page lists collapse into ranges', () => {
  assert.equal(pageList([9, 3, 4, 5, 5]), '3-5, 9');
  assert.equal(pageList([]), '');
});

// Synthetic one-page report in an unfamiliar layout (exercises the line-based fallback).
function page(lines) {
  return [{ num: 1, width: 600, height: 800, items: lines.map((str, i) => ({ str, x: 40, y: 700 - i * 14, w: str.length * 5, size: 10 })) }];
}

test('assets, condition and page are extracted from a simple layout', () => {
  const res = interpretPages(page(['Inspection date: 14/10/2025', 'Deluge Valve Zone 13 PASS', 'Condition: 4', 'Fire Hydrant H15 FAIL', 'Defect D-12 Defects Reported: leaking gland']), 'R-1.pdf');
  assert.equal(res.meta.dateISO, '2025-10-14');
  const f = buildFindings(res.records, true);
  assert.equal(f.length, 2);
  assert.equal(f[0].condition, 4);
  assert.deepEqual(f[0].conditionPages, [1]);
  assert.equal(f[1].result, 'FAIL');
});

test('repeat entries of one asset merge, keeping the worst condition and its page', () => {
  const raws = [
    { header: 'Pump 1', prefix: '', description: 'Pump 1', subloc: '', result: 'PASS', sections: ['Q'], checks: [], conditions: [2], condPages: [3], defects: [], comments: '', pages: [3] },
    { header: 'Pump 1', prefix: '', description: 'Pump 1', subloc: '', result: 'FAIL', sections: ['A'], checks: [], conditions: [4], condPages: [9], defects: [], comments: '', pages: [9] }
  ];
  const [m] = buildFindings(raws, true);
  assert.equal(m.condition, 4);
  assert.deepEqual(m.conditionPages, [9]);
  assert.equal(m.result, 'FAIL');
  assert.equal(buildFindings(raws, false).length, 2);
});

test('the confirmed Maximo register headings map automatically', () => {
  const headers = ['Asset', 'Description', 'Asset Criticality', 'Limited Liability Asset', 'Parent Asset', 'Location', 'Location Description', 'Parent Location', 'Parent Location Description', 'Asset Rotating Item', 'Asset Up', 'Status', 'Site'];
  const m = guessMapping(headers);
  assert.equal(m.assetCode, 0);
  assert.equal(m.description, 1);
  assert.equal(m.criticality, 2);
  assert.equal(m.parentAsset, 4);
  assert.equal(m.location, 5);
  assert.equal(m.locationDescription, 6);
  assert.equal(m.category, 9);
  assert.equal(m.status, 11);
  assert.equal(m.site, 12);
  assert.equal(detectHeaderRow([['Exported 2026'], headers, ['A1', 'x']]), 1);
});

test('a previous mapping carries over by heading even when columns move', () => {
  const prev = { headers: ['Code', 'Text'], mapping: { assetCode: 0, description: 1 } };
  const m = guessMapping(['Text', 'Extra', 'Code'], prev);
  assert.equal(m.assetCode, 2);
  assert.equal(m.description, 0);
});
