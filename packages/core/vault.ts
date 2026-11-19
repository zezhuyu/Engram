import { killAtBoundary } from './fault-injection.js';
import { promises as fs, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { parseFrontmatterFast } from './frontmatter-fast.js';
import { atomicWrite, atomicWriteVolatile, flushKeys, LocalObjectStore, mkdirDurable, safePath, syncDirectory, withVaultLock } from '../storage-local/index.js';
import { createS3ObjectStoreFromEnv } from '../storage-s3/index.js';
import { describeModel } from '../models/factory.js';
import { profileAsync, profileBytes } from '../bench/instrumentation.js';
import { assertDurableWriteCapacity } from './storage-lifecycle.js';
import { REPLICATION_INSTALL_CAPABILITY } from './replication-capability.js';
import { isSensitive } from './sensitivity.js';
import { MDBError, OWNER, type ActorContext, type Collection, type CommitEvent, type CommitJournalStore, type Document, type ObjectStore, type PatchInput, type PutInput, type Scope, type VaultConfig, type Workspace } from './types.js';

const defaults: VaultConfig = { schemaVersion: 1, sqlite: { enabled: false }, postgres: { enabled: false }, capture: { enabled: false, allowedSources: [] }, model: { provider: 'auto', allowNetwork: false }, dream: { enabled: false, maxCandidates: 20 }, profile: { domains: { autoApply: true, maxActive: 24, maxPerDreamCycle: 3 } } };
export const BACKUP_MANIFEST = 'BACKUP_MANIFEST.json';
const fold = (name: string) => name.normalize('NFC').toLowerCase();
async function rejectCaseAlias(directory: string, name: string): Promise<void> { let entries: string[] = []; try { entries = await fs.readdir(directory); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } if (entries.some(entry => entry !== name && fold(entry) === fold(name))) throw new MDBError('INVALID_INPUT', 'Identifier differs from an existing one only by letter case; this would alias one directory on case-insensitive filesystems'); }
const inaccessible = () => new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
const validId = (id: string) => { if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new MDBError('INVALID_INPUT', 'Invalid identifier'); return id; };
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '')}`;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const payloadHash = (operation: string, value: unknown): string => createHash('sha256').update(JSON.stringify([operation, canonical(value)])).digest('hex');
export function scopeKey(scope: Scope): string { return scope.type === 'global' ? `global:${scope.area}` : `workspace:${scope.workspaceId}${scope.collectionId ? `:collection:${scope.collectionId}` : ''}`; }
export function documentUri(objectId: string, scope: Scope): string { return scope.type === 'global' ? `mdb://${scope.area}/objects/${objectId}` : `mdb://workspaces/${scope.workspaceId}${scope.collectionId ? `/collections/${scope.collectionId}` : ''}/objects/${objectId}`; }
export function objectIdFromUri(uri: string): string { return uri.split('/').at(-1) ?? uri; }
function scopeRoot(scope: Scope): string { return scope.type === 'global' ? scope.area : `workspaces/${validId(scope.workspaceId)}${scope.collectionId ? `/collections/${validId(scope.collectionId)}` : ''}`; }
function viewPath(doc: Pick<Document, 'scope' | 'kind' | 'id'> & {metadata?: Record<string, unknown>}): string {
  const root = scopeRoot(doc.scope);
  if (doc.scope.type === 'global' && doc.scope.area === 'profile' && doc.kind === 'user_insight') {
    if (doc.metadata?.profileRole === 'explicit') return 'PROFILE.md';
    if (doc.metadata?.profileRole === 'inferred') return 'USER_INSIGHT.md';
  }
  let directory = 'notes';
  if (doc.kind === 'source') directory = 'sources/manifests';
  else if (doc.kind === 'discovery') directory = 'hypotheses';
  else if (doc.kind === 'wiki_page') directory = doc.scope.type === 'global' && doc.scope.area === 'wiki' ? 'pages' : 'wiki/pages';
  else if (doc.kind === 'observation') directory = 'observations';
  else if (doc.kind === 'session') directory = 'sessions';
  else if (doc.kind === 'working_memory') directory = 'working';
  else if (['insight','decision','procedure','reflection','analysis','finding','thinking'].includes(doc.kind)) directory = ({analysis:'analyses',thinking:'thinking'} as Record<string,string>)[doc.kind] ?? doc.kind+'s';
  const namespace = doc.scope.type === 'global' && doc.scope.area === 'wiki' && typeof doc.metadata?.wikiNamespace === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc.metadata.wikiNamespace) ? `${doc.metadata.wikiNamespace}/` : '';
  return `${root}/${directory}/${namespace}${doc.id}.md`;
}
export function serializeDocument(doc: Document): string {
  const metadata = { schema_version: 1, id: doc.id, revision_id: doc.revisionId, revision_number: doc.revisionNumber, previous_revision_id: doc.previousRevisionId, scope: doc.scope.type, ...(doc.scope.type === 'global' ? { area: doc.scope.area } : { workspace_id: doc.scope.workspaceId, collection_id: doc.scope.collectionId }), kind: doc.kind, title: doc.title, tags: doc.tags, relations: doc.links, provenance: { evidence: doc.evidence }, status: doc.status, created_at: doc.createdAt, updated_at: doc.updatedAt, created_by: doc.createdBy, metadata: doc.metadata, path: doc.path, uri: doc.uri };
  return `---\n${YAML.stringify(metadata)}---\n${doc.body}`;
}
export function parseDocument(text: string): Document {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new MDBError('INVALID_INPUT', 'Document requires YAML frontmatter');
  let m: Record<string, unknown>; try { m = parseFrontmatterFast(match[1]!) ?? YAML.parse(match[1]!) as Record<string, unknown>; } catch { throw new MDBError('INVALID_INPUT', 'Invalid YAML frontmatter'); }
  if (!m || m.schema_version !== 1 || typeof m.id !== 'string' || typeof m.revision_id !== 'string' || typeof m.title !== 'string' || typeof m.kind !== 'string') throw new MDBError('INVALID_INPUT', 'Invalid document schema');
  validId(m.id); validId(m.revision_id);
  const scope: Scope = m.scope === 'global' ? { type: 'global', area: m.area as 'wiki' } : { type: 'workspace', workspaceId: String(m.workspace_id), ...(m.collection_id ? { collectionId: String(m.collection_id) } : {}) };
  const doc: Document = { id: m.id, revisionId: m.revision_id, revisionNumber: Number(m.revision_number), ...(m.previous_revision_id ? { previousRevisionId: String(m.previous_revision_id) } : {}), scope, kind: m.kind, title: m.title, body: match[2]!, tags: (m.tags ?? []) as string[], links: (m.relations ?? []) as Document['links'], evidence: ((m.provenance as {evidence?: unknown})?.evidence ?? []) as Document['evidence'], status: String(m.status ?? 'active'), createdAt: String(m.created_at), updatedAt: String(m.updated_at), createdBy: String(m.created_by), metadata: (m.metadata ?? {}) as Record<string, unknown>, path: String(m.path), uri: String(m.uri) };
  validateInput(doc); if (doc.path !== viewPath(doc) || doc.uri !== documentUri(doc.id, doc.scope) || !doc.createdBy || !Number.isFinite(Date.parse(doc.createdAt)) || !Number.isFinite(Date.parse(doc.updatedAt))) throw new MDBError('INVALID_INPUT', 'Invalid canonical document metadata'); if (!Number.isSafeInteger(doc.revisionNumber) || doc.revisionNumber < 1) throw new MDBError('INVALID_INPUT', 'Invalid revision number');
  let bodyLineOffset = 0; const bodyStart = match[0].length - match[2]!.length;
  for (let index = 0; index < bodyStart; index++) if (text.charCodeAt(index) === 10) bodyLineOffset++;
  documentBodyLineOffsets.set(doc, bodyLineOffset);
  return doc;
}

