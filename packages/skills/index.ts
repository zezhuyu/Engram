import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { Document, PutInput, Scope, SearchInput, SearchResult, VaultConfig } from '../core/types.js';
import { MDBError } from '../core/types.js';
import { skillCatalog } from './catalog.js';
import { lintWiki, type WikiLintOptions, type WikiLintCode, type WikiLintSeverity, type WikiLintIssue } from '../intelligence/wiki-lint.js';

export interface SkillVault {
  actor: { actorId: string; permissions: string[] };
  ingest(file: string, scope: Scope): Promise<unknown>;
  put(input: PutInput): Promise<unknown>;
  get(id: string, revisionId?: string): Promise<Document>;
  listDocuments(input?: { includeHistory?: boolean; scopes?: Scope[]; includeUnresolvedReferences?: boolean }): Promise<Document[]>;
  config(): Promise<VaultConfig>;
  promote(id: string, to: Scope, sanitizedBody: string, title?: string): Promise<unknown>;
}
export interface SkillContext {
  vault: SkillVault;
  search: { query(input: SearchInput): Promise<SearchResult>; rebuild(scope?: Scope): Promise<void> };
  intelligence: {
    provider?: { id: string };
    enqueue(job: 'wiki' | 'profile' | 'memory' | 'reflect' | 'dream' | 'index', input?: Record<string, unknown>): Promise<unknown>;
    proposeFromLint?(input: WikiLintIssue[] | { issues?: WikiLintIssue[]; scopes?: Scope[]; dryRun?: boolean; limit?: number }): Promise<unknown>;
    sessionEnd(input: { sessionId: string; body?: string }): Promise<unknown>;
  };
}
export interface SkillDefinition { name: string; description: string; mode: string; origin: string; instructions: string }
const invalid = (message: string): never => { throw new MDBError('INVALID_INPUT', message); };
const stringField = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : invalid(`${key} is required`);
};
function scopeField(input: Record<string, unknown>): Scope {
  const scope = input.scope;
  if (typeof scope !== 'object' || scope === null || !('type' in scope)) return invalid('Explicit scope is required');
  if (scope.type === 'workspace' && 'workspaceId' in scope && typeof scope.workspaceId === 'string') return scope as Scope;
  if (scope.type === 'global' && 'area' in scope && ['wiki', 'shared', 'discoveries', 'profile'].includes(String(scope.area))) return scope as Scope;
  return invalid('Invalid scope');
}
function catalogEntry(name: string) {
  if (!Object.hasOwn(skillCatalog, name)) throw new MDBError('NOT_FOUND', 'Skill not found');
  return skillCatalog[name as keyof typeof skillCatalog];
}
function skillRoot(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  return resolve(directory, directory.includes(`${process.platform === 'win32' ? '\\' : '/'}dist${process.platform === 'win32' ? '\\' : '/'}`) ? '../../../skills' : '../../skills');
}
export async function getSkill(name: string): Promise<SkillDefinition> {
  const entry = catalogEntry(name);
  return { ...entry, instructions: await readFile(resolve(skillRoot(), name, 'SKILL.md'), 'utf8') };
}
export async function listSkills(): Promise<SkillDefinition[]> {
  return Promise.all(Object.keys(skillCatalog).sort().map(getSkill));
}

function lintOptions(input: Record<string, unknown>): WikiLintOptions {
  const choices = ['missing_evidence', 'unresolved_or_inaccessible_evidence', 'evidence_span_not_found', 'uncited_claim', 'broken_wikilink', 'dangling_reference', 'orphan_page', 'duplicate_title', 'duplicate_content', 'stale_source', 'source_deleted', 'empty_page', 'tag_inconsistency'];
  if (input.checks !== undefined && (!Array.isArray(input.checks) || input.checks.some(x => typeof x !== 'string' || !choices.includes(x)))) return invalid('checks must contain known wiki lint codes');
  const minSeverity = input.minSeverity;
  if (minSeverity !== undefined && !['error', 'warning', 'info'].includes(String(minSeverity))) return invalid('minSeverity must be error, warning, or info');
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 0)) return invalid('limit must be a nonnegative integer');
  return { ...(Array.isArray(input.scopes) ? { scopes: input.scopes as Scope[] } : {}), ...(Array.isArray(input.checks) ? { checks: input.checks as WikiLintCode[] } : {}), ...(minSeverity ? { minSeverity: minSeverity as WikiLintSeverity } : {}), ...(input.limit !== undefined ? { limit: input.limit as number } : {}) };
}

