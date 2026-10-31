import type { Document, Evidence, Scope } from '../core/types.js';
import { MDBError } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { lintCitations } from './wiki.js';

export const WIKI_LINT_CODES = [
  'missing_evidence', 'unresolved_or_inaccessible_evidence', 'evidence_span_not_found', 'uncited_claim',
  'broken_wikilink', 'dangling_reference', 'orphan_page', 'duplicate_title', 'duplicate_content',
  'stale_source', 'source_deleted', 'empty_page', 'tag_inconsistency', 'page_too_large_for_body_checks'
] as const;
export type WikiLintCode = typeof WIKI_LINT_CODES[number];
export type WikiLintSeverity = 'error' | 'warning' | 'info';
export interface WikiLintIssue {
  objectId: string; issue: WikiLintCode; severity: WikiLintSeverity; message: string; suggestedAction: string;
  relatedObjectIds?: string[]; memberObjectIds?: string[]; memberCount?: number; membersTruncated?: true;
}
export interface WikiLintOptions { scopes?: Scope[]; checks?: WikiLintCode[]; minSeverity?: WikiLintSeverity; limit?: number }
export interface WikiLintResult {
  checked: number; issues: WikiLintIssue[]; semanticTruthVerified: false; summary: { byCode: Partial<Record<WikiLintCode, number>>; bySeverity: Record<WikiLintSeverity, number> }; truncated: boolean;
}
type LintVault = Pick<Vault, 'listDocuments' | 'get'>;

