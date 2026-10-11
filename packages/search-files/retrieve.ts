import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { profileAsync, profileBytes, profileSample } from '../bench/instrumentation.js';
import type { ActorContext, Document, SearchInput, SearchResult } from '../core/types.js';
import { MDBError } from '../core/types.js';
import { compareSearchHits, finishSearch, keywordGroups, mapBodyLines, prepareSearch, scopeMatches, type SearchVault } from './index.js';
import { manifestFor, type Manifest, type ManifestEntry } from './manifest.js';
import { fsIndexLookup, fsIndexServes } from './postings.js';

export interface IndexInfo { /** reading stopped before all candidates were read because none could change the page */ stoppedEarly?: boolean; entries: number; candidates: number; loaded: number; candidateFilesExamined?: number; candidateFilesMatched?: number; ripgrepProcesses?: number; lagObjects?: number; fallbackScopes?: number; textPrefilter: 'none' | 'ripgrep' | 'file-scan' | 'fts5+trigram' | 'fs-trigram' | 'mixed'; autoSynced?: boolean }
export interface PrefilterContext { vault: SearchVault; manifest: Manifest; entries: ManifestEntry[]; input: SearchInput; actor: ActorContext }
/** A prefilter returns a SUPERSET of the entries that can match (undefined = no narrowing). Final matching is always the shared scorer on authorized documents. */
export type Prefilter = (ctx: PrefilterContext) => Promise<{ ids?: Set<string>; fallback?: string; backend?: string; info?: Partial<IndexInfo>;
  /** keyword relevance for EVERY id in `ids` (higher is better), e.g. SQLite FTS5 BM25; absent means the built-in lexical scorer ranks */ ranks?: Map<string, number> }>;