/** Dispatch only known operations. Skill or source text is never executable code. */
export async function runSkill(name: string, input: Record<string, unknown>, context: SkillContext): Promise<unknown> {
  const { mode } = catalogEntry(name);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid('Skill input must be an object');
  if ('actor' in input || 'permissions' in input || 'actorId' in input) return invalid('Actor identity is supplied by the trusted host');
  const { vault, search, intelligence } = context;
  switch (mode) {
    case 'unavailable': return { available: false, skill: name, reason: (await getSkill(name)).instructions };
    case 'query': return search.query({ ...input, query: stringField(input, 'query') } as SearchInput);
    case 'handoff':
      return input.sessionId ? intelligence.sessionEnd({ sessionId: stringField(input, 'sessionId'), body: typeof input.body === 'string' ? input.body : undefined }) : search.query({ ...input, query: stringField(input, 'query') } as SearchInput);
    case 'capture-ingest': {
      if (input.captureConsent !== true) return invalid('Explicit captureConsent=true is required for history import');
      const config = await vault.config();
      const source = stringField(input, 'captureSource');
      if (!config.capture.enabled || !config.capture.allowedSources.includes(source)) throw new MDBError('CAPTURE_DISABLED', 'Capture source is not explicitly configured');
      return vault.ingest(stringField(input, 'path'), scopeField(input));
    }
    case 'ingest':
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(stringField(input, 'path'))) return { available: false, reason: 'Network source fetching is not integrated; select an explicit local file.' };
      return vault.ingest(stringField(input, 'path'), scopeField(input));
    case 'write': {
      const kind = typeof input.kind === 'string' ? input.kind : 'note';
      if (!['note', 'observation', 'working_memory', 'session', 'thinking'].includes(kind)) return invalid('memory-write accepts explicit authored notes; semantic claims require evidence review');
      return vault.put({ ...input, scope: scopeField(input), kind, title: stringField(input, 'title'), body: stringField(input, 'body') } as PutInput);
    }
    case 'status': {
      const documents = await vault.listDocuments({ scopes: input.scopes as Scope[] | undefined });
      const kinds: Record<string, number> = {};
      for (const doc of documents) kinds[doc.kind] = (kinds[doc.kind] ?? 0) + 1;
      const config = await vault.config();
      return { documents: documents.length, kinds, capabilities: { lexical: true, modelConfigured: config.model.provider !== null, networkFetching: false, mediaConversion: false } };
    }
    case 'export': return { format: 'mdb-authorized-documents-v1', documents: await vault.listDocuments({ scopes: input.scopes as Scope[] | undefined }) };
    case 'audit': {
      const options = lintOptions(input);
      if (input.propose === true) { if (!intelligence.proposeFromLint) return invalid('Lint proposals are unavailable in this skill host'); return intelligence.proposeFromLint({ issues: (await lintWiki(vault, options)).issues, dryRun: input.dryRun === true, limit: input.limit as number | undefined }); }
      return lintWiki(vault, options);
    }
    case 'rebuild': await search.rebuild(input.scope === undefined ? undefined : scopeField(input)); return { rebuilt: true, canonicalRevisionsChanged: false };
    case 'promotion':
      if (input.review !== true) return invalid('Explicit review=true and sanitizedBody are required for promotion');
      return vault.promote(stringField(input, 'objectId'), scopeField(input), stringField(input, 'sanitizedBody'), typeof input.title === 'string' ? input.title : undefined);
    default:
      // The intelligence engine enforces access before constructing provider context.
      scopeField(input);
      if (!Array.isArray(input.objectIds) || input.objectIds.length === 0 || input.objectIds.some(id => typeof id !== 'string')) return invalid('Explicit nonempty objectIds evidence selection is required');
      for (const id of input.objectIds) await vault.get(id);
      if (mode === 'wiki' && input.skill !== undefined && input.skill !== name) return invalid('skill is selected by the skill registry and cannot be overridden');
      const jobInput = mode === 'wiki' ? { ...input, skill: name, ...(input.targetPageId ? { targetPageId: input.targetPageId } : {}), ...(input.issues ? { issues: input.issues as WikiLintIssue[] } : {}) } : input;
      return { job: await intelligence.enqueue(mode, jobInput), semanticExecutionAvailable: Boolean(intelligence.provider), requiresReview: true };
  }
}

export class SkillRegistry {
  constructor(private readonly context: SkillContext) {}
  list(): Promise<SkillDefinition[]> { return listSkills(); }
  get(name: string): Promise<SkillDefinition> { return getSkill(name); }
  execute(name: string, input: Record<string, unknown>): Promise<unknown> { return runSkill(name, input, this.context); }
}
