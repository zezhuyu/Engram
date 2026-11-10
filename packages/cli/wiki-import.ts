import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import type { Vault } from '../core/vault.js';
import type { Document, Scope } from '../core/types.js';
import { MDBError } from '../core/types.js';

type Item = { path: string; absolute: string; bytes: Buffer; hash: string };
type Options = { from: string; raw?: string; workspace?: string; target?: 'workspace' | 'wiki'; namespace?: string; wikiCollection?: string; sourcesCollection?: string; label?: string; dryRun?: boolean; verify?: boolean; maxBytes?: number; progress?: (text: string) => void; limitedWikiLinks?: boolean };
type Relation = { type: string; target: string; revisionId?: string };
type ParsedPage = { value: Record<string, unknown>; body: string; raw?: string; error?: string };
export type WikiImportReport = { target: 'workspace' | 'wiki'; workspace?: string; namespace?: string; pages: { imported: number; unchanged: number; updated: number; relinked: number; 'stale-links': unknown[]; warnings: unknown[]; skipped: unknown[]; errors: unknown[] }; sources: { imported: number; unchanged: number; updated: number; skipped: unknown[]; errors: unknown[] }; verification: { pageHashes: Array<{ path: string; sourceSha256: string; storedSha256?: string }>; sourceHashes: Array<{ path: string; sourceSha256: string; storedOriginalSha256?: string }> }; citations: { resolved: number; unresolved: unknown[] }; wikiLinks: { resolved: number; unresolved: unknown[]; ambiguous: number; placeholders: number }; redactions: number; durationMs: number };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const within = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
const frontmatterMatch = (text: string) => /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);

async function files(root: string, suffix?: string, maxSize?: number): Promise<{ items: Item[]; skipped: Array<{path:string;reason:string}> }> {
  const base = await fs.realpath(root), out: Item[] = [], skipped: Array<{path:string;reason:string}> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) { skipped.push({ path: path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/'), reason: 'dotfile or dot-directory' }); continue; }
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { skipped.push({ path: path.relative(base, absolute).split(path.sep).join('/'), reason: 'symlink' }); continue; }
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile() || (suffix && !entry.name.toLowerCase().endsWith(suffix))) continue;
      const real = await fs.realpath(absolute); if (!within(base, real)) throw new MDBError('INVALID_INPUT', `Path escapes import root: ${path.relative(base, absolute)}`);
      const info = await fs.stat(real);
      if (maxSize !== undefined && info.size > maxSize) { skipped.push({ path: path.relative(base, absolute).split(path.sep).join('/'), reason: `over size cap (${maxSize} bytes)` }); continue; }
      const bytes = await fs.readFile(real); out.push({ path: path.relative(base, absolute).split(path.sep).join('/'), absolute: real, bytes, hash: hash(bytes) });
    }
  };
  await walk(base); return { items: out, skipped };
}
function frontmatter(text: string): ParsedPage {
  const match = frontmatterMatch(text);
  if (!match) return { value: {}, body: text };
  const raw = match[1]!;
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('frontmatter exceeds 1 MiB limit');
  try {
    const parsed: unknown = YAML.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('frontmatter must be a YAML mapping');
    return { value: parsed as Record<string, unknown>, body: text.slice(match[0].length), raw };
  } catch (error) {
    return { value: {}, body: text, raw, error: (error as Error).message.slice(0, 1000) };
  }
}
function strings(value: unknown): string[] { if (Array.isArray(value)) return value.flatMap(strings); if (typeof value !== 'string') return []; return value.split(',').map(s=>s.trim()).filter(Boolean); }
function titleOf(meta: Record<string, unknown>, body: string, file: string): string { return (typeof meta.title === 'string' && meta.title.trim()) || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || path.basename(file, path.extname(file)); }
function safeScope(workspaceId: string, collectionId: string): Scope { return { type: 'workspace', workspaceId, collectionId }; }
function isBinary(bytes: Buffer): boolean { return bytes.includes(0) || bytes.toString('utf8').includes('\uFFFD'); }
function canonicalLink(raw: string): { target: string; placeholder: boolean } {
  const value = raw.trim().replace(/^!/, '').split('|', 1)[0]!.trim();
  const withoutAnchor = value.split('#', 1)[0]!.trim().replace(/^\/+/, '').replace(/\\/g, '/');
  return { target: withoutAnchor, placeholder: /[<>]/.test(withoutAnchor) || withoutAnchor.toLowerCase() === 'wikilink' };
}
function sameRelations(a: Relation[], b: Relation[]): boolean {
  const key = (r: Relation) => `${r.type}\0${r.target}\0${r.revisionId ?? ''}`;
  return a.map(key).sort().join('\n') === b.map(key).sort().join('\n');
}

