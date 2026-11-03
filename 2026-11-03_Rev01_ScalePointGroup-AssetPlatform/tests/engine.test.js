import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MATCHING, parseSynonyms, registerFeatures, findingFeatures, scorePair, rankCandidates, autoStatus,
  featuresToTokens, tokensToFeatures, prefilterTokens, explainMatch, extractZones
} from '../shared/engine.js';

const S = JSON.parse(JSON.stringify(DEFAULT_MATCHING));
const syn = parseSynonyms(S.synonyms);
const reg = (assetCode, description, extra = {}) => ({ ref: assetCode, f: registerFeatures({ assetCode, description, location: '', locationDescription: '', status: 'OPERATING', ...extra }, syn) });

const REGISTER = [
  reg('A1004034', 'Deluge Valve S (ZONE 13) [LOC: TUN / CAR / SB / FL / XP04 / DZ13]'),
  reg('A1004000', 'Deluge Valve N (ZONE 13) [LOC: TUN / CAR / NB / FL / XP04 / DZ13]'),
  reg('A1004033', 'Deluge Valve S (ZONE 12) [LOC: TUN / CAR / SB / FL / XP04 / DZ12]'),
  reg('A1003820', 'Deluge Piping - S-34 SB (CP10 - CP11) [LOC: TUN / CAR / SB / FL / XP10 / DZ33]'),
  reg('A1004955', 'Fire Hydrant (SB) [LOC: TUN / CAR / SB / FL]', { location: 'ME-FHYDR-015' }),
  reg('A1004972', 'Fire Hydrant (SB) [LOC: TUN / CAR / SB / FL]', { location: 'ME-FHYDR-032' })
];

const finding = (header, subloc = '') => {
  const parts = header.split(' - ');
  return { header, prefix: parts.length > 1 ? parts[0] : '', description: parts.length > 1 ? parts.slice(1).join(' - ') : header, subloc };
};

test('the specification example matches the right deluge valve automatically', () => {
  const pf = findingFeatures(finding('SB,DBS05, Z13 - Sprinkler Deluge Valve'), syn);
  const cands = rankCandidates(pf, REGISTER, S);
  assert.equal(cands[0].ref, 'A1004034');
  assert.ok(cands[0].score >= S.thresholds.likely, `score ${cands[0].score} should auto-accept`);
  assert.ok(['match', 'likely'].includes(autoStatus(cands, S)));
});

test('carriageway and zone conflicts are penalised', () => {
  const pf = findingFeatures(finding('SB,DBS05, Z13 - Sprinkler Deluge Valve'), syn);
  const right = scorePair(pf, REGISTER[0].f, S, true);
  const wrongDir = scorePair(pf, REGISTER[1].f, S, true);
  const wrongZone = scorePair(pf, REGISTER[2].f, S, true);
  assert.ok(wrongDir.penalties.some((p) => /direction/i.test(p.reason)));
  assert.ok(wrongZone.penalties.some((p) => /zone/i.test(p.reason)));
  assert.ok(right.score - wrongDir.score >= 20);
  assert.ok(right.score - wrongZone.score >= 20);
});

test('a zone in the description wins over the DZ code in the location path', () => {
  const f = REGISTER[3].f;
  assert.ok(f.zones.has(34));
  assert.ok(!f.zones.has(33));
});

test('ZONES 11&12 yields both zones', () => {
  const z = extractZones('Deluge Cabinet S (ZONES 11&12)', syn);
  assert.deepEqual([...z.zones].sort((a, b) => a - b), [11, 12]);
});

test('identical descriptions are held for review rather than guessed', () => {
  const pf = findingFeatures(finding('SB - Fire Hydrant'), syn);
  const cands = rankCandidates(pf, REGISTER, S);
  assert.equal(autoStatus(cands, S), 'review');
  assert.match(explainMatch('review', cands.map((c) => ({ ...c, assetCode: c.ref })), S), /other asset/);
});

test('a location code quoted in the report is an exact identifier', () => {
  const pf = findingFeatures(finding('ME-FHYDR-032 - Fire Hydrant'), syn);
  const cands = rankCandidates(pf, REGISTER, S);
  assert.equal(cands[0].ref, 'A1004972');
  assert.equal(cands[0].b.id.kind, 'location');
  assert.equal(autoStatus(cands, S), 'match');
});

test('decommissioned assets lose points', () => {
  const live = registerFeatures({ assetCode: 'X1', description: 'Fire Pump No 1', status: 'OPERATING' }, syn);
  const dead = registerFeatures({ assetCode: 'X2', description: 'Fire Pump No 1', status: 'DECOMMISSIONED' }, syn);
  const pf = findingFeatures(finding('Fire Pump No 1'), syn);
  assert.equal(scorePair(pf, live, S) - scorePair(pf, dead, S), S.inactivePenalty);
});

test('features survive the token round trip used for database storage', () => {
  const f = REGISTER[0].f;
  const back = tokensToFeatures(featuresToTokens(f));
  const pf = findingFeatures(finding('SB,DBS05, Z13 - Sprinkler Deluge Valve'), syn);
  assert.equal(scorePair(pf, back, S), scorePair(pf, f, S));
});

test('very common tokens are left out of the database shortlist', () => {
  const pf = findingFeatures(finding('SB,DBS05, Z13 - Sprinkler Deluge Valve'), syn);
  const tokens = prefilterTokens(pf, { 'T:VALVE': 5000, 'T:DELUGE': 300 }, 6800);
  assert.ok(!tokens.includes('T:VALVE'));
  assert.ok(tokens.includes('T:DELUGE'));
  assert.ok(tokens.includes('Z:13'));
});