const severityRank: Record<WikiLintSeverity, number> = { error: 3, warning: 2, info: 1 };
const defaults: Record<WikiLintCode, { severity: WikiLintSeverity; message: string; suggestedAction: string }> = {
  missing_evidence: { severity: 'error', message: 'This semantic page has no evidence references.', suggestedAction: 'Add accessible source evidence.' },
  unresolved_or_inaccessible_evidence: { severity: 'error', message: 'An evidence reference cannot be resolved or read.', suggestedAction: 'Replace it with accessible evidence.' },
  evidence_span_not_found: { severity: 'warning', message: 'A cited evidence span was not found in its source revision.', suggestedAction: 'Correct or remove the cited span.' },
  uncited_claim: { severity: 'warning', message: 'A substantive wiki claim has no citation marker.', suggestedAction: 'Cite the supporting evidence.' },
  broken_wikilink: { severity: 'warning', message: 'A wiki link does not match an active accessible page.', suggestedAction: 'Fix the link or add an accessible page.' },
  dangling_reference: { severity: 'warning', message: 'A structured reference does not resolve to an active accessible object.', suggestedAction: 'Repair or remove the reference.' },
  orphan_page: { severity: 'info', message: 'No other accessible document links to this page.', suggestedAction: 'Link this page where it is relevant.' },
  duplicate_title: { severity: 'warning', message: 'Accessible wiki pages share a normalized title.', suggestedAction: 'Review the pages and consolidate duplicates.' },
  duplicate_content: { severity: 'warning', message: 'Accessible wiki pages share identical normalized content.', suggestedAction: 'Review the pages and consolidate duplicates.' },
  stale_source: { severity: 'warning', message: 'A source has changed since this page was derived.', suggestedAction: 'Review and recompile this page.' },
  source_deleted: { severity: 'warning', message: 'A cited source is no longer active.', suggestedAction: 'Replace the deleted source with active evidence.' },
  empty_page: { severity: 'warning', message: 'This wiki page has no content beyond headings and whitespace.', suggestedAction: 'Add useful content or propose retiring the page.' },
  tag_inconsistency: { severity: 'info', message: 'Tags differ only in case or separators.', suggestedAction: 'Standardize the tag spelling.' },
  page_too_large_for_body_checks: { severity: 'info', message: 'Body-level lint checks were skipped because this page exceeds 200 KB.', suggestedAction: 'Review or split the page before running body-level lint.' }
};
const normalizeWhitespace = (value: string): string => value.toLowerCase().replace(/\s+/gu, ' ').trim();
const normalizeTitle = (value: string): string => normalizeWhitespace(value).replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
const normalizeTag = (value: string): string => value.toLowerCase().replace(/[\s_-]+/gu, '');
const BODY_CHECK_LIMIT = 200 * 1024;
const bodyTooLarge = (body: string): boolean => Buffer.byteLength(body, 'utf8') > BODY_CHECK_LIMIT;
function fenceAt(line: string): { marker: '`' | '~'; length: number } | undefined {
  let i = 0; while (i < line.length && i < 3 && line.charCodeAt(i) === 32) i++;
  const marker = line[i]; if (marker !== '`' && marker !== '~') return undefined;
  let end = i + 1; while (end < line.length && line[end] === marker) end++;
  return end - i >= 3 ? { marker, length: end - i } : undefined;
}
function stripInlineCode(line: string): string {
  const runs: Array<{ start: number; end: number; length: number }> = [];
  for (let i = 0; i < line.length;) {
    if (line.charCodeAt(i) !== 96) { i++; continue; }
    const start = i; while (i < line.length && line.charCodeAt(i) === 96) i++;
    runs.push({ start, end: i, length: i - start });
  }
  if (!runs.length) return line;
  const nextSameRun = new Array<number | undefined>(runs.length), next = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) { nextSameRun[i] = next.get(runs[i]!.length); next.set(runs[i]!.length, i); }
  let out = '', cursor = 0;
  for (let i = 0; i < runs.length;) {
    const close = nextSameRun[i];
    if (close === undefined) { i++; continue; }
    out += line.slice(cursor, runs[i]!.start); cursor = runs[close]!.end; i = close + 1;
  }
  return out + line.slice(cursor);
}
/** Remove fenced and inline code in a single bounded pass over lines and delimiter runs. */
function stripCode(text: string): string {
  let output = '', offset = 0; let fence: { marker: '`' | '~'; length: number } | undefined;
  while (offset < text.length) {
    let end = text.indexOf('\n', offset); if (end < 0) end = text.length;
    const line = text.slice(offset, end), candidate = fenceAt(line);
    if (fence) {
      if (candidate?.marker === fence.marker && candidate.length >= fence.length) fence = undefined;
    } else if (candidate) fence = candidate;
    else output += stripInlineCode(line);
    if (end < text.length) { if (!fence) output += '\n'; offset = end + 1; } else offset = end;
  }
  return output;
}
function* wikiLinks(body: string): Generator<string> {
  for (let start = body.indexOf('[['); start >= 0;) {
    const end = body.indexOf(']]', start + 2);
    if (end < 0) return;
    const raw = body.slice(start + 2, end), pipe = raw.indexOf('|');
    const title = raw.slice(0, pipe < 0 ? raw.length : pipe).trim();
    if (title) yield title;
    start = body.indexOf('[[', end + 2);
  }
}
function* mdbReferences(body: string): Generator<string> {
  const folded = body.toLowerCase();
  for (let start = folded.indexOf('mdb://'); start >= 0;) {
    let end = start + 6;
    while (end < body.length && !'\t\r\n )]} >"\''.includes(body[end]!)) end++;
    if (end > start + 6) yield body.slice(start, end).replace(/[.,;:!?]+$/u, '');
    start = folded.indexOf('mdb://', Math.max(end, start + 6));
  }
}
function idsIn(uri: string): string | undefined {
  if (!uri.startsWith('mdb://')) return /^[A-Za-z0-9_-]+$/u.test(uri) ? uri : undefined;
  const path = uri.slice(6); let at = 0;
  while (at < path.length) {
    const slash = path.indexOf('/', at), end = slash < 0 ? path.length : slash;
    if (path.slice(at, end) === 'objects' && slash >= 0) {
      const idStart = slash + 1; let idEnd = idStart;
      while (idEnd < path.length && !'/@?#'.includes(path[idEnd]!)) idEnd++;
      return idEnd > idStart ? path.slice(idStart, idEnd) : undefined;
    }
    if (slash < 0) break;
    at = slash + 1;
  }
  return undefined;
}
const isActive = (doc: Document): boolean => doc.status !== 'deleted' && doc.status !== 'tombstone';
const isIndex = (doc: Document): boolean => /(?:index|overview)/iu.test(`${doc.kind} ${doc.title}`) || doc.metadata.MAIN_INDEX === true || doc.metadata.mainIndex === true;