export function assertSearchIdentity(vault: SearchVault, input: SearchInput, actor: ActorContext): void {
  if (input.includeHistory && !actor.permissions.includes('*') && !actor.permissions.includes('history:read')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'History search requires history:read permission');
  if (actor.actorId !== vault.actor.actorId || actor.permissions.some(permission => !vault.actor.permissions.includes('*') && !vault.actor.permissions.includes(permission))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Search identity must match the trusted vault identity');
}

export const metadataMatches = (input: SearchInput, e: { kind: string; tags: string[]; status: string; updated: string }): boolean =>
  e.status !== 'deleted' && e.status !== 'tombstone' && (!input.kinds?.length || input.kinds.includes(e.kind)) && (!input.tags?.length || input.tags.every(tag => e.tags.includes(tag))) && (!input.since || e.updated >= input.since) && (!input.until || e.updated <= input.until);


/**
 * Conservative narrowing for a regular expression: one literal that every match of each top-level alternative must contain, or undefined when any
 * alternative has none of at least 3 characters (then nothing can be narrowed). Only plain printable-ASCII runs are used, lower-cased, so the result is
 * a superset under the engine's case-insensitive, non-unicode RegExp. Groups, classes, counted repeats and anything unfamiliar give up; a character
 * followed by ? or * is optional and never part of a literal.
 */
export function regexRequiredLiterals(source: string): string[] | undefined {
  const branches: string[][] = [[]]; let run = '';
  const endRun = () => { if (run) branches[branches.length - 1]!.push(run); run = ''; };
  let i = 0; const skipQuantifiers = () => { while (source[i + 1] === '?' || source[i + 1] === '*' || source[i + 1] === '+') i++; };
  for (; i < source.length; i++) {
    let ch = source[i]!; let literal = false;
    if (ch === '\\') { const next = source[++i]; if (next === undefined) return undefined; if (/[^A-Za-z0-9]/.test(next) && next >= ' ' && next <= '~') { ch = next; literal = true; } else if (/[dDwWsSbB]/.test(next)) { endRun(); skipQuantifiers(); continue; } else return undefined; }
    else if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}') return undefined;
    else if (ch === '|') { endRun(); branches.push([]); continue; }
    else if (ch === '.' || ch === '^' || ch === '$') { endRun(); skipQuantifiers(); continue; }
    else if (ch === '?' || ch === '*' || ch === '+') return undefined; // a quantifier with no atom, or one we did not consume below
    else literal = ch >= ' ' && ch <= '~';
    const quantifier = source[i + 1];
    if (quantifier === '?' || quantifier === '*') { endRun(); i++; if (source[i + 1] === '?') i++; continue; } // optional atom: contributes nothing
    if (!literal) { endRun(); continue; }
    run += ch.toLowerCase();
    if (quantifier === '+') { endRun(); i++; if (source[i + 1] === '?') i++; }
  }
  endRun();
  const result: string[] = [];
  for (const runs of branches) { const best = runs.reduce((a, b) => b.length > a.length ? b : a, ''); if (best.length < 3 || best.includes('\n')) return undefined; result.push(best); }
  return [...new Set(result)];
}
/** Terms a document must contain (per OR-group) to possibly match; undefined when the query cannot be narrowed by substring (regex, negative-only, multi-line). */
export interface TextSpec { groups: string[][]; caseSensitive: boolean }
export function textSpec(input: SearchInput): TextSpec | undefined {
  if (!input.query.trim()) return undefined;
  const grep = (input.mode ?? 'auto') === 'grep';
  if (grep && input.regex) { const branches = regexRequiredLiterals(input.query); return branches ? { groups: branches.map(literal => [literal]), caseSensitive: false } : undefined; }
  const caseSensitive = !!input.caseSensitive && grep;
  let groups: string[][];
  if (grep) groups = [[caseSensitive ? input.query : input.query.toLocaleLowerCase()]];
  else { const parsed = keywordGroups(input.query); if (!parsed.length || parsed.some(group => !group.some(term => !term.negate))) return undefined; groups = parsed.map(group => group.filter(term => !term.negate).map(term => term.text)); }
  if (groups.some(group => group.some(term => !term || term.includes('\n')))) return undefined;
  return { groups, caseSensitive };
}
export const distinctTerms = (spec: TextSpec): string[] => [...new Set(spec.groups.flat())];
/** Combines per-term id sets: AND inside a group, OR across groups. */
export function combine(spec: TextSpec, byTerm: Map<string, Set<string>>): Set<string> {
  const result = new Set<string>();
  for (const group of spec.groups) {
    let current: Set<string> | undefined;
    for (const term of group) { const ids = byTerm.get(term) ?? new Set<string>(); current = current ? new Set([...current].filter(id => ids.has(id))) : new Set(ids); }
    for (const id of current ?? []) result.add(id);
  }
  return result;
}
export const titleMatches = (entries: ManifestEntry[], term: string, caseSensitive: boolean): Set<string> => new Set(entries.filter(e => (caseSensitive ? e.title : e.title.toLocaleLowerCase()).includes(term)).map(e => e.id));

const revisionFile = (e: { id: string; rev: string }) => `.mdb/objects/${e.id}/revs/${e.rev}.md`;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Reads each candidate's head revision file once and reports which terms occur in its raw text (frontmatter + verbatim body). */
export async function scanFiles(root: string, entries: ManifestEntry[], spec: TextSpec): Promise<Map<string, Set<string>>> {
  const terms = distinctTerms(spec); const byTerm = new Map<string, Set<string>>(terms.map(t => [t, new Set<string>()]));
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < entries.length; i = next++) {
      const e = entries[i]!; if (!SAFE_ID.test(e.id) || !SAFE_ID.test(e.rev)) { for (const term of terms) byTerm.get(term)!.add(e.id); continue; }
      let raw: string; try { raw = await readFile(path.join(root, revisionFile(e)), 'utf8'); profileBytes('candidate.discovery.read', Buffer.byteLength(raw)); } catch { for (const term of terms) byTerm.get(term)!.add(e.id); continue; /* cannot rule it out: the authorized read decides */ }
      const haystack = spec.caseSensitive ? raw : raw.toLocaleLowerCase();
      for (const term of terms) if (haystack.includes(term)) byTerm.get(term)!.add(e.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(48, Math.max(1, entries.length)) }, worker));
  return byTerm;
}