const documentBodyLineOffsets = new WeakMap<Document, number>();
/** Number of source-file lines before this parsed revision's body, when known from its immutable bytes. */
export function documentBodyLineOffset(doc: Document): number | undefined { return documentBodyLineOffsets.get(doc); }
function validateInput(input: PutInput): void {
  if (!input || typeof input.title !== 'string' || typeof input.body !== 'string' || !/^[a-z][a-z0-9_:-]{0,80}$/.test(input.kind)) throw new MDBError('INVALID_INPUT', 'Invalid document input');
  if (!input.scope || !['global', 'workspace'].includes(input.scope.type)) throw new MDBError('INVALID_INPUT', 'Invalid scope');
  if (input.scope.type === 'global' && !['wiki','shared','discoveries','profile'].includes(input.scope.area)) throw new MDBError('INVALID_INPUT', 'Invalid global area');
  if (input.scope.type === 'workspace') { validId(input.scope.workspaceId); if (input.scope.collectionId) validId(input.scope.collectionId); }
  if (input.tags && (!Array.isArray(input.tags) || input.tags.some(t => typeof t !== 'string'))) throw new MDBError('INVALID_INPUT', 'Invalid tags');
  if (input.links && (!Array.isArray(input.links) || input.links.some(l => typeof l.type !== 'string' || typeof l.target !== 'string'))) throw new MDBError('INVALID_INPUT', 'Invalid relations');
  if (input.evidence && (!Array.isArray(input.evidence) || input.evidence.some(e => typeof e.uri !== 'string' || typeof e.revisionId !== 'string'))) throw new MDBError('INVALID_INPUT', 'Invalid evidence');
  if (input.metadata && (Array.isArray(input.metadata) || typeof input.metadata !== 'object')) throw new MDBError('INVALID_INPUT', 'Invalid metadata');
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length > 256)) throw new MDBError('INVALID_INPUT', 'Invalid idempotency key');
}
/** Head/view projections are flushed after this much write-idle time (so the flush's fsyncs never compete with a burst of commits)... */
const PROJECTION_IDLE_MS=300;
/** ...but never later than this after the first un-flushed write, so a sustained write load still bounds the un-flushed window. */
const PROJECTION_MAX_AGE_MS=3000;
/** Journal events whose projections are re-checked on the first owner operation of a Vault instance (3 s of sustained commits is far below this). */
const PROJECTION_TAIL_EVENTS=512;
const exitFlush=new Set<{flushProjections():Promise<unknown>}>();
let exitHooked=false;
function hookExit():void{if(exitHooked)return;exitHooked=true;process.on('beforeExit',()=>{for(const vault of [...exitFlush])void vault.flushProjections().catch(()=>undefined);});}
export class Vault {
  readonly root: string;
  readonly store: ObjectStore;
  constructor(root: string, readonly actor: ActorContext = OWNER, readonly options: { fault?: (stage: string) => void; idFactory?: (prefix: string) => string; now?: () => Date; store?: ObjectStore; storageAvailableBytes?: () => Promise<number>; beforeCommit?: (document: Document, operation: string) => void | Promise<void>; onCommit?: (document: Document, event: CommitEvent) => void | Promise<void> } = {}) { this.root = path.resolve(root); this.store = options.store ?? (process.env.MDB_STORAGE_BACKEND === 's3' ? createS3ObjectStoreFromEnv() : new LocalObjectStore(this.root, options.fault)); }
  private remoteJournal(): CommitJournalStore | undefined { const store = this.store as Partial<CommitJournalStore>; return typeof store.readCommittedJournal === 'function' && typeof store.appendCommittedEvent === 'function' && typeof store.initializeJournal === 'function' ? store as CommitJournalStore : undefined; }
  private newId(prefix: string): string { return this.options.idFactory?.(prefix) ?? id(prefix); }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  async close(): Promise<void> { const store=this.store as ObjectStore & {close?:()=>void|Promise<void>};await store.close?.(); }
  private owner(): boolean { return this.actor.permissions.includes('*'); }
  private requireOwner(): void { if (!this.owner()) throw inaccessible(); }
  private async readJSON<T>(key: string): Promise<T> { return JSON.parse(Buffer.from(await this.store.read(key)).toString('utf8')) as T; }
  async init(options: { sqlite?: boolean; postgres?: boolean } = {}, capability?:object): Promise<VaultConfig> {
    if(capability!==REPLICATION_INSTALL_CAPABILITY)this.requireOwner(); await safePath(this.root,'mdb.yaml'); await mkdirDurable(this.root, this.options.fault);
    if ((await fs.lstat(this.root)).isSymbolicLink()) throw new MDBError('INVALID_INPUT', 'Vault root must not be a symlink');
    try { await this.store.read('mdb.yaml'); await this.remoteJournal()?.initializeJournal(); return this.config(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const config = structuredClone(defaults); config.sqlite.enabled = options.sqlite ?? false; if(options.postgres)config.postgres={enabled:true};
    for (const directory of ['.mdb/objects','.mdb/heads','.mdb/events','.mdb/locks','.mdb/jobs','.mdb/cursors','.mdb/cache','.mdb/indexes','.mdb/quarantine','wiki/sources/originals','wiki/sources/manifests','wiki/pages','wiki/topics','wiki/entities','wiki/syntheses','wiki/references','shared/insights','shared/notes','shared/analyses','shared/findings','shared/thinking','shared/decisions','shared/procedures','shared/reflections','discoveries/hypotheses','discoveries/aha-moments','discoveries/cross-domain','discoveries/opportunities','discoveries/validated','discoveries/retracted','profile/notes','workspaces']) await mkdirDurable(await safePath(this.root,directory),this.options.fault);
    await this.store.putImmutable('mdb.yaml', Buffer.from(YAML.stringify(config)));
    await this.store.putImmutable('.mdb/manifest.json', Buffer.from(JSON.stringify({schemaVersion:1,format:'mdb-markdown-v1'})));
    if (this.remoteJournal()) await this.remoteJournal()!.initializeJournal();
    else await this.store.putImmutable('.mdb/events/commits.jsonl',Buffer.from(''));
    for (const file of ['MAIN_INDEX.md','PROFILE.md','USER_INSIGHT.md','WORKSPACE_REGISTRY.md','wiki/INDEX.md','shared/INDEX.md','discoveries/INDEX.md']) await this.store.putImmutable(file,Buffer.from(`# ${file.replace('.md','')}\n\nGenerated navigation; canonical documents are immutable revisions.\n`));
    return config;
  }
  async config(): Promise<VaultConfig> { const data = YAML.parse(Buffer.from(await this.store.read('mdb.yaml')).toString('utf8')) as VaultConfig; if (!data || data.schemaVersion !== 1) throw new MDBError('INVALID_INPUT','Invalid vault config'); return data; }
  async doctor(): Promise<Record<string, unknown>> {
    try {
      const config=await this.config();let sqliteRuntime=false,fts5=false;let sqliteReason:string|undefined;
      try { const {DatabaseSync}=await import('node:sqlite');const database=new DatabaseSync(':memory:');try{sqliteRuntime=true;database.exec('CREATE VIRTUAL TABLE capability_probe USING fts5(body)');fts5=true;}finally{database.close();} } catch(error) {sqliteReason=error instanceof Error?error.message:String(error);}
      return {ok:true,root:this.root,config,storage:this.remoteJournal()?'s3-markdown':'local-markdown',journalEvents:(await this.events()).length,capabilities:{grep:true,keyword:true,sqlite:{enabled:config.sqlite.enabled,runtimeAvailable:sqliteRuntime,fts5Available:fts5,...(sqliteReason?{reason:sqliteReason}:{})},postgres:{enabled:config.postgres?.enabled??false},semantic:{available:false,reason:'No embedding/vector adapter configured'},model:describeModel(config.model),dream:{enabled:config.dream.enabled,available:config.dream.enabled&&describeModel(config.model).available,...(config.dream.enabled?{}:{reason:'Dreaming is disabled; explicit opt-in required'})},capture:{enabled:config.capture.enabled,allowedSources:config.capture.allowedSources},network:{allowed:config.model.allowNetwork,automaticFetch:false}}};
    } catch(error) {return{ok:false,error:error instanceof Error?error.message:String(error)};}
  }
  async canAccess(scope: Scope, action: 'read' | 'write' | 'promote' = 'read', actor: ActorContext = this.actor): Promise<boolean> { return profileAsync('acl.check', () => this.canAccessUnprofiled(scope, action, actor)); }
  private async canAccessUnprofiled(scope: Scope, action: 'read' | 'write' | 'promote', actor: ActorContext): Promise<boolean> {
    if (actor.permissions.includes('*')) return true;
    const permissions = actor.permissions;
    if (scope.type === 'global') return permissions.includes(`global:${scope.area}:${action}`) || permissions.includes(`global:*:${action}`) || permissions.includes(`${scopeKey(scope)}:*`);
    let workspace: Workspace; try { workspace = await this.readJSON<Workspace>(`workspaces/${validId(scope.workspaceId)}/.mdb/workspace.json`); } catch { return false; }
    const collectionPermission = scope.collectionId ? permissions.includes(`workspace:${scope.workspaceId}:collection:${scope.collectionId}:${action}`) : false;
    const workspacePermission = collectionPermission || permissions.includes(`workspace:${scope.workspaceId}:${action}`) || permissions.includes(`workspace:${scope.workspaceId}:*`);
    const autoCreatedForActor = workspace.autoCreatedBy === actor.actorId && permissions.includes('workspace:create');
    const granted = actor.credentialBound ? workspace.grants[actor.actorId]?.includes(action) === true && (workspacePermission || autoCreatedForActor) : workspace.grants[actor.actorId]?.includes(action) || workspacePermission;
    if (!granted) return false;
    if (scope.collectionId) { let collection: Collection; try { collection = await this.readJSON<Collection>(`workspaces/${scope.workspaceId}/collections/${validId(scope.collectionId)}/.mdb/collection.json`); } catch { return false; } if (collection.grants && !collection.grants[this.actor.actorId]?.includes(action)) return false; }
    return true;
  }
  private async requireAccess(scope: Scope, action: 'read'|'write'|'promote'): Promise<void> { if (!(await this.canAccess(scope,action))) throw inaccessible(); if (scope.type === 'workspace') { try { await this.readJSON(`workspaces/${validId(scope.workspaceId)}/.mdb/workspace.json`); if (scope.collectionId) await this.readJSON(`workspaces/${scope.workspaceId}/collections/${validId(scope.collectionId)}/.mdb/collection.json`); } catch { throw inaccessible(); } } }
  async createWorkspace(workspaceId: string, description = '', grants: Workspace['grants'] = {}): Promise<Workspace> {
    this.requireOwner(); validId(workspaceId); if (['profile', 'user-insight', 'chat', 'wiki'].includes(workspaceId.toLowerCase())) throw new MDBError('INVALID_ARGUMENT', 'This workspace name is reserved for connector memory routing'); const workspace: Workspace = {id:workspaceId,description,grants};
    await withVaultLock(this.root, async () => { await this.createWorkspaceUnlocked(workspace); await this.appendWorkspaceCreateAudit(workspaceId, false); }); return workspace;
  }
  /** Create or enroll one local replica workspace without elevating its actor to OWNER. */
  async enrollReplicaWorkspace(workspaceId:string,actorId:string,capability:object):Promise<Workspace>{if(capability!==REPLICATION_INSTALL_CAPABILITY)throw inaccessible();validId(workspaceId);if(['profile','user-insight','chat','wiki'].includes(workspaceId.toLowerCase()))throw new MDBError('INVALID_ARGUMENT','This workspace name is reserved for connector memory routing');return withVaultLock(this.root,async()=>{const key=`workspaces/${workspaceId}/.mdb/workspace.json`;let workspace:Workspace;try{workspace=await this.readJSON<Workspace>(key);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;workspace={id:workspaceId,description:'Replica workspace',grants:{[actorId]:['read','write']}};await this.createWorkspaceUnlocked(workspace);await this.appendWorkspaceCreateAudit(workspaceId,true);return workspace;}const grants={...workspace.grants,[actorId]:['read','write'] as ('read'|'write')[]};workspace={...workspace,grants};await atomicWrite(this.root,key,JSON.stringify(workspace));await atomicWrite(this.root,`workspaces/${workspaceId}/db.yaml`,YAML.stringify(workspace));return workspace;});}
  private async appendWorkspaceCreateAudit(workspaceId: string, autoCreated: boolean): Promise<void> { const auditPath = await safePath(this.root, '.mdb/workspace-create-audit.jsonl'); await fs.appendFile(auditPath, `${JSON.stringify({ actorId: this.actor.actorId, workspaceId, at: this.now().toISOString(), autoCreated })}\n`, { mode: 0o600 }); }
  private async createWorkspaceUnlocked(workspace: Workspace): Promise<void> { const workspaceId = workspace.id; await this.assertMutationCapacity(Buffer.byteLength(JSON.stringify(workspace)) + 16 * 1024); const key=`workspaces/${workspaceId}/.mdb/workspace.json`; await rejectCaseAlias(await safePath(this.root,'workspaces'),workspaceId); if (await this.store.stat(key)) throw new MDBError('CONFLICT','Workspace already exists'); await this.store.putImmutable(key,Buffer.from(JSON.stringify(workspace))); await atomicWrite(this.root,`workspaces/${workspaceId}/db.yaml`,YAML.stringify(workspace)); for (const dir of ['memory/episodic','memory/semantic','memory/procedural','insights','decisions','sources/originals','sources/manifests','wiki/pages','wiki/topics','wiki/syntheses','collections']) await fs.mkdir(await safePath(this.root,`workspaces/${workspaceId}/${dir}`),{recursive:true,mode:0o700}); for (const name of ['INDEX','PROFILE','OVERVIEW']) await atomicWrite(this.root,`workspaces/${workspaceId}/${name}.md`,`# ${name}\n`); }
  /** Explicit remote self-service: the caller receives only its own read/write grant. */
  async ensureWorkspaceForActor(workspaceId: string, description = '', perActorCap = Number(process.env.MDB_AUTO_WORKSPACE_CAP ?? 25)): Promise<'created' | 'exists'> {
    validId(workspaceId);
    if (['profile', 'user-insight', 'chat', 'wiki'].includes(workspaceId.toLowerCase())) throw new MDBError('INVALID_ARGUMENT', 'This workspace name is reserved for connector memory routing');
    if (!Number.isSafeInteger(perActorCap) || perActorCap < 1 || perActorCap > 1000) throw new MDBError('INVALID_INPUT', 'MDB_AUTO_WORKSPACE_CAP must be an integer from 1 to 1000');
    const key = `workspaces/${workspaceId}/.mdb/workspace.json`;
    if (await this.store.stat(key)) {
      if (!(await this.canAccess({ type: 'workspace', workspaceId }, 'read')) || !(await this.canAccess({ type: 'workspace', workspaceId }, 'write'))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', `Workspace ${workspaceId} already exists but is not available to this actor; ask the owner for access.`);
      return 'exists';
    }
    if (!this.owner() && !this.actor.permissions.includes('workspace:create')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'This credential lacks workspace:create; ask the owner to create and grant this workspace.');
    const grants = { [this.actor.actorId]: ['read', 'write'] as ('read' | 'write')[] };
    await withVaultLock(this.root, async () => {
      if (await this.store.stat(key)) throw new MDBError('CONFLICT', `Workspace ${workspaceId} was created concurrently; retry init.`);
      const auditPath = await safePath(this.root, '.mdb/workspace-create-audit.jsonl');
      let records: Array<{ actorId: string; autoCreated?: boolean }> = [];
      try { records = (await fs.readFile(auditPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (records.filter(record => record.actorId === this.actor.actorId && record.autoCreated).length >= perActorCap) throw new MDBError('CONFLICT', `Automatic workspace limit (${perActorCap}) reached for this principal; ask the owner to create another workspace.`);
      await this.createWorkspaceUnlocked({ id: workspaceId, description, grants, autoCreatedBy: this.actor.actorId });
      await this.appendWorkspaceCreateAudit(workspaceId, true);
    });
    return 'created';
  }
  async listWorkspaces(actor:ActorContext=this.actor): Promise<Workspace[]> {
    const result: Workspace[] = [];
    if (this.remoteJournal()) {
      const ids = new Set<string>();
      for await (const entry of this.store.list('workspaces')) { const match = /^workspaces\/([^/]+)\/.mdb\/workspace\.json$/.exec(entry.key); if (match) ids.add(match[1]!); }
      for (const id of ids) if (await this.canAccess({ type: 'workspace', workspaceId: id }, 'read',actor)) { const workspace = await this.readJSON<Workspace>(`workspaces/${id}/.mdb/workspace.json`); if (!workspace.retired || id === 'personal') result.push(workspace); }
      return result;
    }
    let entries;
    try { entries = await fs.readdir(await safePath(this.root, 'workspaces'), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
    for (const entry of entries) if (entry.isDirectory() && await this.canAccess({ type: 'workspace', workspaceId: entry.name }, 'read',actor)) { const workspace = await this.readJSON<Workspace>(`workspaces/${entry.name}/.mdb/workspace.json`); if (!workspace.retired || entry.name === 'personal') result.push(workspace); }
    return result;
  }
  async getWorkspace(workspaceId: string): Promise<Workspace> { validId(workspaceId); await this.requireAccess({ type: 'workspace', workspaceId }, 'read'); return this.readJSON(`workspaces/${workspaceId}/.mdb/workspace.json`); }
  async setWorkspaceRetired(workspaceId: string, retired: boolean): Promise<Workspace> { if (!this.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Workspace retirement and reactivation are owner-only'); validId(workspaceId); if (workspaceId === 'personal' && retired) throw new MDBError('INVALID_ARGUMENT', 'The personal workspace cannot be retired'); return withVaultLock(this.root, async () => { const key = `workspaces/${workspaceId}/.mdb/workspace.json`, old = await this.readJSON<Workspace>(key); if (!!old.retired === retired) return old; const at = this.now().toISOString(), next: Workspace = { ...old, retired, ...(retired ? { retiredAt: at } : {}) }; if (!retired) delete next.retiredAt; await this.assertMutationCapacity(Buffer.byteLength(JSON.stringify(next)) + 8192); if (this.remoteJournal()) { if (!await this.store.compareAndSwapPointer(key, JSON.stringify(old), JSON.stringify(next))) throw new MDBError('CONFLICT', 'Workspace metadata changed during retirement'); } else await atomicWrite(this.root, key, JSON.stringify(next)); await atomicWrite(this.root, `workspaces/${workspaceId}/db.yaml`, YAML.stringify(next)); const audit = await safePath(this.root, '.mdb/workspace-retirement-audit.jsonl'); await fs.appendFile(audit, `${JSON.stringify({ actorId: this.actor.actorId, workspaceId, action: retired ? 'retired' : 'reactivated', at })}\n`, { mode: 0o600 }); return next; }); }
  async setWorkspaceDescription(workspaceId: string, description: string): Promise<Workspace> {
    this.requireOwner(); validId(workspaceId);
    const text = String(description).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) throw new MDBError('INVALID_ARGUMENT', 'A workspace description is required');
    return withVaultLock(this.root, async () => {
      const key = `workspaces/${workspaceId}/.mdb/workspace.json`, old = await this.readJSON<Workspace>(key);
      if (old.description === text) return old;
      const next: Workspace = { ...old, description: text };
      await this.assertMutationCapacity(Buffer.byteLength(JSON.stringify(next)) + 8192);
      if (this.remoteJournal()) { if (!await this.store.compareAndSwapPointer(key, JSON.stringify(old), JSON.stringify(next))) throw new MDBError('CONFLICT', 'Workspace changed during update'); } else await atomicWrite(this.root, key, JSON.stringify(next));
      await atomicWrite(this.root, `workspaces/${workspaceId}/db.yaml`, YAML.stringify(next));
      return next;
    });
  }
  async grant(workspaceId:string,actorId:string,permissions:('read'|'write'|'promote')[]):Promise<Workspace> { this.requireOwner(); validId(workspaceId); if(permissions.some(p=>!['read','write','promote'].includes(p))) throw new MDBError('INVALID_INPUT','Invalid grant'); return withVaultLock(this.root,async()=>{const key=`workspaces/${workspaceId}/.mdb/workspace.json`;const old=await this.readJSON<Workspace>(key);const w={...old,grants:{...old.grants,[actorId]:permissions}};await this.assertMutationCapacity(Buffer.byteLength(JSON.stringify(w)) + 8192);if(this.remoteJournal()){if(!await this.store.compareAndSwapPointer(key,JSON.stringify(old),JSON.stringify(w)))throw new MDBError('CONFLICT','Workspace grants changed during update');}else await atomicWrite(this.root,key,JSON.stringify(w));await atomicWrite(this.root,`workspaces/${workspaceId}/db.yaml`,YAML.stringify(w));return w;}); }
  async revoke(workspaceId:string,actorId:string):Promise<Workspace> { return this.grant(workspaceId,actorId,[]); }
  async createCollection(workspaceId:string,collectionId:string,description='',grants?:Collection['grants']):Promise<Collection> { validId(workspaceId);validId(collectionId);await this.requireAccess({type:'workspace',workspaceId},'write'); if(grants && !this.owner()) throw inaccessible(); const collection:Collection={id:collectionId,workspaceId,description,...(grants?{grants}:{})}; await withVaultLock(this.root,async()=>{await this.assertMutationCapacity(Buffer.byteLength(JSON.stringify(collection)) + 12 * 1024);const key=`workspaces/${workspaceId}/collections/${collectionId}/.mdb/collection.json`;await rejectCaseAlias(await safePath(this.root,`workspaces/${workspaceId}/collections`),collectionId);if(await this.store.stat(key))throw new MDBError('CONFLICT','Collection already exists');await this.store.putImmutable(key,Buffer.from(JSON.stringify(collection))); for(const d of ['working','notes','observations','insights','sessions'])await fs.mkdir(await safePath(this.root,`workspaces/${workspaceId}/collections/${collectionId}/${d}`),{recursive:true,mode:0o700});for(const n of ['PROFILE','INDEX','state','retrospective'])await atomicWrite(this.root,`workspaces/${workspaceId}/collections/${collectionId}/${n}.md`,`# ${n}\n`);});return collection; }
  async listCollections(workspaceId:string):Promise<Collection[]> { await this.requireAccess({type:'workspace',workspaceId},'read');const result:Collection[]=[];if(this.remoteJournal()){const ids=new Set<string>();for await(const entry of this.store.list(`workspaces/${workspaceId}/collections`)){const match=new RegExp(`^workspaces/${workspaceId}/collections/([^/]+)/.mdb/collection\\.json$`).exec(entry.key);if(match)ids.add(match[1]!);}for(const id of ids)if(await this.canAccess({type:'workspace',workspaceId,collectionId:id},'read'))result.push(await this.readJSON(`workspaces/${workspaceId}/collections/${id}/.mdb/collection.json`));return result;}for(const e of await fs.readdir(await safePath(this.root,`workspaces/${workspaceId}/collections`),{withFileTypes:true}))if(e.isDirectory()&&await this.canAccess({type:'workspace',workspaceId,collectionId:e.name},'read'))result.push(await this.readJSON(`workspaces/${workspaceId}/collections/${e.name}/.mdb/collection.json`));return result; }
  /** Parsed journal prefix. The journal is append-only, so only bytes after `offset` are parsed; a replaced (new inode), shrunk or corrupt file forces a full re-read. */
  private journalCache?:{ino:number;dev:number;offset:number;events:CommitEvent[];latest:Map<string,CommitEvent>;byRevision:Map<string,CommitEvent>;purged:Set<string>;idem:Map<string,CommitEvent>};
  private rawQueue:Promise<unknown>=Promise.resolve();
  /** Serialized: the journal cache is extended in place, so two overlapping reads must not both parse the same appended tail. */
  private rawEvents(copy=true):Promise<CommitEvent[]> { const run=this.rawQueue.then(()=>profileAsync('journal.read_parse', () => this.rawEventsUnprofiled(copy))); this.rawQueue=run.catch(()=>undefined); return run; }
  /** Brings the journal cache up to date without copying the event array; callers then read this.journalCache. A 100k-event copy per document read cost about 100 us each. */
  private async refreshJournal():Promise<void> { await this.rawEvents(false); }
  private async rawEventsUnprofiled(copy=true):Promise<CommitEvent[]> {
    const remote = this.remoteJournal();
    if (remote) {
      const events = await remote.readCommittedJournal();
      const latest = new Map<string,CommitEvent>(), byRevision = new Map<string,CommitEvent>(), purged = new Set<string>(), idem = new Map<string,CommitEvent>();
      events.forEach((event,index) => {
        if (event.sequence !== index + 1 || !event.objectId || !event.revisionId) throw new MDBError('INTERNAL','S3 commit journal sequence is invalid');
        latest.set(event.objectId,event); byRevision.set(event.revisionId,event);
        if (event.operation === 'purge') purged.add(event.objectId);
        if (event.idempotencyKey) { const key = `${scopeKey(event.scope)}\0${event.idempotencyKey}`; if (!idem.has(key)) idem.set(key,event); }
      });
      this.journalCache = { ino: 0, dev: 0, offset: events.length, events, latest, byRevision, purged, idem };
      return events;
    }
    const file=await safePath(this.root,'.mdb/events/commits.jsonl');let stat;
    try{stat=await fs.stat(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){this.journalCache=undefined;if(await this.store.stat('.mdb/manifest.json'))throw new MDBError('INTERNAL','Committed journal is missing from an initialized vault');return [];}throw e;}
    let cache=this.journalCache;if(!cache||cache.ino!==stat.ino||cache.dev!==stat.dev||stat.size<cache.offset)cache={ino:stat.ino,dev:stat.dev,offset:0,events:[],latest:new Map(),byRevision:new Map(),purged:new Set(),idem:new Map()};
    if(stat.size>cache.offset){
      const handle=await fs.open(file,'r');let chunk:Buffer;
      try{chunk=Buffer.alloc(stat.size-cache.offset);const{bytesRead}=await handle.read(chunk,0,chunk.length,cache.offset);chunk=chunk.subarray(0,bytesRead);}finally{await handle.close();}
      const end=chunk.lastIndexOf(10); // only newline-terminated records are committed; an unterminated tail is a torn write
      if(end>=0){
        /* Appended in place: copying five 100k-entry collections per commit cost about 17 ms at 100k documents. A parse error discards the whole cache, so no half-updated state survives. */const{events,latest,byRevision,purged,idem}=cache;
        for(const line of chunk.subarray(0,end).toString('utf8').split('\n')){if(!line)continue;try{const event=JSON.parse(line) as CommitEvent;if(event.sequence!==events.length+1||!event.objectId||!event.revisionId)throw new Error('Invalid journal record');events.push(event);latest.set(event.objectId,event);byRevision.set(event.revisionId,event);if(event.operation==='purge')purged.add(event.objectId);if(event.idempotencyKey&&!idem.has(`${scopeKey(event.scope)}\0${event.idempotencyKey}`))idem.set(`${scopeKey(event.scope)}\0${event.idempotencyKey}`,event);}catch{this.journalCache=undefined;throw new MDBError('INTERNAL','Committed journal is corrupt');}}
        cache.offset+=end+1;
      }
    }
    this.journalCache=cache;return copy?cache.events.slice():cache.events;
  }
  /** The committed object created under this idempotency key in this scope, if the caller may read it (O(1): indexed from the journal). */
  async byIdempotencyKey(key:string,scope:Scope):Promise<Document|undefined> {await this.refreshJournal();const event=this.journalCache!.idem.get(`${scopeKey(scope)}\0${key}`);if(!event||this.journalCache!.purged.has(event.objectId)||!(await this.canAccess(scope,'read')))return undefined;try{return await this.get(event.objectId);}catch{return undefined;}}
  /** Owner-only configuration update, written atomically. The previous file is not kept as history; configuration is not knowledge. */
  async setConfig(mutate:(config:VaultConfig)=>void):Promise<VaultConfig> {this.requireOwner();return withVaultLock(this.root,async()=>{const oldBytes=await this.store.read('mdb.yaml'),config=await this.config();mutate(config);if(config.schemaVersion!==1)throw new MDBError('INVALID_INPUT','Invalid vault config');const next=YAML.stringify(config);await this.assertMutationCapacity(Buffer.byteLength(next) + 4096);if(this.remoteJournal()){if(!await this.store.compareAndSwapPointer('mdb.yaml',Buffer.from(oldBytes).toString('utf8'),next))throw new MDBError('CONFLICT','Vault config changed during update');}else await atomicWrite(this.root,'mdb.yaml',next);return config;});}
  /** Per-call memo of read access by scope: ACL files are read once per distinct scope instead of once per event. A fresh memo per call keeps grant/revoke effective immediately. */
  private readMemo():(scope:Scope)=>Promise<boolean>{const memo=new Map<string,Promise<boolean>>();return scope=>{const key=scopeKey(scope);let hit=memo.get(key);if(!hit){hit=this.canAccess(scope,'read');memo.set(key,hit);}return hit;};}
  /**
   * INTERNAL, for derived-index builders only: a minimal projection of ALL journal records after `sequence`, regardless of the caller's read access.
   * It exposes no content, and builders must still read every object through get(), which enforces access. It exists so an index can notice
   * objects that become readable later (grants) without re-reading the whole journal.
   */
  async journalSince(sequence:number):Promise<Array<Pick<CommitEvent,'sequence'|'transactionId'|'objectId'|'previousRevisionId'|'operation'|'scope'>>> {await this.refreshJournal();return this.journalCache!.events.slice(Math.max(0,sequence)).map(e=>({sequence:e.sequence,transactionId:e.transactionId,objectId:e.objectId,...(e.previousRevisionId?{previousRevisionId:e.previousRevisionId}:{}),operation:e.operation,scope:e.scope}));}
  /** Readable journal records with sequence greater than `sequence`, in order. Cost is proportional to the new records, not the journal. */
  async eventsSince(sequence:number):Promise<CommitEvent[]> {await this.refreshJournal();const tail=this.journalCache!.events.slice(Math.max(0,sequence));const result:CommitEvent[]=[];const canRead=this.readMemo();for(const e of tail)if(await canRead(e.scope))result.push(e);return result;}
  async events():Promise<CommitEvent[]> { const result:CommitEvent[]=[];const canRead=this.readMemo();for(const e of await this.rawEvents())if(await canRead(e.scope))result.push(e);return result; }
  /** Internal replication collision check; reveals only a boolean and requires the replication capability. */
  async replicationIdentityUsed(objectId:string, revisionId:string, capability:object):Promise<boolean>{if(capability!==REPLICATION_INSTALL_CAPABILITY)throw inaccessible();return(await this.rawEvents()).some(event=>event.objectId===objectId||event.revisionId===revisionId);}
  async replicationRevisionIdUsed(revisionId:string, capability:object):Promise<boolean>{if(capability!==REPLICATION_INSTALL_CAPABILITY)throw inaccessible();return(await this.rawEvents()).some(event=>event.revisionId===revisionId);}
  async replicationEvents(capability:object):Promise<CommitEvent[]>{if(capability!==REPLICATION_INSTALL_CAPABILITY)throw inaccessible();return(await this.rawEvents()).slice();}
  async replicationScopeVersion(scope:Scope,actor:ActorContext,capability:object):Promise<string>{if(capability!==REPLICATION_INSTALL_CAPABILITY)throw inaccessible();const grants=scope.type==='workspace'?await this.readJSON<Workspace>(`workspaces/${validId(scope.workspaceId)}/.mdb/workspace.json`).then(workspace=>workspace.grants[actor.actorId]??[]):[];return createHash('sha256').update(JSON.stringify([actor.actorId,actor.permissions.slice().sort(),scopeKey(scope),grants.slice().sort()])).digest('hex').slice(0,24);}
  /** Revisions are immutable, so parsed documents are cached by object/revision (bounded). Callers must treat results as read-only; visibility, purge and ACL are always decided from the journal before a cached document is used, and purge evicts. */
  private revisionCache=new Map<string,Document>();private revisionCacheChars=0;
  private cacheRevision(key:string,doc:Document):void{this.revisionCache.set(key,doc);this.revisionCacheChars+=doc.body.length+256;while(this.revisionCache.size>20000||this.revisionCacheChars>32_000_000){const oldest=this.revisionCache.keys().next().value as string;const gone=this.revisionCache.get(oldest)!;this.revisionCache.delete(oldest);this.revisionCacheChars-=gone.body.length+256;}}
  private evictRevisions(objectId:string):void{for(const[key,doc]of this.revisionCache)if(key.startsWith(objectId+'/')){this.revisionCache.delete(key);this.revisionCacheChars-=doc.body.length+256;}}
  private async documentForEvent(event:CommitEvent):Promise<Document> { return profileAsync('revision.validation', () => this.documentForEventUnprofiled(event)); }
  private async documentForEventUnprofiled(event:CommitEvent):Promise<Document> {
    const key=`${event.objectId}/${event.revisionId}`;let doc=this.revisionCache.get(key);
    if(doc){this.revisionCache.delete(key);this.revisionCache.set(key,doc);}
    else{const bytes=await this.store.read(`.mdb/objects/${event.objectId}/revs/${event.revisionId}.md`);profileBytes('revision.validation.read',bytes.byteLength);doc=parseDocument(Buffer.from(bytes).toString('utf8'));this.cacheRevision(key,doc);}
    if(doc.id!==event.objectId||doc.revisionId!==event.revisionId||doc.path!==event.path||scopeKey(doc.scope)!==scopeKey(event.scope))throw new MDBError('INTERNAL','Revision and journal disagree');
    return doc;
  }
  private async documentsForEvents(events:CommitEvent[]):Promise<Document[]> {
    // Retain this batch independently of the bounded LRU. Loading missing
    // revisions can evict cache hits that belong to the same batch.
    const resolved=new Map<string,Document>();
    for(const event of events){const key=`${event.objectId}/${event.revisionId}`,doc=this.revisionCache.get(key);if(!doc)continue;this.revisionCache.delete(key);this.revisionCache.set(key,doc);resolved.set(key,doc);}
    const missing=events.filter(event=>!resolved.has(`${event.objectId}/${event.revisionId}`));
    if(missing.length){
      const keys=missing.map(event=>`.mdb/objects/${event.objectId}/revs/${event.revisionId}.md`);
      const bytes=this.store.readMany?await this.store.readMany(keys,8):await Promise.all(keys.map(key=>this.store.read(key)));
      for(let i=0;i<missing.length;i++){
        const event=missing[i]!,key=`${event.objectId}/${event.revisionId}`,doc=parseDocument(Buffer.from(bytes[i]!).toString('utf8'));
        if(doc.id!==event.objectId||doc.revisionId!==event.revisionId||doc.path!==event.path||scopeKey(doc.scope)!==scopeKey(event.scope))throw new MDBError('INTERNAL','Revision and journal disagree');
        resolved.set(key,doc);this.cacheRevision(key,doc);
      }
    }
    return events.map(event=>{const doc=resolved.get(`${event.objectId}/${event.revisionId}`);if(!doc)throw new MDBError('INTERNAL','Revision batch read did not return an object');return doc;});
  }
  private async rawDocument(objectId:string,revisionId?:string):Promise<Document> { return profileAsync('vault.raw_document', () => this.rawDocumentUnprofiled(objectId, revisionId)); }
  private async rawDocumentUnprofiled(objectId:string,revisionId?:string):Promise<Document> {
    validId(objectId);if(revisionId)validId(revisionId);await this.refreshJournal();const index=this.journalCache;if(!index)throw inaccessible();const found=revisionId?index.byRevision.get(revisionId):index.latest.get(objectId);const event=found&&found.objectId===objectId?found:undefined;
    if(!event||index.purged.has(objectId))throw inaccessible();await this.requireAccess(event.scope,'read');
    try{return await this.documentForEvent(event);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw inaccessible();throw e;}
  }
  private async resolveReference(uri:string,revisionId?:string):Promise<Document> {const doc=await this.rawDocument(objectIdFromUri(uri),revisionId);if(uri!==doc.uri&&uri!==doc.id)throw inaccessible();return doc;}
  private async visible(doc:Document, includeUnresolvedReferences = false):Promise<Document> {
    const result=structuredClone(doc);const offset=documentBodyLineOffset(doc);if(offset!==undefined)documentBodyLineOffsets.set(result,offset);
    const links:Document['links']=[],evidence:Document['evidence']=[];let unresolvedLink=false,unresolvedEvidence=false;
    for(const l of doc.links){try{await this.resolveReference(l.target,l.revisionId);links.push(l);}catch{unresolvedLink=true;}}
    for(const e of doc.evidence){try{await this.resolveReference(e.uri,e.revisionId);evidence.push(e);}catch{unresolvedEvidence=true;}}
    // Model-derived profile text is sensitive to changes in the source ACL after approval.
    // Do not return the claim with merely stripped references: callers commonly serialize its body.
    const derivedInsight=doc.kind==='user_insight'&&(doc.evidence.length>0||doc.metadata.insightSchema===1||typeof doc.metadata.modelProvider==='string'||Array.isArray(doc.metadata.sources));
    if(derivedInsight){
      // The vault owner can inspect sensitive claims directly. Other actors must
      // not receive a claim that its conservative sensitivity screen marks private,
      // even when the stored metadata was not upgraded at the same time.
      if(!this.owner()&&isSensitive(`${doc.title}\n${doc.body}`))throw inaccessible();
      const refs=new Map<string,{uri:string;revisionId:string}>();
      for(const ref of doc.evidence)refs.set(`${ref.uri}\0${ref.revisionId}`,{uri:ref.uri,revisionId:ref.revisionId});
      if(Array.isArray(doc.metadata.sources))for(const value of doc.metadata.sources){
        if(!value||typeof value!=='object')throw inaccessible();const ref=value as {uri?:unknown;revisionId?:unknown};
        if(typeof ref.uri!=='string'||typeof ref.revisionId!=='string')throw inaccessible();refs.set(`${ref.uri}\0${ref.revisionId}`,{uri:ref.uri,revisionId:ref.revisionId});
      }
      if(!this.owner()&&!refs.size&&!(doc.metadata.evidenceClass==='explicit'&&doc.metadata.origin==='user_statement'))throw inaccessible();
      for(const ref of refs.values())try{
        const id=objectIdFromUri(ref.uri),current=await this.rawDocument(id),cited=await this.rawDocument(id,ref.revisionId);
        // Chat-derived profile claims describe the user's current position. If
        // the user edits that message, an immutable historical revision remains
        // available for audit but must not keep the superseded claim visible.
        if(current.uri!==ref.uri||cited.uri!==ref.uri||current.status==='deleted'||cited.status==='deleted'||cited.kind==='chat_message'&&current.revisionId!==cited.revisionId||current.metadata.sensitivity==='sensitive'||cited.metadata.sensitivity==='sensitive'||!this.owner()&&(isSensitive(`${current.title}\n${current.body}`)||isSensitive(`${cited.title}\n${cited.body}`)))throw inaccessible();
      }catch{throw inaccessible();}
    }
    // Lint needs to distinguish no evidence from inaccessible evidence and detect dangling structured links.
    // Return at most one ID-free marker per category and source document: neither the target nor the number
    // of hidden references is observable. Normal Vault reads retain the historical omission behavior.
    if(includeUnresolvedReferences&&unresolvedLink)links.push({type:'unresolved',target:''});
    if(includeUnresolvedReferences&&unresolvedEvidence)evidence.push({uri:'',revisionId:''});
    result.links=links;result.evidence=evidence;if(!this.owner())for(const key of Object.keys(result.metadata))if(key.startsWith('_'))delete result.metadata[key];return result;
  }
  async get(objectId:string,revisionId?:string):Promise<Document> { return profileAsync('vault.get', async () => this.visible(await this.rawDocument(objectId,revisionId))); }
  async listDocuments(options:{includeHistory?:boolean;scopes?:Scope[];includeUnresolvedReferences?:boolean}={}):Promise<Document[]> {const events=await this.rawEvents();const purged=new Set(events.filter(e=>e.operation==='purge').map(e=>e.objectId));const candidates=options.includeHistory?events: [...new Map(events.map(e=>[e.objectId,e])).values()],canRead=this.readMemo(),readable:CommitEvent[]=[];for(const e of candidates){if(purged.has(e.objectId)||e.operation==='purge'||!(await canRead(e.scope)))continue;if(options.scopes&&!options.scopes.some(s=>s.type===e.scope.type&&(s.type==='global'?e.scope.type==='global'&&s.area===e.scope.area:e.scope.type==='workspace'&&s.workspaceId===e.scope.workspaceId&&(!s.collectionId||e.scope.collectionId===s.collectionId))))continue;readable.push(e);}const result:Document[]=[];for(let at=0;at<readable.length;at+=48){const batch=readable.slice(at,at+48),documents=await this.documentsForEvents(batch);for(let i=0;i<batch.length;i++){const d=documents[i]!;if(d.status!=='deleted'||options.includeHistory)try{result.push(await this.visible(d,options.includeUnresolvedReferences));}catch(error){if(!(error instanceof MDBError)||error.code!=='NOT_FOUND_OR_FORBIDDEN')throw error;}}}return result;}
  private async commit(input:PutInput,previous?:Document,operation='put',idempotencyPayloadHash?:string,replication?:{capability:object;fork:NonNullable<CommitEvent['replicatedFork']>}):Promise<Document> {
    if(replication&&replication.capability!==REPLICATION_INSTALL_CAPABILITY)throw inaccessible();
    validateInput(input);if(input.metadata?.profileRole)this.requireOwner();await this.requireAccess(input.scope,'write');const events=await this.repairJournal();await this.reconcileProjectionTail(events);this.options.fault?.('commit.before_revision');
    const payload = { ...input, idempotencyKey: undefined };
    const replayHash = idempotencyPayloadHash ?? payloadHash(operation, payload);
    if(input.idempotencyKey){const prior=events.find(e=>e.idempotencyKey===input.idempotencyKey&&scopeKey(e.scope)===scopeKey(input.scope));if(prior){if(prior.operation!==operation||prior.idempotencyActorId!==this.actor.actorId||previous&&prior.objectId!==previous.id||(operation!=='ingest'&&prior.idempotencyPayloadHash!==replayHash))throw new MDBError('CONFLICT','Idempotency key was already used for a different operation');return this.rawDocument(prior.objectId,prior.revisionId);}}
    if(previous&&!replication){const latest=events.findLast(e=>e.objectId===previous.id);if(latest?.revisionId!==previous.revisionId)throw new MDBError('CONFLICT','Expected revision is no longer current');}
    const now=this.now().toISOString();const objectId=previous?.id??this.newId('obj');const revisionId=this.newId('rev');const doc:Document={id:objectId,revisionId,revisionNumber:(previous?.revisionNumber??0)+1,...(previous?{previousRevisionId:previous.revisionId}:{}),scope:input.scope,kind:input.kind,title:input.title,body:input.body,tags:input.tags??[],links:input.links??[],evidence:input.evidence??[],status:input.status??'active',createdAt:previous?.createdAt??now,updatedAt:now,createdBy:previous?.createdBy??this.actor.actorId,metadata:input.metadata??{},path:'',uri:documentUri(objectId,input.scope)};doc.path=viewPath(doc);if(!previous && events.some(e=>e.path===doc.path&&e.operation!=='purge'))throw new MDBError('CONFLICT','Named profile already exists; patch its current revision');
    const text=serializeDocument(doc);await this.options.beforeCommit?.(doc,operation);await this.assertMutationCapacity(Buffer.byteLength(text) + 4096);await this.store.putImmutable(`.mdb/objects/${objectId}/revs/${revisionId}.md`,Buffer.from(text));killAtBoundary('local.after_revision_write');this.options.fault?.('after_revision');this.options.fault?.('after_revision_write');this.options.fault?.('revision.after_dirsync');
    const event:CommitEvent={sequence:events.length+1,transactionId:this.newId('tx'),objectId,revisionId,...(previous?{previousRevisionId:previous.revisionId}:{}),path:doc.path,scope:doc.scope,operation,timestamp:now,revisionSha256:createHash('sha256').update(text).digest('hex'),...(replication?{replicatedFork:replication.fork}:{}),...(input.idempotencyKey?{idempotencyKey:input.idempotencyKey,idempotencyPayloadHash:replayHash,idempotencyActorId:this.actor.actorId}:{})};
    this.options.fault?.('journal.before_append');const committedEvent = await this.appendEvent(event);killAtBoundary('local.after_journal_append');/* commit point: durable append or conditional S3 head publication */this.options.fault?.('after_journal');this.options.fault?.('after_journal_append');this.options.fault?.('before_view');this.options.fault?.('before_view_update');
    /* The commit point has passed. Head and view are rebuildable projections of the journal: flushProjections() and recovery repair them. */this.options.fault?.('head.before_replace');await atomicWriteVolatile(this.root,`.mdb/heads/${objectId}.json`,JSON.stringify(committedEvent),this.options.fault);this.options.fault?.('view.before_replace');await atomicWriteVolatile(this.root,doc.path,text,this.options.fault);this.noteProjections([doc.path]);this.options.fault?.('view.after_replace');this.options.fault?.('commit.before_ack');await this.options.onCommit?.(doc,committedEvent);return doc;
  }
  private async assertMutationCapacity(estimatedGrowthBytes: number): Promise<void> {
    if (this.remoteJournal()) return; // remote backends have their own capacity and acknowledgement contract
    await assertDurableWriteCapacity(this.root, estimatedGrowthBytes, process.env, this.options.storageAvailableBytes ? await this.options.storageAvailableBytes() : undefined);
  }
  async put(input:PutInput):Promise<Document> { return this.visible(await withVaultLock(this.root,()=>this.commit(input))); }
  /** Internal replica import. Preserves the validated immutable bytes and ids; not exposed by CLI, MCP or SDK. */
  async installReplicatedRevision(bytes: Uint8Array, event: CommitEvent, capability: object): Promise<void> {
    if (capability !== REPLICATION_INSTALL_CAPABILITY) throw new MDBError('NOT_FOUND_OR_FORBIDDEN','Replica capability required');
    const text = Buffer.from(bytes).toString('utf8'), doc = parseDocument(text);
    if (doc.id !== event.objectId || doc.revisionId !== event.revisionId || scopeKey(doc.scope) !== scopeKey(event.scope) ) throw new MDBError('INVALID_INPUT','Replicated revision and event disagree');
    if (!(await this.canAccess(event.scope,'write'))) throw inaccessible();
    await withVaultLock(this.root, async () => {
      const events = await this.repairJournal();
      const current = events.findLast(e => e.objectId === event.objectId);
      if (current?.revisionId === event.revisionId) return;
      if ((current?.revisionId ?? null) !== (event.previousRevisionId ?? null)) throw new MDBError('CONFLICT','Replica parent is not current');
      killAtBoundary('install_remote.before_revision_write');await this.store.putImmutable(`.mdb/objects/${event.objectId}/revs/${event.revisionId}.md`, Buffer.from(bytes));killAtBoundary('install_remote.after_revision_before_journal');
      const imported: CommitEvent = { ...event, sequence: events.length + 1, operation: 'replica_import', revisionSha256: createHash('sha256').update(bytes).digest('hex') };
      await this.appendEvent(imported);killAtBoundary('install_remote.after_journal_before_cursor');
      await atomicWriteVolatile(this.root,`.mdb/heads/${doc.id}.json`,JSON.stringify(imported),this.options.fault);
      await atomicWriteVolatile(this.root,doc.path,text,this.options.fault);
      this.noteProjections([doc.path]);
    });
  }
  /** Install the server side of a recorded replica conflict while retaining the local candidate revision. */
  async installReplicaConflictRevision(bytes:Uint8Array,event:CommitEvent,capability:object):Promise<void>{
    if(capability!==REPLICATION_INSTALL_CAPABILITY)throw inaccessible();const text=Buffer.from(bytes).toString('utf8'),doc=parseDocument(text);
    if(doc.id!==event.objectId||doc.revisionId!==event.revisionId||scopeKey(doc.scope)!==scopeKey(event.scope))throw new MDBError('INVALID_INPUT','Conflict revision and event disagree');
    if(!(await this.canAccess(event.scope,'write')))throw inaccessible();
    await withVaultLock(this.root,async()=>{const events=await this.repairJournal(),prior=events.find(item=>item.objectId===event.objectId&&item.revisionId===event.revisionId);if(prior){const existing=Buffer.from(await this.store.read(`.mdb/objects/${event.objectId}/revs/${event.revisionId}.md`));if(!existing.equals(Buffer.from(bytes)))throw new MDBError('CONFLICT','Revision ID collision');return;}
      killAtBoundary('fork_install.before_conflict_record');await this.store.putImmutable(`.mdb/objects/${event.objectId}/revs/${event.revisionId}.md`,Buffer.from(bytes));const imported={...event,sequence:events.length+1,operation:'replica_import',revisionSha256:createHash('sha256').update(bytes).digest('hex')};await this.appendEvent(imported);killAtBoundary('fork_install.after_conflict_record');await atomicWriteVolatile(this.root,`.mdb/heads/${doc.id}.json`,JSON.stringify(imported),this.options.fault);await atomicWriteVolatile(this.root,doc.path,text,this.options.fault);this.evictRevisions(doc.id);this.noteProjections([doc.path]);
    });
  }
  /** Install an authoritative branch when a local provisional child already diverged from its parent. */
  async installReplicatedFork(bytes:Uint8Array,event:CommitEvent,baseRevisionId:string,candidateRevisionIds:string[],capability:object):Promise<void>{
    if(capability!==REPLICATION_INSTALL_CAPABILITY)throw inaccessible();
    if(!candidateRevisionIds.length||candidateRevisionIds.length>100||candidateRevisionIds.includes(event.revisionId))throw new MDBError('INVALID_INPUT','Invalid replicated fork candidates');
    const raw=Buffer.from(bytes),text=raw.toString('utf8'),doc=parseDocument(text);
    if(doc.id!==event.objectId||doc.revisionId!==event.revisionId||scopeKey(doc.scope)!==scopeKey(event.scope)||(event.previousRevisionId??null)!==baseRevisionId)throw new MDBError('INVALID_INPUT','Replicated fork and event disagree');
    if(!(await this.canAccess(event.scope,'write')))throw inaccessible();
    await withVaultLock(this.root,async()=>{const events=await this.repairJournal(),current=events.findLast(e=>e.objectId===event.objectId);if(current?.revisionId===event.revisionId)return;
      const base=events.find(e=>e.objectId===event.objectId&&e.revisionId===baseRevisionId);if(!base)throw new MDBError('CONFLICT','Fork base revision is missing');
      const candidates=candidateRevisionIds.map(id=>events.find(e=>e.objectId===event.objectId&&e.revisionId===id));
      if(candidates.some((candidate,index)=>!candidate||(candidate.previousRevisionId??null)!==(index?candidateRevisionIds[index-1]:baseRevisionId)))throw new MDBError('CONFLICT','Fork candidate chain is invalid');
      if((current?.revisionId??null)!==candidateRevisionIds.at(-1))throw new MDBError('CONFLICT','Fork candidate is not the current local head');
      killAtBoundary('fork_install.before_conflict_record');await this.store.putImmutable(`.mdb/objects/${event.objectId}/revs/${event.revisionId}.md`,raw);
      const imported:CommitEvent={...event,sequence:events.length+1,operation:'replica_import',replicatedFork:{baseRevisionId,candidateRevisionIds:[...candidateRevisionIds]},revisionSha256:createHash('sha256').update(raw).digest('hex')};
      await this.appendEvent(imported);killAtBoundary('fork_install.after_conflict_record');await atomicWriteVolatile(this.root,`.mdb/heads/${doc.id}.json`,JSON.stringify(imported),this.options.fault);await atomicWriteVolatile(this.root,doc.path,text,this.options.fault);this.evictRevisions(doc.id);this.noteProjections([doc.path]);
    });
  }
  /** Create a merge revision on the pulled server head while retaining a local candidate branch. */
  async replicaResolveConflict(input:{objectId:string;serverHeadId:string;candidateRevisionIds:string[];baseRevisionId:string;title:string;body:string},capability:object):Promise<Document>{
    if(capability!==REPLICATION_INSTALL_CAPABILITY)throw inaccessible();if(!input.candidateRevisionIds.length)throw new MDBError('INVALID_INPUT','Conflict resolution requires a candidate');
    return this.visible(await withVaultLock(this.root,async()=>{const events=await this.repairJournal(),base=await this.rawDocument(input.objectId,input.serverHeadId),current=events.findLast(event=>event.objectId===input.objectId);if(!current||current.revisionId===input.serverHeadId)throw new MDBError('CONFLICT','Local candidate branch is not current');
      const byId=new Map(events.filter(event=>event.objectId===input.objectId).map(event=>[event.revisionId,event]));for(const id of input.candidateRevisionIds)if(!byId.has(id))throw new MDBError('CONFLICT','Conflict candidate revision is missing');
      const prior=byId.get(input.candidateRevisionIds.at(-1)!);if(prior?.revisionId!==current.revisionId)throw new MDBError('CONFLICT','Conflict candidate is not the local head');
      const resolvedFrom=[...input.candidateRevisionIds,input.serverHeadId];return this.commit({scope:base.scope,kind:base.kind,title:input.title,body:input.body,tags:base.tags,links:base.links,evidence:base.evidence,status:base.status,metadata:{...base.metadata,resolvedFrom}},base,'replica_resolution',undefined,{capability,fork:{baseRevisionId:input.baseRevisionId,candidateRevisionIds:[...input.candidateRevisionIds]}});
    }));
  }
  /** Reconcile only a locally committed replica_push after the server accepts it. */
  async reconcileReplicaRevision(event: CommitEvent, bytes: Uint8Array, capability: object): Promise<void> {
    if(capability!==REPLICATION_INSTALL_CAPABILITY)throw inaccessible();
    const incoming=parseDocument(Buffer.from(bytes).toString('utf8'));
    if(incoming.id!==event.objectId||incoming.revisionId!==event.revisionId||scopeKey(incoming.scope)!==scopeKey(event.scope))throw new MDBError('INVALID_INPUT','Authoritative revision and event disagree');
    await withVaultLock(this.root,async()=>{
      const events=await this.rawEvents(),index=events.findIndex(item=>item.objectId===event.objectId&&item.revisionId===event.revisionId&&!['replica_import','replica_push','purge','delete'].includes(item.operation));
      if(index<0)throw new MDBError('NOT_FOUND_OR_FORBIDDEN','Accepted provisional revision not found');
      const current=events[index]!,oldBytes=Buffer.from(await this.store.read(`.mdb/objects/${event.objectId}/revs/${event.revisionId}.md`)),old=parseDocument(oldBytes.toString('utf8'));
      const stable=(doc:Document)=>{const{createdBy,createdAt,updatedAt,...rest}=doc;return rest;};
      if(JSON.stringify(stable(old))!==JSON.stringify(stable(incoming)))throw new MDBError('CONFLICT','Authoritative revision changed client-owned fields');
      const digest=createHash('sha256').update(bytes).digest('hex');
      if(oldBytes.equals(Buffer.from(bytes))&&current.revisionSha256===digest){await atomicWriteVolatile(this.root,`.mdb/heads/${event.objectId}.json`,JSON.stringify(current),this.options.fault);await atomicWriteVolatile(this.root,incoming.path,Buffer.from(bytes).toString('utf8'),this.options.fault);return;}
      this.options.fault?.('replica_reconcile.before_replace');
      await atomicWrite(this.root,`.mdb/objects/${event.objectId}/revs/${event.revisionId}.md`,bytes,this.options.fault);
      this.evictRevisions(event.objectId);
      const updated={...current,revisionSha256:digest};events[index]=updated;
      await atomicWrite(this.root,'.mdb/events/commits.jsonl',events.map(item=>JSON.stringify(item)).join('\n')+'\n',this.options.fault);
      this.journalCache=undefined;
      this.options.fault?.('replica_reconcile.after_replace');
      await atomicWriteVolatile(this.root,`.mdb/heads/${event.objectId}.json`,JSON.stringify(updated),this.options.fault);
      await atomicWriteVolatile(this.root,incoming.path,Buffer.from(bytes).toString('utf8'),this.options.fault);
    });
  }
  async patch(input:PatchInput):Promise<Document> {return this.visible(await withVaultLock(this.root,async()=>{const previous=await this.rawDocument(input.objectId);await this.requireAccess(previous.scope,'write');if(previous.kind==='source')throw new MDBError('INVALID_INPUT','Source manifests are immutable; import a new source');if(input.metadataPatch&&Object.keys(input.metadataPatch).some(k=>k.startsWith('_')))throw new MDBError('INVALID_INPUT','Protected metadata cannot be patched');if(input.metadataRemove!==undefined&&(!Array.isArray(input.metadataRemove)||input.metadataRemove.length>40||input.metadataRemove.some(k=>typeof k!=='string'||!k||k.startsWith('_'))))throw new MDBError('INVALID_INPUT','metadataRemove must list up to 40 unprotected metadata keys');const patch={...input,idempotencyKey:undefined};const replayHash=payloadHash('patch',patch);if(input.idempotencyKey){const prior=(await this.rawEvents()).find(e=>e.idempotencyKey===input.idempotencyKey&&scopeKey(e.scope)===scopeKey(previous.scope));if(prior){if(prior.idempotencyPayloadHash!==replayHash||prior.idempotencyActorId!==this.actor.actorId||prior.operation!=='patch'||prior.objectId!==previous.id)throw new MDBError('CONFLICT','Idempotency key was already used for a different operation');return this.rawDocument(prior.objectId,prior.revisionId);}}if(previous.revisionId!==input.expectedRevisionId)throw new MDBError('CONFLICT','Expected revision is no longer current');return this.commit({scope:previous.scope,kind:previous.kind,title:input.title??previous.title,body:input.body??previous.body,tags:input.tags??previous.tags,links:input.links??previous.links,evidence:input.evidence??previous.evidence,status:input.status??previous.status,metadata:Object.fromEntries(Object.entries({...previous.metadata,...input.metadataPatch}).filter(([k])=>!input.metadataRemove?.includes(k))),idempotencyKey:input.idempotencyKey},previous,'patch',replayHash);}));}
  async delete(objectId:string,expectedRevisionId:string,idempotencyKey?:string):Promise<Document> {return this.visible(await withVaultLock(this.root,async()=>{const d=await this.rawDocument(objectId);await this.requireAccess(d.scope,'write');if(idempotencyKey){const prior=(await this.rawEvents()).find(e=>e.idempotencyKey===idempotencyKey&&e.operation==='delete'&&e.objectId===objectId);if(prior){if(prior.idempotencyActorId!==this.actor.actorId||prior.previousRevisionId!==expectedRevisionId)throw new MDBError('CONFLICT','Idempotency key was already used for a different operation');return this.rawDocument(objectId,prior.revisionId);}}if(d.revisionId!==expectedRevisionId)throw new MDBError('CONFLICT','Expected revision is no longer current');return this.commit({...d,body:'',status:'deleted',...(idempotencyKey?{idempotencyKey}:{})},d,'delete');}));}
  async history(objectId:string):Promise<Document[]> {await this.rawDocument(objectId);const result:Document[]=[];for(const e of await this.rawEvents())if(e.objectId===objectId)result.push(await this.get(objectId,e.revisionId));return result;}
  async restore(objectId:string,revisionId:string,expectedRevisionId:string,idempotencyKey?:string):Promise<Document> {return this.visible(await withVaultLock(this.root,async()=>{const current=await this.rawDocument(objectId);await this.requireAccess(current.scope,'write');const old=await this.rawDocument(objectId,revisionId);if(idempotencyKey){const prior=(await this.rawEvents()).find(e=>e.idempotencyKey===idempotencyKey&&e.operation==='restore'&&e.objectId===objectId);if(prior){if(prior.idempotencyActorId!==this.actor.actorId||prior.previousRevisionId!==expectedRevisionId||prior.idempotencyPayloadHash!==payloadHash('restore',{...old,idempotencyKey:undefined}))throw new MDBError('CONFLICT','Idempotency key was already used for a different operation');return this.rawDocument(objectId,prior.revisionId);}}if(current.revisionId!==expectedRevisionId)throw new MDBError('CONFLICT','Expected revision is no longer current');return this.commit({...old,...(idempotencyKey?{ idempotencyKey }: {})},current,'restore');}));}
  async diff(objectId:string,from:string,to:string):Promise<{from:string;to:string;diff:string}> {const a=await this.get(objectId,from),b=await this.get(objectId,to);return{from,to,diff:`--- ${from}\n+++ ${to}\n${a.body.split('\n').map(l=>'-'+l).join('\n')}\n${b.body.split('\n').map(l=>'+'+l).join('\n')}`};}
  async ingest(file:string,scope:Scope,options:{title?:string;metadata?:Record<string,unknown>;idempotencyKey?:string}={}):Promise<Document> {
    await this.requireAccess(scope,'write');const absolute=path.resolve(file);const stat=await fs.lstat(absolute);if(!stat.isFile()||stat.isSymbolicLink())throw new MDBError('INVALID_INPUT','Import requires an explicit regular file');const bytes=await fs.readFile(absolute);const hash=createHash('sha256').update(bytes).digest('hex');const name=path.basename(absolute).replace(/[^a-zA-Z0-9._-]/g,'_');const originalKey=`${scopeRoot(scope)}/sources/originals/${hash}/${name}`;const textNative=['.md','.markdown','.txt'].includes(path.extname(name).toLowerCase());
    return this.visible(await withVaultLock(this.root,async()=>{await this.store.putImmutable(originalKey,bytes);return this.commit({scope,kind:'source',title:options.title??name,body:textNative?bytes.toString('utf8'):`Binary attachment preserved; extraction unavailable for ${path.extname(name)||'unknown format'}.`,metadata:{sha256:hash,originalPath:originalKey,originalName:name,size:bytes.length,importPath:absolute,importedAt:new Date().toISOString(),extraction:textNative?'native-text':'unavailable',untrusted:true,consent:'explicit-path',...options.metadata},idempotencyKey:options.idempotencyKey??`source:${scopeKey(scope)}:${hash}:${name}`},undefined,'ingest');}));
  }
  private async repairJournal():Promise<CommitEvent[]> {const events=await this.rawEvents();if(this.remoteJournal())return events;const stat=await fs.stat(await safePath(this.root,'.mdb/events/commits.jsonl'));if(this.journalCache&&stat.size!==this.journalCache.offset){/* unterminated torn tail: rewrite the journal as exactly its committed records */this.options.fault?.('recover.before_journal_repair');await atomicWrite(this.root,'.mdb/events/commits.jsonl',events.map(e=>JSON.stringify(e)+'\n').join(''),this.options.fault);this.journalCache=undefined;await this.rawEvents();this.options.fault?.('recover.after_journal_repair');}return events;}
  /** True when `bytes` is exactly one of this object's committed revisions (a stale view left by a crash, not an external edit). */
  private async isCommittedRevision(objectId:string,events:CommitEvent[],bytes:Uint8Array):Promise<boolean> {for(const e of events){if(e.objectId!==objectId||e.operation==='purge')continue;try{if(Buffer.from(await this.store.read(`.mdb/objects/${objectId}/revs/${e.revisionId}.md`)).equals(Buffer.from(bytes)))return true;}catch{/* missing revision is reported by verify */}}return false;}
  /** Projection files (heads, views) written since the last flush, with a version so a rewrite after the flush snapshot is not forgotten. */
  private readonly pendingProjections=new Map<string,number>();private flushTimer?:NodeJS.Timeout;private flushChain:Promise<unknown>=Promise.resolve();private projectionVersion=0;private tailReconciled=false;
  private projectionLastWrite=0;private projectionFirstWrite?:number;
  private noteProjections(keys:string[]):void{const now=Date.now();for(const key of keys)this.pendingProjections.set(key,++this.projectionVersion);this.projectionLastWrite=now;this.projectionFirstWrite??=now;if(!this.flushTimer)this.scheduleProjectionFlush(PROJECTION_IDLE_MS);}
  private scheduleProjectionFlush(delay:number):void{
    this.flushTimer=setTimeout(()=>{this.flushTimer=undefined;const now=Date.now(),idle=now-this.projectionLastWrite,age=now-(this.projectionFirstWrite??now);
      if(idle<PROJECTION_IDLE_MS&&age<PROJECTION_MAX_AGE_MS){this.scheduleProjectionFlush(Math.max(10,Math.min(PROJECTION_IDLE_MS-idle,PROJECTION_MAX_AGE_MS-age)));return;}/* writes are still arriving: wait for a quiet moment */
      this.projectionFirstWrite=undefined;void this.flushProjections().catch(()=>undefined);},delay);
    this.flushTimer.unref();exitFlush.add(this);hookExit();
  }
  /** Makes pending head/view writes durable (fsync each file, then each directory once). Never fails or delays an acknowledged commit: errors leave the keys pending for the next flush. */
  flushProjections():Promise<{files:number;directories:number}>{
    const run=this.flushChain.then(async()=>{const snapshot=[...this.pendingProjections];if(!snapshot.length){exitFlush.delete(this);return{files:0,directories:0};}const result=await flushKeys(this.root,snapshot.map(([key])=>key),this.options.fault);for(const[key,version]of snapshot)if(this.pendingProjections.get(key)===version)this.pendingProjections.delete(key);if(!this.pendingProjections.size)exitFlush.delete(this);return result;});
    this.flushChain=run.then(()=>undefined,()=>undefined);return run;
  }
  /** Torn or empty projection left by a power loss: a (possibly empty) strict prefix of the committed bytes is a crash artifact, never an external edit. */
  private isTornPrefix(current:Uint8Array,committed:Uint8Array):boolean{return current.byteLength<committed.byteLength&&Buffer.from(committed).subarray(0,current.byteLength).equals(Buffer.from(current));}
  /** Restores one object's view and head from its committed revision. Durable (fsynced) because it is a repair; `recover()` always rewrites the head and also quarantines a diverging (externally edited) view; tail reconciliation repairs only crash artifacts (absent, empty/torn prefix, or an older committed revision) and leaves anything else for reconcile(). Returns true when the view had to be rewritten. */
  private async repairProjection(e:CommitEvent,events:CommitEvent[],bytes:Uint8Array,mode:'recover'|'tail'='tail'):Promise<boolean>{
    let current:Uint8Array|undefined;
    try{current=await fs.readFile(await safePath(this.root,e.path));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    let repaired=false;
    if(!current||!Buffer.from(current).equals(Buffer.from(bytes))){
      const crashArtifact=!current||this.isTornPrefix(current,bytes)||await this.isCommittedRevision(e.objectId,events,current);
      if(mode==='tail'&&!crashArtifact)return false;/* diverging content may be a deliberate external edit awaiting reconcile(): automatic tail repair never overwrites or quarantines it; only recover() does */
      if(current&&current.byteLength>0&&!this.isTornPrefix(current,bytes)&&!crashArtifact)await this.store.putImmutable(`.mdb/quarantine/${id('external')}.md`,current);
      this.options.fault?.('recover.before_view_repair');await atomicWrite(this.root,e.path,bytes,this.options.fault);this.options.fault?.('recover.after_view_repair');repaired=true;
    }
    const headKey=`.mdb/heads/${e.objectId}.json`;const head=JSON.stringify(e);let currentHead:string|undefined;try{currentHead=await fs.readFile(await safePath(this.root,headKey),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    // Recovery validates every committed revision, but a matching durable head is
    // already correct. Rewriting it unconditionally turns a read-only recovery
    // into one fsync per object and holds the vault lock for the entire corpus.
    if(currentHead!==head){this.options.fault?.('recover.before_head_write');await atomicWrite(this.root,headKey,head,this.options.fault);}
    return repaired;
  }
  private async projectionIsCurrent(e:CommitEvent,bytes:Uint8Array):Promise<boolean>{
    let view:Buffer;try{view=await fs.readFile(await safePath(this.root,e.path));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
    if(!view.equals(Buffer.from(bytes)))return false;
    let head:string;try{head=await fs.readFile(await safePath(this.root,`.mdb/heads/${e.objectId}.json`),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
    return head===JSON.stringify(e);
  }
  /**
   * First owner operation of a Vault instance: re-check the projections of the most recent journal events and repair any that a power loss left stale, absent or torn. Bounded (the
   * un-flushed window is at most the flush interval of commits), runs inside the vault lock (callers hold it), and is skipped for non-owner actors. recover() covers everything.
   */
  private async reconcileProjectionTail(events:CommitEvent[]):Promise<void>{
    if(this.tailReconciled||!this.actor.permissions.includes('*'))return;this.tailReconciled=true;
    const tail=events.slice(-PROJECTION_TAIL_EVENTS);const purged=new Set(events.filter(e=>e.operation==='purge').map(e=>e.objectId));const latest=new Map(events.map(e=>[e.objectId,e]));
    for(const objectId of new Set(tail.map(e=>e.objectId))){
      const e=latest.get(objectId)!;if(purged.has(objectId)||e.operation==='purge')continue;
      let bytes:Uint8Array;try{bytes=await this.store.read(`.mdb/objects/${e.objectId}/revs/${e.revisionId}.md`);}catch{continue;/* a missing revision is reported by verify and recover */}
      if(e.revisionSha256&&createHash('sha256').update(bytes).digest('hex')!==e.revisionSha256)continue;
      await this.repairProjection(e,events,bytes);
    }
  }
  private async findTemps(directory:string):Promise<string[]> {let entries:string[];try{entries=await fs.readdir(await safePath(this.root,directory));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'||(e as NodeJS.ErrnoException).code==='ENOTDIR')return [];throw e;}return entries.filter(name=>/\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(name)).map(name=>`${directory}/${name}`);}
  async recover(capability?:object):Promise<{committed:number;repaired:number;orphans:number;tempRemoved:number}> {
    if(capability!==REPLICATION_INSTALL_CAPABILITY)this.requireOwner();
    // Journal repair and purge completion are serialized. The potentially large
    // verification pass is read-only and runs outside the global writer lock.
    let events=await withVaultLock(this.root,async()=>{let current=await this.repairJournal();for(const event of current)if(event.operation==='purge')await this.finishPurge(event.objectId);return this.rawEvents();});
    const processed=new Map<string,string>();let repaired=0;
    const latestFor=(source:CommitEvent[])=>new Map(source.map(e=>[e.objectId,e]));
    const verifyAndRepair=async(e:CommitEvent,source:CommitEvent[],alreadyLocked:boolean):Promise<void>=>{
      if(e.operation==='purge'){processed.set(e.objectId,e.revisionId);return;}
      const bytes=await this.store.read(`.mdb/objects/${e.objectId}/revs/${e.revisionId}.md`);
      if(e.revisionSha256&&createHash('sha256').update(bytes).digest('hex')!==e.revisionSha256)throw new MDBError('INTERNAL',`Revision content hash mismatch: ${e.objectId}/${e.revisionId}`);
      const doc=parseDocument(Buffer.from(bytes).toString('utf8'));
      if(doc.id!==e.objectId||doc.revisionId!==e.revisionId||doc.path!==e.path||scopeKey(doc.scope)!==scopeKey(e.scope))throw new MDBError('INTERNAL','Revision and journal disagree');
      if(await this.projectionIsCurrent(e,bytes)){processed.set(e.objectId,e.revisionId);return;}
      const repair=async(latest:CommitEvent[],chosen:CommitEvent)=>{
        if(chosen.operation==='purge'){processed.set(chosen.objectId,chosen.revisionId);return;}
        const currentBytes=await this.store.read(`.mdb/objects/${chosen.objectId}/revs/${chosen.revisionId}.md`);
        if(chosen.revisionSha256&&createHash('sha256').update(currentBytes).digest('hex')!==chosen.revisionSha256)throw new MDBError('INTERNAL',`Revision content hash mismatch: ${chosen.objectId}/${chosen.revisionId}`);
        const currentDoc=parseDocument(Buffer.from(currentBytes).toString('utf8'));
        if(currentDoc.id!==chosen.objectId||currentDoc.revisionId!==chosen.revisionId||currentDoc.path!==chosen.path||scopeKey(currentDoc.scope)!==scopeKey(chosen.scope))throw new MDBError('INTERNAL','Revision and journal disagree');
        if(!await this.projectionIsCurrent(chosen,currentBytes)&&await this.repairProjection(chosen,latest,currentBytes,'recover'))repaired++;
        processed.set(chosen.objectId,chosen.revisionId);
      };
      if(alreadyLocked){await repair(source,e);return;}
      await withVaultLock(this.root,async()=>{const current=await this.repairJournal();const chosen=latestFor(current).get(e.objectId);if(chosen)await repair(current,chosen);});
    };
    let latest=latestFor(events);
    for(const e of latest.values())await verifyAndRepair(e,events,false);
    // A writer may commit while the read-only pass is in progress. Reconcile
    // only those changed heads under the lock before counting orphans/sweeping.
    // Directory scans are also read-only. Do them outside the writer lock, then
    // reconcile the journal once more and delete only the exact temporary paths
    // discovered before acquiring the lock.
    events=await withVaultLock(this.root,async()=>{const current=await this.repairJournal();for(const event of current)if(event.operation==='purge')await this.finishPurge(event.objectId);return this.rawEvents();});
    latest=latestFor(events);const purged=new Set(events.filter(e=>e.operation==='purge').map(e=>e.objectId));
    const sweep=new Set<string>(['.mdb/heads','.mdb/events']);
    for(const e of latest.values())if(!purged.has(e.objectId)){sweep.add(e.path.includes('/')?e.path.slice(0,e.path.lastIndexOf('/')):'.');sweep.add(`.mdb/objects/${e.objectId}/revs`);}
    sweep.delete('.');let revisionKeys:string[]=[];const objectTemps:string[]=[];for await(const entry of this.store.list('.mdb/objects')){if(entry.key.endsWith('.md'))revisionKeys.push(entry.key);else if(/\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(entry.key))objectTemps.push(entry.key);}
    const tempCandidates=[...objectTemps];for(const directory of sweep)tempCandidates.push(...await this.findTemps(directory));
    return withVaultLock(this.root,async()=>{
      events=await this.repairJournal();for(const event of events)if(event.operation==='purge')await this.finishPurge(event.objectId);latest=latestFor(events);
      for(const e of latest.values())if(processed.get(e.objectId)!==e.revisionId)await verifyAndRepair(e,events,true);
      const committed=new Set(events.map(e=>`.mdb/objects/${e.objectId}/revs/${e.revisionId}.md`));
      const orphans=revisionKeys.filter(key=>!committed.has(key)).length;
      let tempRemoved=0;for(const key of tempCandidates){if(!/\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(key))continue;try{await fs.rm(await safePath(this.root,key),{force:true});tempRemoved++;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      await this.flushProjections().catch(()=>undefined);return{committed:events.length,repaired,orphans,tempRemoved};
    });
  }
  async reconcile():Promise<{imported:number;conflicts:number}> {return withVaultLock(this.root,async()=>{const events=await this.repairJournal();await this.reconcileProjectionTail(events);const latest=[...new Map(events.map(e=>[e.objectId,e])).values()];let imported=0,conflicts=0;for(const e of latest){if(e.operation==='purge'||!(await this.canAccess(e.scope,'write'))||!(await this.canAccess(e.scope,'read')))continue;const canonical=Buffer.from(await this.store.read(`.mdb/objects/${e.objectId}/revs/${e.revisionId}.md`)).toString('utf8');let edited:string;try{edited=Buffer.from(await this.store.read(e.path)).toString('utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}if(edited===canonical)continue;try{const d=parseDocument(edited),original=parseDocument(canonical);if(d.id!==e.objectId||d.revisionId!==e.revisionId||scopeKey(d.scope)!==scopeKey(original.scope)||d.kind!==original.kind||d.path!==original.path||d.uri!==original.uri||original.kind==='source')throw new MDBError('CONFLICT','External edit changed protected metadata');await this.commit({scope:original.scope,kind:original.kind,title:d.title,body:d.body,tags:d.tags,links:d.links,evidence:d.evidence,status:d.status,metadata:original.metadata},original,'external_edit');imported++;}catch{await this.store.putImmutable(`.mdb/quarantine/${this.newId('conflict')}.md`,Buffer.from(edited));await atomicWrite(this.root,e.path,canonical);conflicts++;}}return{imported,conflicts};});}
  async promote(objectId:string,to:Scope,sanitizedBody:string,title?:string):Promise<Document> {const source=await this.rawDocument(objectId);await this.requireAccess(source.scope,'promote');if(to.type!=='global')throw new MDBError('INVALID_INPUT','Promotion target must be global');await this.requireAccess(to,'write');if(!sanitizedBody.trim())throw new MDBError('INVALID_INPUT','Promotion requires an explicitly sanitized derivative');return this.put({scope:to,kind:source.kind==='source'?'wiki_page':source.kind,title:title??'Promoted knowledge',body:sanitizedBody,status:'promoted',tags:[],metadata:{_promotionOrigin:{uri:source.uri,revisionId:source.revisionId},reviewed:true}});}
  private async appendEvent(event:CommitEvent):Promise<CommitEvent> {
    const remote = this.remoteJournal();
    if (remote) return remote.appendCommittedEvent(event);
    await this.assertMutationCapacity(Buffer.byteLength(JSON.stringify(event)) + 4096);
    const journal=await safePath(this.root,'.mdb/events/commits.jsonl');
    await profileAsync('journal.append_fsync', async () => {
      const handle=await fs.open(journal,'a',0o600);
      try {
        const record=JSON.stringify(event)+'\n';
        if(this.options.fault&&record.length>1){
          const split=Math.floor(record.length/2);
          await handle.writeFile(record.slice(0,split));
          this.options.fault('journal.partial_append');
          await handle.writeFile(record.slice(split));
        }else await handle.writeFile(record);
        this.options.fault?.('journal.after_append_before_fsync');
        this.options.fault?.('journal.fsync.before');
        await profileAsync('fsync.file', () => handle.sync());
        this.options.fault?.('journal.fsync.after');
      } finally { await handle.close(); }
    });
    this.options.fault?.('journal.after_fsync');
    return event;
  }
  private async finishPurge(objectId:string):Promise<number> {
    const intentKey=`.mdb/purge-intents/${objectId}.json`;let intent:{path:string;originalPaths:string[]};
    try{intent=await this.readJSON(intentKey);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}
    this.evictRevisions(objectId);let removed=0;for await(const entry of this.store.list(`.mdb/objects/${objectId}`)){await this.store.removeForAuthorizedPurge(entry.key);removed++;}
    await this.store.removeForAuthorizedPurge(intent.path);await this.store.removeForAuthorizedPurge(`.mdb/heads/${objectId}.json`);for(const key of intent.originalPaths){await this.store.removeForAuthorizedPurge(key);removed++;}
    for(const key of ['.mdb/cache','.mdb/indexes','.mdb/quarantine','.mdb/jobs','.mdb/intelligence'])for await(const entry of this.store.list(key)){await this.store.removeForAuthorizedPurge(entry.key);removed++;}
    for(const key of ['.mdb/global-index.sqlite','.mdb/global-index.sqlite-wal','.mdb/global-index.sqlite-shm'])await this.store.removeForAuthorizedPurge(key);
    for(const workspace of await this.listWorkspaces())for(const suffix of ['','-wal','-shm'])await this.store.removeForAuthorizedPurge(`workspaces/${workspace.id}/.mdb/index.sqlite${suffix}`);
    for(const key of ['MAIN_INDEX.md','WORKSPACE_REGISTRY.md','wiki/INDEX.md','shared/INDEX.md','discoveries/INDEX.md'])await atomicWrite(this.root,key,'# Index\n\nRebuild required after privacy purge.\n');
    for(const workspace of await this.listWorkspaces()){await atomicWrite(this.root,`workspaces/${workspace.id}/INDEX.md`,'# Index\n\nRebuild required after privacy purge.\n');for(const collection of await this.listCollections(workspace.id))await atomicWrite(this.root,`workspaces/${workspace.id}/collections/${collection.id}/INDEX.md`,'# Index\n\nRebuild required after privacy purge.\n');}
    const cleaned=(await this.rawEvents()).map(e=>e.objectId===objectId?{...e,path:'purged',idempotencyKey:undefined}:e);const remote=this.remoteJournal();if(remote?.rewriteCommittedJournal)await remote.rewriteCommittedJournal(cleaned);else await atomicWrite(this.root,'.mdb/events/commits.jsonl',cleaned.map(e=>JSON.stringify(e)+'\n').join(''));
    await this.store.removeForAuthorizedPurge(intentKey);return removed;
  }
  async purge(objectId:string,confirm:boolean):Promise<{purged:string;removed:number;limitations:string[]}> {
    this.requireOwner();if(confirm!==true)throw new MDBError('INVALID_INPUT','Purge requires explicit confirmation');return withVaultLock(this.root,async()=>{
      await this.assertNoBackupSnapshotPinning();
      const all=await this.repairJournal();if(all.some(e=>e.objectId===objectId&&e.operation==='purge'))return{purged:objectId,removed:await this.finishPurge(objectId),limitations:['External backups and replicas are outside local purge.']};
      const d=await this.rawDocument(objectId);await this.assertMutationCapacity(Buffer.byteLength(JSON.stringify(all)) + 16 * 1024);const originalPaths:string[]=[];
      if(typeof d.metadata.originalPath==='string'){let shared=false;const purged=new Set(all.filter(e=>e.operation==='purge').map(e=>e.objectId));for(const event of [...new Map(all.map(e=>[e.objectId,e])).values()]){if(event.objectId===objectId||purged.has(event.objectId))continue;const other=await this.documentForEvent(event);if(other.metadata.originalPath===d.metadata.originalPath)shared=true;}if(!shared)originalPaths.push(d.metadata.originalPath);}
      await atomicWrite(this.root,`.mdb/purge-intents/${objectId}.json`,JSON.stringify({path:d.path,originalPaths}));
      await this.appendEvent({sequence:all.length+1,transactionId:this.newId('tx'),objectId,revisionId:this.newId('purged'),path:'purged',scope:d.scope,operation:'purge',timestamp:this.now().toISOString()});this.options.fault?.('after_purge_event');
      const removed=await this.finishPurge(objectId);return{purged:objectId,removed,limitations:['External backups and future replicas cannot be erased by local purge.','Generated navigation is cleared and requires rebuilding.']};
    });
  }
  async verify(capability?:object):Promise<{ok:boolean;issues:string[];objects:number}> {if(capability!==REPLICATION_INSTALL_CAPABILITY)this.requireOwner();const issues:string[]=[];let objects=0;try{const events=await this.rawEvents();const purged=new Set(events.filter(e=>e.operation==='purge').map(e=>e.objectId));for(const e of events){if(purged.has(e.objectId))continue;objects++;try{const revisionBytes=Buffer.from(await this.store.read(`.mdb/objects/${e.objectId}/revs/${e.revisionId}.md`));if(e.revisionSha256&&createHash('sha256').update(revisionBytes).digest('hex')!==e.revisionSha256)issues.push(`Revision content hash mismatch: ${e.objectId}/${e.revisionId}`);const d=parseDocument(revisionBytes.toString('utf8'));if(d.id!==e.objectId||d.revisionId!==e.revisionId||scopeKey(d.scope)!==scopeKey(e.scope))issues.push(`Journal mismatch: ${e.objectId}`);if(e.replicatedFork){const fork=e.replicatedFork,hasBase=fork.baseRevisionId==='',base=hasBase?undefined:events.find(x=>x.objectId===e.objectId&&x.revisionId===fork.baseRevisionId),candidates=fork.candidateRevisionIds.map(id=>events.find(x=>x.objectId===e.objectId&&x.revisionId===id)),expectedBase=fork.baseRevisionId||null,resolution=e.operation==='replica_resolution'&&Array.isArray(d.metadata.resolvedFrom)&&fork.candidateRevisionIds.every(id=>(d.metadata.resolvedFrom as unknown[]).includes(id))&&(d.metadata.resolvedFrom as unknown[]).includes(e.previousRevisionId),validCandidates=candidates.every((candidate,index)=>candidate&&((index>0&&(candidate.previousRevisionId??null)===fork.candidateRevisionIds[index-1])||(index===0&&((candidate.previousRevisionId??null)===expectedBase||(resolution&&candidate.revisionId===expectedBase)))));if(!(e.operation==='replica_import'&&e.previousRevisionId===expectedBase)&&!resolution||(!hasBase&&!base)||!fork.candidateRevisionIds.length||!validCandidates||!candidates.some(candidate=>candidate!.sequence<e.sequence))issues.push(`Invalid replicated fork: ${e.objectId}/${e.revisionId}`);}else if(e.operation==='replicatedFork')issues.push(`Unrecorded replicated fork: ${e.objectId}/${e.revisionId}`);if(d.kind==='source'&&typeof d.metadata.originalPath==='string'){try{const b=await this.store.read(d.metadata.originalPath);if(createHash('sha256').update(b).digest('hex')!==d.metadata.sha256)issues.push(`Source hash mismatch: ${e.objectId}`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||!(await fs.access(path.resolve(this.root,'..','.replica/device.json')).then(()=>true,()=>false)))issues.push(`Source original missing: ${e.objectId}`);}}}catch{issues.push(`Missing or invalid revision: ${e.objectId}`);}}}catch{issues.push('Invalid journal');}return{ok:issues.length===0,issues,objects};}
  watch(options:{intervalMs?:number;onError?:(error:unknown)=>void}={}):{close():Promise<void>;watcherAvailable:boolean} {
    this.requireOwner();let closed=false,running=false;const intervalMs=Math.max(50,options.intervalMs??5000);
    const reconcile=async()=>{if(closed||running)return;running=true;try{await this.reconcile();}catch(error){options.onError?.(error);}finally{running=false;}};
    let debounce:ReturnType<typeof setTimeout>|undefined;
    const queue=()=>{if(debounce)clearTimeout(debounce);debounce=setTimeout(()=>{void reconcile();},50);debounce.unref();};
    let watcher:ReturnType<typeof fsWatch>|undefined;let watcherAvailable=false;try{watcher=fsWatch(this.root,{recursive:true},(_event,filename)=>{if(filename&&!filename.startsWith('.mdb/')&&!filename.startsWith('.mdb\\')&&!filename.includes('/sources/originals/'))queue();});watcherAvailable=true;watcher.on('error',error=>{watcherAvailable=false;watcher?.close();options.onError?.(error);});watcher.unref();}catch(error){options.onError?.(error);}
    const timer=setInterval(()=>{void reconcile();},intervalMs);timer.unref();return{get watcherAvailable(){return watcherAvailable;},async close(){closed=true;clearInterval(timer);if(debounce)clearTimeout(debounce);watcher?.close();while(running)await new Promise(resolve=>setTimeout(resolve,5));}};
  }
  /**
   * Captures a consistent immutable file snapshot while holding the writer lock, then exports it without holding that lock.
   * Revision/source files are hard-linked into a unique same-volume operation directory; the append-only journal is copied only
   * through its captured byte offset. The destination is trusted only after every file is fsynced and the manifest is published last.
   */
  async backup(destination:string):Promise<{destination:string;files:number;bytes:number}> {
    this.requireOwner();
    const target=path.resolve(destination);
    if(target===this.root||target.startsWith(this.root+path.sep))throw new MDBError('INVALID_INPUT','Backup must be outside the vault');
    await fs.mkdir(target,{recursive:true,mode:0o700});
    if((await fs.lstat(target)).isSymbolicLink()||(await fs.readdir(target)).length)throw new MDBError('INVALID_INPUT','Backup destination must be an empty regular directory');
    const snapshot=await withVaultLock(this.root,async()=>{
      const parent=await safePath(this.root,'.mdb/tmp/backup-snapshots');
      await fs.mkdir(parent,{recursive:true,mode:0o700});
      await Vault.cleanupBackupSnapshots(parent);
      const operationId=randomUUID();
      const relativeRoot=`.mdb/tmp/backup-snapshots/snapshot-${operationId}`;
      const root=await safePath(this.root,relativeRoot);
      await fs.mkdir(root,{mode:0o700});
      const owner={format:'engram-backup-snapshot-v1',operationId,pid:process.pid,createdAt:new Date().toISOString(),state:'pinning' as const};
      const ownerFile=await fs.open(path.join(root,'.backup-owner.json'),'wx',0o600);
      try{await ownerFile.writeFile(JSON.stringify(owner));await ownerFile.sync();}finally{await ownerFile.close();}
      try{
        await this.repairJournal();
        // Capture only the journal boundary under the writer lock. Walking a
        // large vault here made backup latency proportional to file count and
        // blocked unrelated writers. Canonical revisions are immutable and
        // purge is fenced by the pin marker until linking is complete, so the
        // inventory and hard-link work can safely happen after releasing it.
        const journal='.mdb/events/commits.jsonl';
        const journalStat=await fs.stat(path.join(this.root,journal));
        return {root,relativeRoot,journalSize:journalStat.size};
      }catch(error){await fs.rm(root,{recursive:true,force:true}).catch(()=>undefined);throw error;}
    });
    try{
      // The journal cut is captured under the writer lock, but inventory and
      // pinning thousands of immutable files are deliberately outside it.
      // A purge checks the pin marker under the same lock and returns retryable
      // CONFLICT until pinning is complete, so no captured revision can vanish.
      const files=await Vault.listFiles(this.root,relative=>Vault.skipBackupPath(relative));
      const directories=new Set<string>();
      for(const file of files){let dir=path.dirname(file);while(dir!=='.'){directories.add(dir);dir=path.dirname(dir);}}
      for(const directory of [...directories].sort((a,b)=>a.split('/').length-b.split('/').length))await fs.mkdir(await safePath(snapshot.root,directory),{recursive:true,mode:0o700});
      let next=0;
      const linkWorker=async()=>{for(let i=next++;i<files.length;i=next++){
        const relative=files[i]!;if(relative==='.mdb/events/commits.jsonl')continue;
        await fs.link(await safePath(this.root,relative),await safePath(snapshot.root,relative));
      }};
      await Promise.all(Array.from({length:Math.min(32,Math.max(1,files.length))},linkWorker));
      await Vault.copyJournalPrefix(path.join(this.root,'.mdb/events/commits.jsonl'),await safePath(snapshot.root,'.mdb/events/commits.jsonl'),snapshot.journalSize);
      await atomicWrite(this.root,`${snapshot.relativeRoot}/.backup-owner.json`,JSON.stringify({format:'engram-backup-snapshot-v1',operationId:path.basename(snapshot.relativeRoot).slice('snapshot-'.length),pid:process.pid,createdAt:new Date().toISOString(),state:'pinned'}));
      // A backup performs a large number of durable file creates. Keep that
      // background I/O single-flight so concurrent journal commits are not
      // queued behind a burst of parallel fsyncs on the same volume.
      return await Vault.copyTree(snapshot.root,target,{manifest:true,files,concurrency:1});
    }
    finally{await fs.rm(snapshot.root,{recursive:true,force:true}).catch(()=>undefined);}
  }
  private static skipBackupPath(relative:string):boolean {
    return relative===BACKUP_MANIFEST||relative==='.backup-owner.json'||relative.startsWith('.mdb/locks/')
      ||relative.startsWith('.mdb/indexes/')||relative.startsWith('.mdb/cache/')
      ||relative==='.mdb/global-index.sqlite'||relative.startsWith('.mdb/global-index.sqlite-')
      ||/\/\.mdb\/index\.sqlite(?:-(?:wal|shm))?$/.test(relative)
      // Atomic writes use UUID-suffixed sibling files before rename. They are
      // disposable in-flight state, not committed backup content. Inventory
      // and hard-linking happen outside the writer lock, so a writer may rename
      // or remove one after listFiles() sees it; excluding them also prevents
      // transient/uncommitted bytes from entering a coherent snapshot.
      ||/(?:^|\/)[^/]*\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(relative)
      ||relative.startsWith('.mdb/tmp/backup-snapshots/');
  }
  private static async copyJournalPrefix(source:string,destination:string,size:number):Promise<void>{
    await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    const input=await fs.open(source,'r');const output=await fs.open(destination,'wx',0o600);const buffer=Buffer.allocUnsafe(1024*1024);
    try{let offset=0;while(offset<size){const length=Math.min(buffer.length,size-offset);const{bytesRead}=await input.read(buffer,0,length,offset);if(!bytesRead)throw new MDBError('CONFLICT','Commit journal changed before backup snapshot completed');await output.write(buffer,0,bytesRead,offset);offset+=bytesRead;}await output.sync();}
    finally{await input.close();await output.close();}
  }
  private static async cleanupBackupSnapshots(parent:string):Promise<void>{
    for(const entry of await fs.readdir(parent,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^snapshot-[0-9a-f-]{36}$/.test(entry.name))continue;
      const directory=path.join(parent,entry.name),marker=path.join(directory,'.backup-owner.json');
      try{
        const st=await fs.lstat(marker);if(!st.isFile()||st.isSymbolicLink())continue;
        const owner=JSON.parse(await fs.readFile(marker,'utf8')) as {format?:string;operationId?:string;pid?:number};
        if(owner.format!=='engram-backup-snapshot-v1'||owner.operationId!==entry.name.slice('snapshot-'.length)||!Number.isInteger(owner.pid)||owner.pid!<1)continue;
        let alive=true;try{process.kill(owner.pid!,0);}catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}
        if(!alive)await fs.rm(directory,{recursive:true,force:true});
      }catch{/* An unreadable/unmarked operation is ambiguous and is intentionally retained. */}
    }
  }
  /** Removes only restore staging trees whose adjacent owner marker proves the process is gone. */
  private static async cleanupRestoreStages(parent:string,base:string):Promise<void>{
    const prefix=`.${base}.engram-restore-`;
    for(const name of await fs.readdir(parent)){
      if(!name.startsWith(prefix))continue;
      const suffix=name.slice(prefix.length),ownerOnly=suffix.endsWith('.staging.owner.json');
      const operationId=ownerOnly?suffix.slice(0,-'.staging.owner.json'.length):suffix.endsWith('.staging')?suffix.slice(0,-'.staging'.length):'';
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId))continue;
      const staging=path.join(parent,`${prefix}${operationId}.staging`),ownerPath=`${staging}.owner.json`;
      try{
        const ownerStat=await fs.lstat(ownerPath);
        if(!ownerStat.isFile()||ownerStat.isSymbolicLink())continue;
        const owner=JSON.parse(await fs.readFile(ownerPath,'utf8')) as {format?:string;operationId?:string;pid?:number;createdAt?:string};
        const createdAt=Date.parse(owner.createdAt??'');
        if(owner.format!=='engram-restore-stage-v1'||owner.operationId!==operationId||!Number.isSafeInteger(owner.pid)||owner.pid!<1||!Number.isFinite(createdAt)||createdAt>Date.now())continue;
        let alive=true;
        try{process.kill(owner.pid!,0);}catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}
        if(alive)continue;
        let stageStat;
        try{stageStat=await fs.lstat(staging);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(stageStat?.isSymbolicLink()||stageStat&&!stageStat.isDirectory())continue;
        if(stageStat)await fs.rm(staging,{recursive:true,force:false});
        await fs.rm(ownerPath,{force:false});
      }catch{/* Unknown, malformed, active, or unreadable staging state is retained. */}
    }
  }
  private async assertNoBackupSnapshotPinning():Promise<void>{
    const parent=await safePath(this.root,'.mdb/tmp/backup-snapshots');
    await fs.mkdir(parent,{recursive:true,mode:0o700});
    await Vault.cleanupBackupSnapshots(parent);
    for(const entry of await fs.readdir(parent,{withFileTypes:true}).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;})){
      if(!entry.isDirectory()||!/^snapshot-[0-9a-f-]{36}$/.test(entry.name))continue;
      try{
        const marker=path.join(parent,entry.name,'.backup-owner.json');const stat=await fs.lstat(marker);
        if(!stat.isFile()||stat.isSymbolicLink())throw new Error('invalid backup pin marker');
        const owner=JSON.parse(await fs.readFile(marker,'utf8')) as {format?:string;operationId?:string;pid?:number;state?:string};
        if(owner.format!=='engram-backup-snapshot-v1'||owner.operationId!==entry.name.slice('snapshot-'.length)||!Number.isInteger(owner.pid)||owner.pid!<1)throw new Error('invalid backup pin owner');
        if(owner.state==='pinned')continue;
        let alive=true;try{process.kill(owner.pid!,0);}catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}
        if(alive)throw new MDBError('CONFLICT','Purge is deferred while a backup snapshot is pinning immutable files; retry after backup completes');
        await fs.rm(path.dirname(marker),{recursive:true,force:true});
      }catch(error){
        if(error instanceof MDBError)throw error;
        // Unknown or malformed snapshot state is ambiguous: fail closed rather
        // than deleting canonical revisions that the snapshot may reference.
        throw new MDBError('CONFLICT','Purge is deferred because backup snapshot ownership is ambiguous; inspect storage state before retrying');
      }
    }
  }
  private static async listFiles(root:string,skip:(relative:string)=>boolean):Promise<string[]> {const files:string[]=[];const walk=async(directory:string)=>{for(const e of await fs.readdir(directory,{withFileTypes:true})){const full=path.join(directory,e.name),relative=path.relative(root,full).split(path.sep).join('/');if(skip(relative))continue;if(e.isSymbolicLink())throw new MDBError('INVALID_INPUT','Backup cannot include symlinks');if(e.isDirectory())await walk(full);else if(e.isFile())files.push(relative);}};await walk(root);return files.sort();}
  private static async copyTree(source:string,target:string,options:{manifest:boolean;files?:string[];concurrency?:number}):Promise<{destination:string;files:number;bytes:number}> {
    const files=options.files??await Vault.listFiles(source,relative=>relative.startsWith('.mdb/locks')||relative===BACKUP_MANIFEST);
    const directories=new Set<string>([target]);const entries:Array<{path:string;size:number;sha256:string}>=[];let next=0,bytes=0;
    const ensureDirectory=async(directory:string)=>{if(directories.has(directory))return;await ensureDirectory(path.dirname(directory));await fs.mkdir(directory,{mode:0o700,recursive:true});directories.add(directory);};
    const worker=async()=>{for(let i=next++;i<files.length;i=next++){
      const relative=files[i]!;const destination=await safePath(target,relative);await ensureDirectory(path.dirname(destination));
      const data=await fs.readFile(path.join(source,relative));const handle=await fs.open(destination,'wx',0o600);
      try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
      entries[i]={path:relative,size:data.length,sha256:createHash('sha256').update(data).digest('hex')};bytes+=data.length;}};
    const concurrency=options.concurrency??16;
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>64)throw new MDBError('INVALID_INPUT','Backup copy concurrency must be between 1 and 64');
    await Promise.all(Array.from({length:Math.min(concurrency,Math.max(1,files.length))},worker));
    for(const directory of [...directories].sort((a,b)=>b.length-a.length))await syncDirectory(directory); // children before parents, each once
    if(options.manifest)await atomicWrite(target,BACKUP_MANIFEST,JSON.stringify({version:1,createdAt:new Date().toISOString(),files:entries},null,1));
    return{destination:target,files:files.length,bytes};
  }
  /** Checks a backup against its manifest: presence, sizes and SHA-256 of every file, and no unexpected files. */
  static async verifyBackup(source:string):Promise<{ok:boolean;issues:string[];files:number}> {
    const issues:string[]=[];let manifest:{version:number;files:Array<{path:string;size:number;sha256:string}>};
    try{manifest=JSON.parse(await fs.readFile(path.join(source,BACKUP_MANIFEST),'utf8'));if(manifest.version!==1||!Array.isArray(manifest.files))throw new Error('shape');}catch{return{ok:false,issues:['Backup manifest is missing or unreadable; the backup is incomplete or was not made by this version'],files:0};}
    const expected=new Map(manifest.files.map(f=>[f.path,f]));
    for(const f of manifest.files){if(typeof f.path!=='string'||path.isAbsolute(f.path)||f.path.includes('\\')||f.path.includes('\0')||f.path.split('/').some(part=>!part||part==='.'||part==='..')){issues.push('Unsafe path in backup manifest');continue;}let data:Buffer;try{data=await fs.readFile(path.join(source,f.path));}catch{issues.push(`Missing or unreadable: ${f.path}`);continue;}if(data.length!==f.size||createHash('sha256').update(data).digest('hex')!==f.sha256)issues.push(`Content differs from manifest: ${f.path}`);}
    for(const relative of await Vault.listFiles(source,r=>r===BACKUP_MANIFEST||r.startsWith('.mdb/locks')))if(!expected.has(relative))issues.push(`Unexpected file: ${relative}`);
    return{ok:issues.length===0,issues,files:manifest.files.length};
  }
  static async restoreBackup(source:string,destination:string):Promise<Vault> {
    const sourceRoot=path.resolve(source),target=path.resolve(destination);
    if(target===sourceRoot||target.startsWith(sourceRoot+path.sep))throw new MDBError('INVALID_INPUT','Restore destination cannot be inside its backup source');
    const check=await Vault.verifyBackup(sourceRoot);
    if(!check.ok)throw new MDBError('INVALID_INPUT',`Backup verification failed: ${check.issues[0]??'unknown'}`);
    const original=new Vault(sourceRoot),report=await original.verify();
    if(!report.ok)throw new MDBError('INVALID_INPUT','Backup verification failed');

    // Build and recover beside the requested destination. The public destination
    // remains empty/unpublished until every copied file and the journal recover.
    // A process killed during copy can leave only this uniquely named staging
    // directory; a retry can still atomically replace the original empty target.
    const parent=path.dirname(target),base=path.basename(target);
    await fs.mkdir(parent,{recursive:true,mode:0o700});
    await Vault.cleanupRestoreStages(parent,base);
    let targetExists=true;
    try {
      const targetStat=await fs.lstat(target);
      if(targetStat.isSymbolicLink()||!targetStat.isDirectory()||(await fs.readdir(target)).length)
        throw new MDBError('INVALID_INPUT','Restore destination must be an empty regular directory');
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')targetExists=false;
      else throw error;
    }
    const operationId=randomUUID();
    const staging=path.join(parent,`.${base}.engram-restore-${operationId}.staging`);
    const ownerPath=`${staging}.owner.json`;
    try {
      const ownerFile=await fs.open(ownerPath,'wx',0o600);
      try{await ownerFile.writeFile(JSON.stringify({format:'engram-restore-stage-v1',operationId,pid:process.pid,createdAt:new Date().toISOString()}));await ownerFile.sync();}finally{await ownerFile.close();}
      await fs.mkdir(staging,{mode:0o700});
      await Vault.copyTree(sourceRoot,staging,{manifest:false});
      const restored=new Vault(staging);
      await restored.recover();
      const restoredReport=await restored.verify();
      if(!restoredReport.ok)throw new MDBError('INVALID_INPUT','Restored backup failed verification');
      // POSIX rename atomically replaces an existing empty directory. If the
      // platform refuses that operation, remove only the still-empty target;
      // no partial restore is ever published at the requested path.
      try { await fs.rename(staging,target); }
      catch(error) {
        if(!targetExists||(error as NodeJS.ErrnoException).code!=='EEXIST'&&(error as NodeJS.ErrnoException).code!=='ENOTEMPTY')throw error;
        await fs.rmdir(target);
        await fs.rename(staging,target);
      }
      await fs.rm(ownerPath,{force:true}).catch(()=>undefined);
      await syncDirectory(parent);
      return new Vault(destination);
    } catch(error) {
      await fs.rm(staging,{recursive:true,force:true}).catch(()=>undefined);
      await fs.rm(ownerPath,{force:true}).catch(()=>undefined);
      throw error;
    }
  }
}
