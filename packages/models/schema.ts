import { MDBError, type CriticVerdict, type Evidence, type ModelProposal, type Relation } from '../core/types.js';

/** Strict validation of untrusted model output. Messages name the failing path, never echo values. */
const PROPOSAL_KEYS = new Set(['kind', 'title', 'body', 'evidence', 'tags', 'links', 'status', 'metadata']);
const EVIDENCE_KEYS = new Set(['uri', 'revisionId', 'span']);
const LINK_KEYS = new Set(['type', 'target', 'revisionId']);
const VERDICT_KEYS = new Set(['verdict', 'rationale', 'flags']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Reserved kind for a valid, schema-conformant "nothing to propose" answer. */
export const ABSTENTION_KIND = 'no_insight';
export type DreamModelResult = { type: 'discovery'; proposal: ModelProposal } | { type: 'abstain'; reason: string };
export const LIMITS = { title: 300, body: 100000, evidence: 40, uri: 500, revisionId: 200, span: 100, status: 40, metadataChars: 20000, metadataDepth: 4, rationale: 2000, flags: 10, flag: 40 };

/** Models often emit null or "" for optional fields; treat that as absent. Wrong types and unknown fields are still rejected. */
const absent = (value: unknown): boolean => value === undefined || value === null || value === '';
function fail(path: string, rule: string): never { throw new MDBError('INVALID_MODEL_OUTPUT', `Model output invalid at ${path}: ${rule}`); }
function plain(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(path, 'expected object');
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void { for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key.slice(0, 40)}`, 'unknown field'); }
function str(value: unknown, path: string, max: number, min = 0): string { if (typeof value !== 'string' || value.length < min || value.length > max) fail(path, `expected string of ${min}..${max} characters`); return value as string; }
function json(value: unknown, path: string, depth: number): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(path, 'non-finite number'); return; }
  if (depth > LIMITS.metadataDepth) fail(path, 'too deeply nested');
  if (Array.isArray(value)) { if (value.length > 100) fail(path, 'array too long'); value.forEach((item, i) => json(item, `${path}[${i}]`, depth + 1)); return; }
  const object = plain(value, path);
  for (const [key, item] of Object.entries(object)) { if (FORBIDDEN_KEYS.has(key)) fail(path, 'forbidden key'); json(item, `${path}.${key.slice(0, 40)}`, depth + 1); }
}

export function parseModelProposal(raw: unknown): ModelProposal {
  const value = plain(raw, 'proposal');
  onlyKeys(value, PROPOSAL_KEYS, 'proposal');
  const kind = str(value.kind, 'proposal.kind', 64, 1);
  if (!/^[a-z][a-z0-9_:-]*$/.test(kind)) fail('proposal.kind', 'unsupported characters');
  const title = str(value.title, 'proposal.title', LIMITS.title, 1);
  if (!title.trim() || /[\r\n]/.test(title)) fail('proposal.title', 'must be a single non-empty line');
  const body = str(value.body, 'proposal.body', LIMITS.body, 1);
  // `no_insight` is the one reserved abstention kind (profile-extraction/v1): it may cite nothing, and the engine never stores it as knowledge.
  const minEvidence = kind === ABSTENTION_KIND ? 0 : 1;
  if (value.evidence === undefined && kind === ABSTENTION_KIND) value.evidence = [];
  if (!Array.isArray(value.evidence) || value.evidence.length < minEvidence || value.evidence.length > LIMITS.evidence) fail('proposal.evidence', `expected ${minEvidence}..${LIMITS.evidence} entries`);
  const evidence: Evidence[] = (value.evidence as unknown[]).map((entry, i) => {
    const item = plain(entry, `proposal.evidence[${i}]`);
    onlyKeys(item, EVIDENCE_KEYS, `proposal.evidence[${i}]`);
    return { uri: str(item.uri, `proposal.evidence[${i}].uri`, LIMITS.uri, 1), revisionId: str(item.revisionId, `proposal.evidence[${i}].revisionId`, LIMITS.revisionId, 1), ...(absent(item.span) ? {} : { span: str(item.span, `proposal.evidence[${i}].span`, 100_000, 1).slice(0, LIMITS.span) }) };
  });
  const result: ModelProposal = { kind, title, body, evidence };
  if (!absent(value.tags)) { if (!Array.isArray(value.tags) || value.tags.length > 100 || value.tags.some(tag => typeof tag !== 'string' || tag.length > 100)) fail('proposal.tags', 'expected up to 100 short strings'); result.tags = value.tags as string[]; }
  if (!absent(value.links)) {
    if (!Array.isArray(value.links) || value.links.length > 100) fail('proposal.links', 'expected up to 100 links');
    result.links = (value.links as unknown[]).map((entry, index): Relation => {
      const item = plain(entry, `proposal.links[${index}]`); onlyKeys(item, LINK_KEYS, `proposal.links[${index}]`);
      return { type: str(item.type, `proposal.links[${index}].type`, 80, 1), target: str(item.target, `proposal.links[${index}].target`, 512, 1), ...(absent(item.revisionId) ? {} : { revisionId: str(item.revisionId, `proposal.links[${index}].revisionId`, LIMITS.revisionId, 1) }) };
    });
  }
  if (!absent(value.status)) result.status = str(value.status, 'proposal.status', LIMITS.status, 1);
  if (!absent(value.metadata)) {
    const metadata = plain(value.metadata, 'proposal.metadata');
    json(metadata, 'proposal.metadata', 0);
    if (JSON.stringify(metadata).length > LIMITS.metadataChars) fail('proposal.metadata', 'too large');
    result.metadata = metadata;
  }
  return result;
}

/** Dream-only discriminated response: abstention is complete and valid, never a repairable discovery schema error. */
export function parseDreamResponse(raw: unknown): DreamModelResult {
  const proposal = parseModelProposal(raw);
  if (proposal.kind !== ABSTENTION_KIND) return { type: 'discovery', proposal };
  if (proposal.evidence.length !== 0 || proposal.metadata || proposal.status || proposal.tags || proposal.links)
    fail('proposal', 'a Dream abstention must contain only kind, title, body, and an empty evidence array');
  return { type: 'abstain', reason: proposal.body.trim() };
}

export function parseVerdict(raw: unknown): CriticVerdict {
  const value = plain(raw, 'verdict');
  onlyKeys(value, VERDICT_KEYS, 'verdict');
  if (value.verdict !== 'accept' && value.verdict !== 'reject') fail('verdict.verdict', 'expected accept or reject');
  const rationale = str(value.rationale, 'verdict.rationale', LIMITS.rationale, 1);
  let flags: string[] | undefined;
  if (!absent(value.flags)) {
    if (!Array.isArray(value.flags) || value.flags.length > LIMITS.flags) fail('verdict.flags', 'expected short array');
    flags = (value.flags as unknown[]).map((flag, i) => { const text = str(flag, `verdict.flags[${i}]`, LIMITS.flag, 1); if (!/^[a-z][a-z0-9_-]*$/.test(text)) fail(`verdict.flags[${i}]`, 'unsupported characters'); return text; });
  }
  return { verdict: value.verdict, rationale, ...(flags ? { flags } : {}) };
}

/** Accepts one JSON object, optionally wrapped in a Markdown code fence. Anything else is rejected. */
export function extractJson(text: string): unknown {
  let candidate = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(candidate);
  if (fenced) candidate = fenced[1]!.trim();
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) throw new MDBError('INVALID_MODEL_OUTPUT', 'Model output is not a single JSON object');
  try { return JSON.parse(candidate); } catch { throw new MDBError('INVALID_MODEL_OUTPUT', 'Model output is not valid JSON'); }
}
