// Server-side matching against the active register version.
// The database shortlists candidates through the GIN index on precomputed tokens; the shared engine scores them.
import { query } from '../db.js';
import {
  parseSynonyms, findingFeatures, tokensToFeatures, prefilterTokens, rankCandidates, autoStatus, explainMatch, scorePair, ACCEPTED_STATUSES
} from '../../shared/engine.js';

const CANDIDATE_LIMIT = 400;
const CANDIDATE_SQL = `
  SELECT id, asset_id, asset_code, description, location, status, match_tokens,
         cardinality(ARRAY(SELECT unnest(match_tokens) INTERSECT SELECT unnest($2::text[]))) AS hits
    FROM asset_versions
   WHERE version_id = $1 AND is_primary AND NOT is_archived AND match_tokens && $2::text[]
   ORDER BY hits DESC
   LIMIT $3`;

// Compact candidate stored with each finding (the breakdown powers "why this match").
function candidate(row, scored) {
  return {
    assetVersionId: row.id, assetId: row.asset_id, assetCode: row.asset_code, description: row.description,
    location: row.location, status: row.status, score: scored.score, b: scored.b
  };
}

export function matchContext(settings) {
  return { S: settings, syn: parseSynonyms(settings.synonyms) };
}

export async function matchFinding(version, rec, ctx) {
  const pf = findingFeatures(rec, ctx.syn);
  const tokens = prefilterTokens(pf, version.token_stats || {}, version.asset_count);
  if (!tokens.length) return { status: 'nomatch', candidates: [], explanation: explainMatch('nomatch', [], ctx.S) };
  const r = await query(CANDIDATE_SQL, [version.id, tokens, CANDIDATE_LIMIT]);
  const ranked = rankCandidates(pf, r.rows.map((row) => ({ ref: row, f: tokensToFeatures(row.match_tokens) })), ctx.S, 5);
  const candidates = ranked.map((c) => candidate(c.ref, c));
  const status = autoStatus(candidates, ctx.S);
  return { status, candidates, explanation: explainMatch(status, candidates, ctx.S) };
}

// Runs fn over items with limited concurrency (keeps the small database pool from saturating).
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

// Score one specific register row for a finding (manual assignment).
export function scoreSpecific(rec, assetRow, ctx) {
  const pf = findingFeatures(rec, ctx.syn);
  const scored = scorePair(pf, tokensToFeatures(assetRow.match_tokens), ctx.S, true);
  return candidate(assetRow, { score: scored.score, b: scored });
}

// Fields written to inspection_findings for a given decision.
export function decisionFields(status, candidates, explanation, chosen) {
  const accepted = ACCEPTED_STATUSES.has(status);
  const c = chosen || (accepted ? candidates[0] : null);
  const best = candidates[0];
  return {
    match_status: status,
    confidence: status === 'rejected' ? null : (c ? c.score : best ? best.score : null),
    match_explanation: explanation,
    matched_asset_id: accepted && c ? c.assetId : null,
    matched_asset_version_id: accepted && c ? c.assetVersionId : null,
    asset_code_snapshot: accepted && c ? c.assetCode : '',
    asset_description_snapshot: accepted && c ? c.description : '',
    asset_location_snapshot: accepted && c ? c.location : ''
  };
}