export async function wikiImport(vault: Vault, options: Options): Promise<WikiImportReport> {
  const target = options.target ?? 'workspace';
  if (target === 'workspace' && !options.workspace) throw new MDBError('INVALID_INPUT', 'Workspace imports require a workspace name');
  if (target === 'wiki' && (!options.namespace || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.namespace))) throw new MDBError('INVALID_INPUT', 'Global wiki imports require a lowercase --namespace slug');
  const namespace = target === 'wiki' ? options.namespace! : undefined;
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) throw new MDBError('INVALID_INPUT', 'Maximum import size must be a positive safe integer');
  const started = Date.now(), wikiRoot = path.resolve(options.from), rawRoot = options.raw ? path.resolve(options.raw) : undefined;
  const wikiCollection = options.wikiCollection ?? 'wiki', sourcesCollection = options.sourcesCollection ?? 'sources';
  const pageScope: Scope = target === 'wiki' ? { type: 'global', area: 'wiki' } : safeScope(options.workspace!, wikiCollection), sourceScope: Scope = target === 'wiki' ? { type: 'global', area: 'wiki' } : safeScope(options.workspace!, sourcesCollection), wikiDirName = path.basename(wikiRoot).toLowerCase(), rawDirName = rawRoot ? path.basename(rawRoot) : undefined, projectDirName = path.basename(path.dirname(wikiRoot));
  const storedPath = (relative: string) => namespace ? `${namespace}/${relative}` : relative;
  const report: WikiImportReport = { target, ...(options.workspace ? { workspace: options.workspace } : {}), ...(namespace ? { namespace } : {}), pages: { imported: 0, unchanged: 0, updated: 0, relinked: 0, 'stale-links': [], warnings: [], skipped: [], errors: [] }, sources: { imported: 0, unchanged: 0, updated: 0, skipped: [], errors: [] }, verification: { pageHashes: [], sourceHashes: [] }, citations: { resolved: 0, unresolved: [] }, wikiLinks: { resolved: 0, unresolved: [], ambiguous: 0, placeholders: 0 }, redactions: 0, durationMs: 0 };
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const pageScan = await files(wikiRoot, '.md'), sourceScan = rawRoot ? await files(rawRoot, undefined, maxBytes) : { items: [], skipped: [] };
  const pageFiles = pageScan.items, sourceFiles = sourceScan.items;
  report.pages.skipped.push(...pageScan.skipped); report.sources.skipped.push(...sourceScan.skipped);
  const existingWs = target === 'workspace' ? (await vault.listWorkspaces()).find(w => w.id === options.workspace) : undefined;
  if (target === 'workspace' && !existingWs && !options.dryRun && !options.verify) await vault.createWorkspace(options.workspace!, `Imported wiki: ${options.label ?? options.workspace}`);
  if (target === 'workspace' && !options.dryRun && !options.verify) {
    const cols = existingWs ? await vault.listCollections(options.workspace!) : [];
    if (!cols.some(c=>c.id===wikiCollection)) await vault.createCollection(options.workspace!, wikiCollection, 'Imported wiki pages');
    if (!cols.some(c=>c.id===sourcesCollection)) await vault.createCollection(options.workspace!, sourcesCollection, 'Imported original sources');
  }
  const [docs] = await Promise.all([vault.listDocuments({ scopes: [pageScope, sourceScope] })]);
  const byKey = new Map<string,Document>(), byPath = new Map<string,Document>();
  for (const doc of docs) { if (typeof doc.metadata.importKey === 'string') byKey.set(doc.metadata.importKey, doc); if (typeof doc.metadata.importPath === 'string') byPath.set(`${doc.kind}:${doc.metadata.importPath}`, doc); }
  const sourceByPath = new Map<string,Document>(), pageByPath = new Map<string,Document>(), sourceByName = new Map<string,Document[]>();
  let count = 0;
  for (const item of sourceFiles) {
    count++; if (count % 25 === 0) options.progress?.(`wiki import: processed ${count} files`);
    const key = `source:${storedPath(item.path)}:${item.hash}`, previous = byKey.get(key), old = byPath.get(`source:${storedPath(item.path)}`);
    try {
      let doc = previous;
      if (options.verify && old) {
        const hashRecord: { path: string; sourceSha256: string; storedOriginalSha256?: string } = { path: item.path, sourceSha256: item.hash };
        if (old.metadata.importSha256 !== item.hash) report.sources.errors.push({ path: item.path, reason: 'source file hash mismatch' });
        try { const stored = await fs.readFile(path.join(vault.root, String(old.metadata.originalPath))); hashRecord.storedOriginalSha256 = hash(stored); if (hashRecord.storedOriginalSha256 !== item.hash) report.sources.errors.push({ path: item.path, reason: 'stored original bytes mismatch' }); }
        catch { report.sources.errors.push({ path: item.path, reason: 'stored original bytes missing' }); }
        report.verification.sourceHashes.push(hashRecord);
      }
      if (!doc && !options.dryRun && !options.verify) doc = await vault.ingest(item.absolute, sourceScope, { title: item.path, idempotencyKey: `wiki-import:${namespace ?? options.workspace}:${sourcesCollection}:${item.path}:${item.hash}`, metadata: { importKey: key, importPath: storedPath(item.path), ...(namespace ? { wikiNamespace: namespace, wikiOriginalPath: item.path } : {}), importSha256: item.hash, importLabel: options.label ?? '', importTime: new Date().toISOString() } });
      if (previous) report.sources.unchanged++; else if (old) report.sources.updated++; else report.sources.imported++;
      if (doc) { sourceByPath.set(item.path, doc); const names = sourceByName.get(path.basename(item.path).toLowerCase()) ?? []; names.push(doc); sourceByName.set(path.basename(item.path).toLowerCase(), names); }
    } catch (error) { report.sources.errors.push({ path: item.path, reason: (error as Error).message }); }
  }
  const pageInfo = new Map<string, { item: Item; parsed: ParsedPage; title: string; doc?: Document }>();
  for (const item of pageFiles) {
    try {
      if (isBinary(item.bytes)) { report.pages.skipped.push({ path: item.path, reason: 'non-UTF-8 page treated as binary source attachment' }); if (!options.dryRun && !options.verify) await vault.ingest(item.absolute, sourceScope, { title: item.path, metadata: { importKey: `binary-page:${storedPath(item.path)}:${item.hash}`, importPath: storedPath(item.path), ...(namespace ? { wikiNamespace: namespace, wikiOriginalPath: item.path } : {}), importSha256: item.hash } }); continue; }
      const text = item.bytes.toString('utf8'), parsed = frontmatter(text);
      const title = titleOf(parsed.error ? {} : parsed.value, parsed.error ? text : parsed.body, item.path);
      pageInfo.set(item.path, { item, parsed, title });
    } catch (error) { report.pages.errors.push({ path: item.path, reason: (error as Error).message }); }
  }
  const resolvePage = (rawLink: string): { doc?: Document; reason?: string; placeholder?: boolean; matched?: boolean } => {
    const { target, placeholder } = canonicalLink(rawLink);
    if (placeholder) return { reason: 'placeholder', placeholder: true };
    if (!target) return { reason: 'empty target' };
    const lower = target.toLowerCase();
    const candidates: string[] = [];
    const addPath = (value: string) => { const clean = value.replace(/^\.\//, ''), withoutExtension = clean.toLowerCase().endsWith('.md') ? clean.slice(0, -3) : clean; for (const candidate of [clean, `${withoutExtension}.md`]) if (!candidates.includes(candidate.toLowerCase())) candidates.push(candidate.toLowerCase()); };
    addPath(target);
    if (lower.startsWith(`${wikiDirName}/`)) addPath(target.slice(wikiDirName.length + 1));
    const pagesVariant = lower.startsWith('pages/') ? target : `pages/${target}`;
    addPath(pagesVariant);
    for (const candidate of candidates) {
      const exact = [...pageInfo.values()].filter(info => info.item.path.toLowerCase() === candidate);
      if (exact.length === 1) return { doc: exact[0]!.doc, matched: true };
      if (exact.length > 1) return { reason: 'ambiguous' };
    }
    if (!options.limitedWikiLinks) {
      const stem = path.posix.basename(target.replace(/\.md$/i, '')).toLowerCase();
      const stemMatches = [...pageInfo.values()].filter(info => path.posix.basename(info.item.path, path.posix.extname(info.item.path)).toLowerCase() === stem);
      if (stemMatches.length === 1) return { doc: stemMatches[0]!.doc, matched: true };
      if (stemMatches.length > 1) return { reason: 'ambiguous' };
      const titleMatches = [...pageInfo.values()].filter(info => info.title.toLowerCase() === target.toLowerCase());
      if (titleMatches.length === 1) return { doc: titleMatches[0]!.doc, matched: true };
      if (titleMatches.length > 1) return { reason: 'ambiguous' };
    }
    return { reason: 'unresolved' };
  };
  const resolveSource = (target: string): Document | undefined => {
    if (!rawDirName) return undefined;
    let relative: string | undefined;
    if (target.startsWith(`${rawDirName}/`)) relative = target.slice(rawDirName.length + 1);
    else if (target.startsWith(`${projectDirName}/${rawDirName}/`)) relative = target.slice(projectDirName.length + rawDirName.length + 2);
    if (!relative) return undefined;
    relative = relative.replace(/^\.\//, '').replace(/\\/g, '/');
    const withoutExtension = relative.toLowerCase().endsWith('.md') ? relative.slice(0, -3) : relative;
    const exact = [relative, `${withoutExtension}.md`].map(p => sourceByPath.get(p)).find(Boolean);
    if (exact) return exact;
    const stem = path.posix.basename(withoutExtension).toLowerCase();
    const matches = [...sourceByPath.entries()].filter(([sourcePath]) => path.posix.basename(sourcePath, path.posix.extname(sourcePath)).toLowerCase() === stem).map(([, doc]) => doc);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const citationRelationsByPath = new Map<string, Relation[]>();
  for (const [relPath, info] of pageInfo) {
    const { item, parsed, title } = info, key = `page:${storedPath(item.path)}:${item.hash}`, previous = byKey.get(key), old = byPath.get(`wiki_page:${storedPath(item.path)}`), isTemplate = item.path.split('/').includes('templates');
    const metadata = parsed.value;
    if (!options.verify && parsed.error) report.pages.warnings.push({ path: item.path, reason: parsed.error });
    const values = parsed.error ? [] : Array.isArray(metadata.sources) ? metadata.sources : metadata.sources !== undefined ? [metadata.sources] : metadata.source !== undefined ? [metadata.source] : [];
    const citationRelations: Relation[] = [];
    for (const citation of values) {
      if (typeof citation !== 'string' || /^https?:\/\//i.test(citation)) { report.citations.unresolved.push({ page: item.path, citation }); continue; }
      const rel = citation.replace(/^raw\//, ''), name = path.basename(rel).toLowerCase(), found = sourceByPath.get(rel) ?? (sourceByName.get(name)?.length === 1 ? sourceByName.get(name)![0] : undefined);
      if (found) { citationRelations.push({ type: 'references', target: found.uri, revisionId: found.revisionId }); report.citations.resolved++; }
      else report.citations.unresolved.push({ page: item.path, citation });
    }
    citationRelationsByPath.set(relPath, citationRelations);
    if (options.verify) {
      const hashRecord: { path: string; sourceSha256: string; storedSha256?: string } = { path: item.path, sourceSha256: item.hash };
      if (!old) { report.pages.imported++; report.pages.errors.push({ path: item.path, reason: 'page missing from vault' }); }
      else {
        hashRecord.storedSha256 = hash(Buffer.from(old.body));
        if (old.metadata.importSha256 !== item.hash || hashRecord.storedSha256 !== item.hash) { report.pages.updated++; report.pages.errors.push({ path: item.path, reason: 'page hash mismatch' }); }
        else { report.pages.unchanged++; info.doc = old; pageByPath.set(relPath, old); }
      }
      report.verification.pageHashes.push(hashRecord);
      continue;
    }
    if (previous) { report.pages.unchanged++; info.doc = previous; pageByPath.set(relPath, previous); continue; }
    const tagValues = parsed.error ? [] : strings(metadata.tags), category = parsed.error ? [] : strings(metadata.category);
    const modelCompiled = !parsed.error && (['generatedBy','generated_by','model','modelName','model_name'].some(key => typeof metadata[key] === 'string') || metadata.provenance === 'model');
    const input = { title, body: item.bytes.toString('utf8'), tags: [...tagValues, ...category.map(v=>`category:${v}`), ...(isTemplate ? ['template'] : []), ...(parsed.error ? ['unparsed-frontmatter'] : [])], status: !parsed.error && typeof metadata.status === 'string' ? metadata.status : target === 'wiki' ? (modelCompiled ? 'candidate' : 'accepted') : 'active', links: [...citationRelations, ...(old?.links.filter(link=>link.type==='wiki_link') ?? [])], metadata: { importKey: key, importPath: storedPath(item.path), ...(namespace ? { wikiNamespace: namespace, wikiOriginalPath: item.path, importProvenance: modelCompiled ? 'compiled-from-model' : 'owner-curated' } : {}), importSha256: item.hash, importLabel: options.label ?? '', originalFrontmatter: parsed.error ? {} : metadata, originalBody: parsed.error ? item.bytes.toString('utf8') : parsed.body, sourceReferences: values, wikiLinks: [...item.bytes.toString('utf8').matchAll(/!?\[\[([^\]]+)\]\]/g)].map(m=>m[1]!.trim()), importedAt: new Date().toISOString(), untrusted: true, ...(parsed.error ? { frontmatterError: parsed.error, rawFrontmatter: parsed.raw ?? '' } : {}), ...(!parsed.error && typeof metadata.type === 'string' ? { sourceType: metadata.type } : {}), ...(!parsed.error && typeof metadata.summary === 'string' ? { summary: metadata.summary } : {}), ...(!parsed.error && typeof metadata.language === 'string' ? { language: metadata.language } : {}), ...(!parsed.error && metadata.created !== undefined ? { sourceCreated: metadata.created } : {}), ...(!parsed.error && metadata.updated !== undefined ? { sourceUpdated: metadata.updated } : {}) } };
    try {
      const doc = !options.dryRun ? old ? await vault.patch({ objectId: old.id, expectedRevisionId: old.revisionId, title: input.title, body: input.body, tags: input.tags, status: input.status, links: input.links, metadataPatch: input.metadata }) : await vault.put({ scope: pageScope, kind: 'wiki_page', ...input }) : undefined;
      if (doc) { if (old) report.pages.updated++; else report.pages.imported++; info.doc = doc; pageByPath.set(item.path, doc); }
      else if (options.dryRun) { if (old) report.pages.updated++; else report.pages.imported++; }
    } catch (error) { report.pages.errors.push({ path: item.path, reason: (error as Error).message }); }
  }
  // Resolve links only after every page has a document identity, then patch only when its complete set changes.
  for (const [relPath, info] of pageInfo) {
    const doc = pageByPath.get(relPath); if (!doc && !options.dryRun && !options.verify) continue;
    const text = info.item.bytes.toString('utf8'), matches = [...text.matchAll(/!?\[\[([^\]]+)\]\]/g)], wikiRelations: Relation[] = [];
    for (const match of matches) {
      const rawLink = match[1]!.trim(), normalized = canonicalLink(rawLink);
      if (normalized.placeholder) { report.wikiLinks.placeholders++; report.wikiLinks.unresolved.push({ page: relPath, link: rawLink, reason: 'placeholder' }); continue; }
      if (rawDirName && (normalized.target.startsWith(`${rawDirName}/`) || normalized.target.startsWith(`${projectDirName}/${rawDirName}/`))) {
        const source = resolveSource(normalized.target);
        if (source) {
          const relation: Relation = { type: 'references', target: source.uri, revisionId: source.revisionId };
          if (!wikiRelations.some(item => item.target === relation.target) && !(citationRelationsByPath.get(relPath) ?? []).some(item => item.target === relation.target)) wikiRelations.push(relation);
          report.wikiLinks.resolved++;
          continue;
        }
        report.wikiLinks.unresolved.push({ page: relPath, link: rawLink, reason: 'source-not-imported' });
        continue;
      }
      const resolved = resolvePage(rawLink);
      if (!resolved.doc && resolved.matched) { report.wikiLinks.resolved++; continue; }
      if (!resolved.doc) { if (resolved.reason === 'ambiguous') report.wikiLinks.ambiguous++; report.wikiLinks.unresolved.push({ page: relPath, link: rawLink, reason: resolved.reason }); continue; }
      if (resolved.doc.id === doc?.id) { report.wikiLinks.resolved++; continue; }
      wikiRelations.push({ type: 'wiki_link', target: resolved.doc.uri }); report.wikiLinks.resolved++;
    }
    const citations = citationRelationsByPath.get(relPath) ?? [];
    const desired = [...citations, ...wikiRelations.filter((r, i, all) => all.findIndex(x => x.target === r.target) === i)];
    const current = (doc?.links ?? []).map(link => ({ type: link.type, target: link.target, ...(link.revisionId ? { revisionId: link.revisionId } : {}) }));
    if (options.verify) { if (!sameRelations(current, desired)) report.pages['stale-links'].push({ path: relPath, stored: current.filter(r=>r.type==='wiki_link').length, resolved: wikiRelations.length }); continue; }
    if (!options.dryRun && doc && !sameRelations(current, desired)) {
      try { const changed = await vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, links: desired }); report.pages.relinked++; pageByPath.set(relPath, changed); info.doc = changed; }
      catch (error) { report.pages.errors.push({ path: relPath, reason: `could not update wiki links: ${(error as Error).message}` }); }
    }
  }
  report.durationMs = Date.now() - started;
  if (options.verify) report.sources.errors.push(...sourceFiles.filter(f=>!byPath.has(`source:${storedPath(f.path)}`)).map(f=>({ path:f.path, reason:'source missing from vault' })));
  return report;
}