/** Deterministic, actor-bound wiki lint. The vault's list/get methods are the only source of document data. */
export async function lintWiki(vault: LintVault, options: WikiLintOptions = {}): Promise<WikiLintResult> {
  if (options.checks?.some(code => !(WIKI_LINT_CODES as readonly string[]).includes(code))) throw new MDBError('INVALID_INPUT', 'Unknown wiki lint check code');
  if (options.minSeverity !== undefined && !Object.hasOwn(severityRank, options.minSeverity)) throw new MDBError('INVALID_INPUT', 'minSeverity must be error, warning, or info');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) throw new MDBError('INVALID_INPUT', 'limit must be a nonnegative integer');
  const history = await vault.listDocuments({ includeHistory: true, includeUnresolvedReferences: true });
  const heads = new Map<string, Document>();
  for (const doc of history) if (!heads.has(doc.id) || heads.get(doc.id)!.revisionNumber < doc.revisionNumber) heads.set(doc.id, doc);
  const readableDocs = [...heads.values()].filter(isActive);
  const selected = (doc: Document): boolean => !options.scopes?.length || options.scopes.some(scope => scope.type === doc.scope.type && (scope.type === 'global' ? doc.scope.type === 'global' && scope.area === doc.scope.area : doc.scope.type === 'workspace' && scope.workspaceId === doc.scope.workspaceId && (!scope.collectionId || doc.scope.collectionId === scope.collectionId)));
  const docs = readableDocs.filter(selected);
  const accessible = new Map(readableDocs.map(doc => [doc.id, doc]));
  const pages = readableDocs.filter(doc => doc.kind === 'wiki_page');
  const selectedPages = docs.filter(doc => doc.kind === 'wiki_page');
  const issues: WikiLintIssue[] = [];
  const checks = new Set<WikiLintCode>(options.checks ?? WIKI_LINT_CODES);
  const minSeverity = options.minSeverity ?? 'info';
  const add = (doc: Document, code: WikiLintCode, relatedObjectIds?: string[]) => {
    if (!checks.has(code) || severityRank[defaults[code].severity] < severityRank[minSeverity]) return;
    issues.push({ objectId: doc.id, issue: code, ...defaults[code], ...(relatedObjectIds?.length ? { relatedObjectIds } : {}) });
  };

  // Memoized (id, revision) actor-bound reads; concurrency stays bounded for large evidence sets.
  const evidenceRefs = new Map<string, { id: string; revisionId: string }>();
  for (const doc of docs) for (const evidence of doc.evidence) {
    const id = idsIn(evidence.uri); if (id && evidence.revisionId) evidenceRefs.set(`${id}\0${evidence.revisionId}`, { id, revisionId: evidence.revisionId });
  }
  const resolved = new Map<string, Document | undefined>();
  const queue = [...evidenceRefs.entries()];
  for (let offset = 0; offset < queue.length; offset += 8) {
    await Promise.all(queue.slice(offset, offset + 8).map(async ([key, ref]) => {
      try { resolved.set(key, await vault.get(ref.id, ref.revisionId)); } catch { resolved.set(key, undefined); }
    }));
  }
  const referenceExists = (uri: string): boolean => { const id = idsIn(uri), target = id ? accessible.get(id) : undefined; return !!target && (uri === target.uri || uri === target.id); };

  // Title/alias maps are scoped to readable active pages. Same-scope candidates win naturally; both scopes are valid.
  const titleMap = new Map<string, Document[]>();
  const scopedTitleMap = new Map<string, Document>();
  for (const page of pages) for (const raw of [page.title, ...(Array.isArray(page.metadata.aliases) ? page.metadata.aliases.filter((x): x is string => typeof x === 'string') : [])]) {
    const key = normalizeTitle(raw);
    if (key) {
      const matches = titleMap.get(key) ?? []; matches.push(page); titleMap.set(key, matches);
      const scopedKey = `${scopeKey(page.scope)}\0${key}`; if (!scopedTitleMap.has(scopedKey)) scopedTitleMap.set(scopedKey, page);
    }
  }
  const inbound = new Set<string>();
  for (const doc of readableDocs) {
    for (const link of doc.links) { const target = idsIn(link.target); if (target && target !== doc.id && accessible.has(target)) inbound.add(target); }
    if (bodyTooLarge(doc.body)) continue;
    const body = stripCode(doc.body);
    for (const linkTitle of wikiLinks(body)) {
      const title = normalizeTitle(linkTitle), target = scopedTitleMap.get(`${scopeKey(doc.scope)}\0${title}`) ?? titleMap.get(title)?.[0];
      if (target && target.id !== doc.id) inbound.add(target.id);
    }
  }

  // Duplicate groups are emitted once with the complete actor-visible member list.
  for (const code of ['duplicate_title', 'duplicate_content'] as const) {
    const groups = new Map<string, Document[]>();
    for (const page of selectedPages) {
      if (code === 'duplicate_content' && bodyTooLarge(page.body)) continue;
      const value = code === 'duplicate_title' ? normalizeTitle(page.title) : normalizeWhitespace(page.body);
      const key = value ? `${scopeKey(page.scope)}\0${value}` : '';
      if (key) { const group = groups.get(key) ?? []; group.push(page); groups.set(key, group); }
    }
    for (const group of groups.values()) if (group.length > 1) {
      const ids = group.map(d => d.id).sort();
      if (checks.has(code) && severityRank[defaults[code].severity] >= severityRank[minSeverity]) {
        const members = ids.slice(0, 100);
        issues.push({ objectId: ids[0]!, issue: code, ...defaults[code], relatedObjectIds: members.slice(1), memberObjectIds: members, memberCount: ids.length, ...(ids.length > members.length ? { membersTruncated: true as const } : {}) });
      }
    }
  }

  for (const doc of docs) {
    if (['wiki_page', 'insight', 'discovery', 'user_insight'].includes(doc.kind) && doc.evidence.length === 0) add(doc, 'missing_evidence');
    for (const evidence of doc.evidence) {
      const id = idsIn(evidence.uri), key = id ? `${id}\0${evidence.revisionId}` : '';
      const source = key ? resolved.get(key) : undefined;
      if (!source) add(doc, 'unresolved_or_inaccessible_evidence');
      else if (evidence.span && !spanExists(source.body, evidence.span)) add(doc, 'evidence_span_not_found');
    }
    const oversizedBody = bodyTooLarge(doc.body);
    if (oversizedBody && doc.kind === 'wiki_page') add(doc, 'page_too_large_for_body_checks');
    const body = oversizedBody ? '' : stripCode(doc.body);
    if (!oversizedBody) for (const linkTitle of wikiLinks(body)) {
      const title = normalizeTitle(linkTitle); if (!(titleMap.get(title)?.length)) add(doc, 'broken_wikilink');
    }
    if (!oversizedBody) for (const reference of mdbReferences(body)) if (!referenceExists(reference)) add(doc, 'dangling_reference');
    for (const link of doc.links) if (!referenceExists(link.target)) add(doc, 'dangling_reference');
    if (doc.kind === 'wiki_page') {
      if (!oversizedBody && !stripHeadings(doc.body).trim()) add(doc, 'empty_page');
      if (!oversizedBody && doc.evidence.length && !lintCitations(doc.body, doc.evidence.length).ok) add(doc, 'uncited_claim');
      if (!inbound.has(doc.id) && !isIndex(doc)) add(doc, 'orphan_page');

      const sourceRefs = collectSourceRefs(doc);
      for (const ref of sourceRefs) {
        const id = idsIn(ref.uri); if (!id) { add(doc, 'dangling_reference'); continue; }
        const current = heads.get(id);
        if (!current) continue; // inaccessible and missing are deliberately indistinguishable
        if (!isActive(current)) add(doc, 'source_deleted');
        else if (ref.revisionId && current.revisionId !== ref.revisionId) add(doc, 'stale_source');
      }
    }
  }

  const tagGroups = new Map<string, Set<string>>();
  for (const doc of selectedPages) for (const tag of doc.tags) {
    const key = normalizeTag(tag); if (key) { const spellings = tagGroups.get(key) ?? new Set<string>(); spellings.add(tag); tagGroups.set(key, spellings); }
  }
  for (const doc of selectedPages) if (doc.tags.some(tag => (tagGroups.get(normalizeTag(tag))?.size ?? 0) > 1)) add(doc, 'tag_inconsistency');

  const byCode: WikiLintResult['summary']['byCode'] = {}; const bySeverity: WikiLintResult['summary']['bySeverity'] = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) { byCode[issue.issue] = (byCode[issue.issue] ?? 0) + 1; bySeverity[issue.severity]++; }
  const requested = options.limit ?? 1000; const limit = Math.max(0, Math.min(10000, Number.isFinite(requested) ? Math.floor(requested) : 1000));
  return { checked: docs.length, issues: issues.slice(0, limit), semanticTruthVerified: false, summary: { byCode, bySeverity }, truncated: issues.length > limit };
}