let rgChecked: boolean | undefined;
export const ripgrepAvailable = (): boolean => { if (process.env.MDB_NO_RIPGREP === '1') return false; rgChecked ??= spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0; return rgChecked; };
/** ripgrep folds case with Unicode simple folding; JavaScript lower-casing differs for a few special-casing characters, so only plain printable ASCII terms use it. */
const rgSafe = (term: string) => /^[\x20-\x7e]+$/.test(term);
interface RipgrepResult { lines: string[]; filesSearched: number; filesWithMatches: number }
const rg = (root: string, args: string[]): Promise<RipgrepResult> => new Promise((resolve, reject) => {
  const profiled = process.env.MDB_BENCH_PROFILE === '1';
  const separator = args.indexOf('--');
  const argv = profiled && separator >= 0 ? [...args.slice(0, separator), '--stats', ...args.slice(separator)] : profiled ? [...args, '--stats'] : args;
  const started = performance.now(); let spawnedAt: number | undefined; const chunks: Buffer[] = []; let outputBytes = 0, outputTooLarge = false;
  const child = spawn('rg', argv, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  child.once('spawn', () => { spawnedAt = performance.now(); profileSample('candidate.discovery.rg.spawn_wait', spawnedAt - started); });
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > 512 * 1024 * 1024) { outputTooLarge = true; chunks.length = 0; child.kill(); return; }
    chunks.push(chunk);
  });
  child.once('error', reject);
  child.once('close', (code, signal) => {
    const closedAt = performance.now();
    if (spawnedAt !== undefined) profileSample('candidate.discovery.rg.search_traversal_and_output', closedAt - spawnedAt);
    profileBytes('candidate.discovery.rg.stdout', outputBytes);
    if (outputTooLarge) { reject(new Error('rg output exceeded 512 MiB')); return; }
    if (code !== 0 && code !== 1) { reject(new Error(`rg failed (${signal ?? code})`)); return; }
    const parseStart = performance.now(); const stdout = Buffer.concat(chunks).toString('utf8');
    let filesSearched = 0, filesWithMatches = 0; let text = stdout;
    if (profiled) {
      const searched = stdout.match(/(?:^|\n)(\d+) files searched\n/); const matched = stdout.match(/(?:^|\n)(\d+) files contained matches\n/);
      filesSearched = Number(searched?.[1] ?? 0); filesWithMatches = Number(matched?.[1] ?? 0);
      const statsStart = stdout.search(/\n\d+ matches\n/); if (statsStart >= 0) text = stdout.slice(0, statsStart + 1);
    }
    const lines = text.split('\n').filter(Boolean);
    profileSample('candidate.discovery.rg.output_processing', performance.now() - parseStart);
    resolve({ lines, filesSearched, filesWithMatches });
  });
});

