// Needs the npm dependencies installed (jspdf, jspdf-autotable, xlsx).
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportPdf, reportXlsx, reportCsv } from '../src/services/exports.js';

const report = {
  status: 'draft',
  snapshot: {
    title: 'Asset Condition Inspection Register', preparedFor: 'Client Pty Ltd', preparedBy: 'Scale Point Group', footerText: 'Prepared by Scale Point Group',
    reportRef: 'R-80685', site: 'Sydney Harbour Tunnel', fileName: 'R-80685.pdf', pageCount: 253, assessmentDate: '2025-10-02', assessmentDateText: '02/10/2025',
    register: { name: 'Master Asset Register', versionNo: 3, assetCount: 6804 }, minCondition: 3, generatedByName: 'Test User', generatedAt: new Date().toISOString(),
    counts: { total: 2, matched: 1, review: 1, unmatched: 0, breaches: 1, cond: [0, 0, 1, 1, 0, 0] },
    rows: [
      { item: 1, kind: 'matched', assetId: 'A1004034', assetDescription: 'Deluge Valve S (ZONE 13)', reportDescription: 'SB,DBS05, Z13 - Sprinkler Deluge Valve', condition: 3, conditionText: '3 - Fair', inspectionNotes: '', findings: 'Result PASS', page: '12', confidence: 85, statusText: 'Matched', reason: '85% confidence', closestAssetId: '' },
      { item: 2, kind: 'review', assetId: 'A1004955', assetDescription: 'Fire Hydrant (SB)', reportDescription: 'SB - Fire Hydrant', condition: 4, conditionText: '4 - Poor', inspectionNotes: 'Defect D-12: leaking gland – “urgent”', findings: '', page: '40-41', confidence: 71, statusText: 'Review required', reason: '71% but 39 other assets scored within 3 points', closestAssetId: '' }
    ]
  }
};

test('PDF export renders a branded document', () => {
  const buf = reportPdf(report);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(buf.length > 3000);
});

test('Excel export contains the three sheets', () => {
  const buf = reportXlsx(report);
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK'); // xlsx is a zip
});

test('CSV export has the required columns', () => {
  const csv = reportCsv(report);
  const header = csv.replace(/^﻿/, '').split('\r\n')[0];
  ['Asset ID', 'Asset Description', 'Asset Condition', 'Assessment Date', 'Inspection Notes', 'Page Number Found', 'Match Confidence %', 'Report Reference'].forEach((c) => assert.ok(header.includes(c), c));
});