function scopeKey(scope: Scope): string { return scope.type === 'global' ? `g:${scope.area}` : `w:${scope.workspaceId}:${scope.collectionId ?? ''}`; }
function spanExists(body: string, span: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
  const source = normalize(body), needle = normalize(span); if (needle.length < 4) return false;
  const word = /[\p{L}\p{N}_]/u; let from = 0;
  while (true) {
    const at = source.indexOf(needle, from); if (at < 0) return false;
    const before = at > 0 ? source[at - 1] : undefined, after = source[at + needle.length];
    if ((!before || !word.test(before)) && (!after || !word.test(after))) return true;
    from = at + 1;
  }
}
function stripHeadings(body: string): string { return body.split('\n').filter(line => !/^\s{0,3}#{1,6}(?:\s|$)/u.test(line)).join('\n'); }
function collectSourceRefs(doc: Document): Evidence[] {
  const refs: Evidence[] = doc.links.filter(link => link.type === 'derived_from' && link.revisionId).map(link => ({ uri: link.target, revisionId: link.revisionId! }));
  for (const key of ['compiledFrom', 'sourceIds']) {
    const values = doc.metadata[key]; if (!Array.isArray(values)) continue;
    for (const item of values) {
      if (typeof item === 'string' && key === 'sourceIds') refs.push({ uri: `mdb://objects/${item}`, revisionId: '' });
      else if (item && typeof item === 'object') {
        const row = item as Record<string, unknown>; const uri = typeof row.uri === 'string' ? row.uri : typeof row.id === 'string' ? `mdb://objects/${row.id}` : undefined;
        if (uri) refs.push({ uri, revisionId: typeof row.revisionId === 'string' ? row.revisionId : '' });
      }
    }
  }
  return refs;
}