function pathBatches(paths: string[]): string[][] {
  // Keep every child below conservative exec argument limits, including environments with a large inherited env.
  const maxBytes = process.platform === 'win32' ? 16_000 : 128_000;
  const batches: string[][] = []; let batch: string[] = [], bytes = 0;
  for (const file of paths) {
    if (!SAFE_ID.test(file.split('/')[2] ?? '') || !SAFE_ID.test(file.split('/')[4]?.replace(/\.md$/, '') ?? '')) throw new Error('Unsafe revision path in search manifest');
    const size = Buffer.byteLength(file) + 1;
    if (batch.length && bytes + size > maxBytes) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(file); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function ripgrepFiles(root: string, entries: ManifestEntry[], spec: TextSpec): Promise<{ byTerm: Map<string, Set<string>>; filesExamined: number; filesMatched: number; processCount: number }> {
  const head = new Map(entries.map(e => [revisionFile(e), e.id]));
  const byTerm = new Map<string, Set<string>>(); let filesExamined = 0, filesMatched = 0;
  const batches = pathBatches([...head.keys()]);
  await Promise.all(distinctTerms(spec).map(async term => {
    const found = await Promise.all(batches.map(targets => profileAsync('candidate.discovery.ripgrep', () => rg(root, ['-l', '-F', spec.caseSensitive ? '-s' : '-i', '--no-messages', '--no-config', '--hidden', '--no-ignore', '--glob', '*.md', '-e', term, '--', ...targets]))));
    filesExamined += found.reduce((sum, result) => sum + result.filesSearched, 0); filesMatched += found.reduce((sum, result) => sum + result.filesWithMatches, 0);
    byTerm.set(term, new Set(found.flatMap(result => result.lines).map(line => head.get(line)).filter((id): id is string => !!id)));
  }));
  // Per-term counts are intentionally additive: each distinct search term scans the candidate set separately.
  return { byTerm, filesExamined, filesMatched, processCount: batches.length * distinctTerms(spec).length };
}

async function* documentBatches(vault: SearchVault, entries: ManifestEntry[], batchSize = 48): AsyncGenerator<Document[]> {
  for (let start = 0; start < entries.length; start += batchSize) {
    const docs = await Promise.all(entries.slice(start, start + batchSize).map(async entry => {
      try {
        const doc = await vault.get(entry.id);
        // An index candidate may have changed since discovery. Search the Vault's current, authorized revision.
        return doc;
      } catch { return undefined; /* purged, or no longer readable: never returned */ }
    }));
    yield docs.filter((doc): doc is Document => !!doc);
  }
}

/**
 * Index-backed retrieval pipeline shared by the filesystem and SQLite engines:
 *   journal catch-up -> readable scopes -> metadata filter -> text prefilter (superset) -> load survivors through Vault.get -> shared scorer.
 * Authorization is evaluated per query from the live ACL files, before any candidate is read, and again by Vault.get for every document returned.
 */
export async function retrieve(vault: SearchVault, input: SearchInput, actor: ActorContext, prefilter: Prefilter, backend: string): Promise<SearchResult & { index?: IndexInfo }> {
  assertSearchIdentity(vault, input, actor);
  const scorer = prepareSearch(input); // validates mode, limit, cursor and regex safety before any work
  if (!input.query.trim()) return finishSearch([], input, backend, scorer.mode, 0);
  const manifest = await manifestFor(vault);
  await manifest.sync();
  const allowed = await manifest.readableScopes();
  const filters = input.scopes?.length ? input.scopes : undefined;
  const entries: ManifestEntry[] = [];
  for (const sk of allowed) for (const id of manifest.byScope.get(sk) ?? []) { const e = manifest.entries.get(id)!; if ((!filters || filters.some(scope => scopeMatches(e.scope, scope))) && metadataMatches(input, e)) entries.push(e); }
  const narrowed = await profileAsync('search.candidate_discovery', () => prefilter({ vault, manifest, entries, input, actor }));
  const candidates = narrowed.ids ? entries.filter(e => narrowed.ids!.has(e.id)) : entries;
  const limit = input.limit ?? 20, offset = Number(input.cursor ?? '0');
  // One more than the page is kept so "is there a next page" is known exactly (the extra hit is a real match).
  const retain = Math.min(candidates.length, offset + limit + 1);
  const top: SearchResult['hits'] = []; let matchedCount = 0, loadedCount = 0, stoppedEarly = false;
  if (offset < candidates.length) {
    // Bounded evaluation: read candidates best-bound-first and stop as soon as no unread candidate can enter the retained set. The bound is exact for the
    // title part of the score (from the manifest) and the maximum for the body part, so the answer is identical to scoring everything; it only avoids reads.
    const ranked = scorer.mode === 'keyword' && narrowed.ranks && candidates.every(e => narrowed.ranks!.has(e.id)) ? narrowed.ranks : undefined; // complete index ranks replace the lexical score
    const bound = new Map<string, number>(); for (const e of candidates) bound.set(e.id, ranked ? ranked.get(e.id)! : scorer.upperBound(e.title));
    const ordered = [...candidates].sort((a, b) => bound.get(b.id)! - bound.get(a.id)! || a.id.localeCompare(b.id));
    const batchSize = ordered.length > 4 * retain ? 16 : 48; let consumed = 0, violated = false;
    for await (const batch of documentBatches(vault, ordered, batchSize)) {
      consumed += batch.length;
      const documents = batch.filter(doc => doc.status !== 'deleted' && doc.status !== 'tombstone'
        && (!filters || filters.some(scope => scopeMatches(doc.scope, scope)))
        && (!input.kinds?.length || input.kinds.includes(doc.kind)) && (!input.tags?.length || input.tags.every(tag => doc.tags.includes(tag)))
        && (!input.since || doc.updatedAt >= input.since) && (!input.until || doc.updatedAt <= input.until));
      loadedCount += documents.length;
      await profileAsync('result.line_mapping', () => mapBodyLines(vault, documents));
      await profileAsync('result.materialization', async () => {
        for (const doc of documents) {
          const hit = scorer.score(doc); if (!hit) continue; matchedCount++;
          if (ranked) { hit.score = ranked.get(doc.id) ?? hit.score; hit.retrievalMode = 'keyword'; }
          if (hit.score > (bound.get(doc.id) ?? Infinity)) violated = true; // the document changed since the manifest was read: the bound no longer protects this run
          if (retain === 0) continue;
          let low = 0, high = top.length;
          while (low < high) { const middle = (low + high) >>> 1; if (compareSearchHits(top[middle]!, hit) <= 0) low = middle + 1; else high = middle; }
          top.splice(low, 0, hit); if (top.length > retain) top.pop();
        }
      });
      const next = ordered[consumed];
      if (next && !violated && top.length >= retain) {
        const kth = top[retain - 1]!, nb = bound.get(next.id)!;
        if (nb < kth.score || (nb === kth.score && next.id.localeCompare(kth.objectId) > 0)) { stoppedEarly = true; break; }
      }
    }
  }
  const result = finishSearch(top, input, narrowed.backend ?? backend, scorer.mode, stoppedEarly ? top.length : matchedCount);
  const usedRanks = scorer.mode === 'keyword' && !!narrowed.ranks && candidates.every(e => narrowed.ranks!.has(e.id));
  return { ...result, ranking: usedRanks ? 'bm25' : 'lexical', ...(narrowed.fallback ? { fallback: narrowed.fallback } : {}), index: { entries: entries.length, candidates: candidates.length, loaded: loadedCount, ...(stoppedEarly ? { stoppedEarly: true } : {}), textPrefilter: 'none', ...narrowed.info } };
}

/** Filesystem-only prefilter: manifest titles plus ripgrep (owner, plain ASCII terms) or a raw-file scan restricted to authorized head revisions. */
export const filesPrefilter: Prefilter = async ({ vault, entries, input, actor }) => {
  const spec = textSpec(input);
  if (!spec) return { info: { textPrefilter: 'none' } };
  const owner = actor.permissions.includes('*');
  const terms = distinctTerms(spec);
  // Persistent trigram index (built by `index rebuild` in filesystem-only mode). Absent or damaged: fall through to ripgrep / file scan and say why.
  let indexNote: string | undefined;
  if (fsIndexServes(terms)) {
    try {
      const found = await profileAsync('candidate.discovery.fs_trigram', () => fsIndexLookup(vault.root, entries, terms, spec.caseSensitive));
      for (const term of terms) { const titles = titleMatches(entries, term, spec.caseSensitive); const set = found.byTerm.get(term) ?? new Set<string>(); for (const id of titles) set.add(id); found.byTerm.set(term, set); }
      return { ids: combine(spec, found.byTerm), info: { textPrefilter: 'fs-trigram', lagObjects: found.stale } };
    } catch (error) { if (!(error instanceof MDBError && error.code === 'CAPABILITY_UNAVAILABLE')) indexNote = `filesystem trigram index unusable (${error instanceof Error ? error.message : String(error)}); scanned files instead`; }
  }
  let useRg = owner && ripgrepAvailable() && terms.every(rgSafe);
  let byTerm: Map<string, Set<string>>;
  let rgInfo: Partial<IndexInfo> = {};
  if (useRg) {
    try { const result = await ripgrepFiles(vault.root, entries, spec); byTerm = result.byTerm; rgInfo = { candidateFilesExamined: result.filesExamined, candidateFilesMatched: result.filesMatched, ripgrepProcesses: result.processCount }; }
    catch { useRg = false; byTerm = await scanFiles(vault.root, entries, spec); }
  } else byTerm = await scanFiles(vault.root, entries, spec);
  for (const term of terms) { const titles = titleMatches(entries, term, spec.caseSensitive); const set = byTerm.get(term) ?? new Set<string>(); for (const id of titles) set.add(id); byTerm.set(term, set); }
  return { ids: combine(spec, byTerm), ...(indexNote ? { fallback: indexNote } : {}), info: { textPrefilter: useRg ? 'ripgrep' : 'file-scan', ...rgInfo } };
};
