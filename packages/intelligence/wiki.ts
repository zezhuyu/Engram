import { MDBError, type Document, type ModelProposal, type Relation, type Scope } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { manifestFor } from '../search-files/manifest.js';
import { SearchEngine } from '../search-sqlite/index.js';
import { loadDocuments, scopeEqual } from './corpus.js';

/** A claim paragraph either cites evidence as [n] (n = position in the proposal's evidence list) or says plainly that it is an inference. */
export const UNCITED_OK = /\((?:inference|unsupported|hypothesis|speculation)\)/i;
export function lintCitations(body: string, evidenceCount: number): { ok: boolean; problems: string[] } {
  const problems: string[] = []; let claims = 0;
  const check = (text: string) => {
    if (text.length < 30 || /^[-*_=\s]+$/.test(text) || /\?\s*$/.test(text)) return; // fragments, rules and open questions carry no claim
    claims++;
    const marks = [...text.matchAll(/\[(\d{1,3})\]/g)].map(m => Number(m[1]));
    const bad = marks.filter(n => n < 1 || n > evidenceCount);
    if (bad.length) problems.push(`citation [${bad[0]}] does not refer to an evidence entry (1..${evidenceCount}): "${text.slice(0, 50)}…"`);
    else if (!marks.length && !UNCITED_OK.test(text)) problems.push(`uncited claim: "${text.slice(0, 60)}…"`);
  };
  for (const block of body.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)) {
    const lines = block.split('\n').filter(line => !/^\s*#{1,6}\s/.test(line)).map(l => l.trim()).filter(Boolean);
    const isList = lines.length > 0 && lines.every(l => /^([-*+]|\d+[.)])\s/.test(l));
    if (isList) for (const item of lines) check(item.replace(/^([-*+]|\d+[.)])\s+/, '')); // each list item is its own statement
    else check(lines.join('\n'));
  }
  if (!claims) problems.push('no substantive content to cite');
  return { ok: problems.length === 0, problems };
}

/** Distinctive words of the new sources, used only to find candidate pages; the dependency graph is the primary signal. */
function topicTerms(sources: Document[]): string[] {
  const counts = new Map<string, number>();
  for (const source of sources) for (const word of `${source.title} ${source.title} ${source.body.slice(0, 600)}`.toLowerCase().match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1);
  const stop = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'were', 'will', 'which', 'their', 'there', 'about', 'would', 'could', 'should', 'into', 'also', 'than', 'then', 'when', 'what', 'these', 'those']);
  return [...counts.entries()].filter(([w]) => !stop.has(w)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([w]) => w);
}
/**
 * Pages that a new or changed source may affect, found without reading the wiki: pages that already derive from the source (dependency edges, indexed by the
 * manifest) first, then the best keyword matches. Bounded, authorized and limited to the compile scope, so one import never rewrites the whole wiki.
 */
export async function affectedPages(vault: Vault, scope: Scope, sources: Document[], limit = 3): Promise<Document[]> {
  const manifest = await manifestFor(vault); await manifest.sync(); const readable = await manifest.readableScopes();
  const ids: string[] = [];
  for (const source of sources) for (const key of [source.uri, source.id]) for (const id of manifest.referencedBy.get(key) ?? []) {
    const e = manifest.entries.get(id); if (e && e.kind === 'wiki_page' && readable.has(e.sk) && scopeEqual(e.scope, scope) && e.status !== 'deleted' && !ids.includes(id)) ids.push(id);
  }
  const terms = topicTerms(sources);
  if (terms.length && ids.length < limit) {
    const result = await new SearchEngine(vault).query({ query: terms.join(' OR '), mode: 'keyword', kinds: ['wiki_page'], scopes: [scope], limit: 10 });
    for (const hit of result.hits) if (!ids.includes(hit.objectId)) ids.push(hit.objectId);
  }
  return loadDocuments(vault, ids.slice(0, limit).map(id => manifest.entries.get(id)!).filter(Boolean));
}

/** Validates a compile proposal against what the model was actually shown, and derives the dependency edges deterministically (never from model text). */
export function wikiEnrich(output: ModelProposal, supplied: Document[]): { links: Relation[]; metadata: Record<string, unknown> } {
  const byUri = new Map(supplied.map(d => [d.uri, d]));
  let page: Document | undefined;
  const target = output.metadata?.targetPageId;
  if (target !== undefined) {
    page = supplied.find(d => d.id === target && d.kind === 'wiki_page');
    if (!page) throw new MDBError('INVALID_MODEL_OUTPUT', 'The model targeted a page that was not supplied');
  }
  const sources = [...new Map(output.evidence.map(e => byUri.get(e.uri)).filter((d): d is Document => !!d && d.kind !== 'wiki_page' && d.id !== page?.id).map(d => [d.id, d])).values()];
  if (!sources.length) throw new MDBError('INVALID_MODEL_OUTPUT', 'A wiki page must cite at least one source document');
  return {
    links: sources.map(d => ({ type: 'derived_from', target: d.uri, revisionId: d.revisionId })),
    metadata: { sourceIds: sources.map(d => d.id), compiledFrom: sources.map(d => ({ uri: d.uri, revisionId: d.revisionId })), ...(page ? { targetPageId: page.id, targetRevisionId: page.revisionId } : {}) }
  };
}

/** Keeps every earlier dependency and citation when a page gains a revision, and appends new ones once. */
export const mergeLinks = (old: Relation[], added: Relation[]): Relation[] => { const seen = new Set(old.map(l => `${l.type}\0${l.target}\0${l.revisionId ?? ''}`)); return [...old, ...added.filter(l => !seen.has(`${l.type}\0${l.target}\0${l.revisionId ?? ''}`))]; };
