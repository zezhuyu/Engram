import { promises as fs, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { atomicWrite, LocalObjectStore, mkdirDurable, safePath, syncDirectory, withVaultLock } from '../storage-local/index.js';
import { createS3ObjectStoreFromEnv } from '../storage-s3/index.js';
import { describeModel } from '../models/factory.js';
import { profileAsync, profileBytes } from '../bench/instrumentation.js';
import { MDBError, OWNER, type ActorContext, type Collection, type CommitEvent, type CommitJournalStore, type Document, type ObjectStore, type PatchInput, type PutInput, type Scope, type VaultConfig, type Workspace } from './types.js';

const defaults: VaultConfig = { schemaVersion: 1, sqlite: { enabled: false }, postgres: { enabled: false }, capture: { enabled: false, allowedSources: [] }, model: { provider: 'auto', allowNetwork: false }, dream: { enabled: false, maxCandidates: 20 } };
export const BACKUP_MANIFEST = 'BACKUP_MANIFEST.json';
const fold = (name: string) => name.normalize('NFC').toLowerCase();
async function rejectCaseAlias(directory: string, name: string): Promise<void> { let entries: string[] = []; try { entries = await fs.readdir(directory); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } if (entries.some(entry => entry !== name && fold(entry) === fold(name))) throw new MDBError('INVALID_INPUT', 'Identifier differs from an existing one only by letter case; this would alias one directory on case-insensitive filesystems'); }
const inaccessible = () => new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
const validId = (id: string) => { if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new MDBError('INVALID_INPUT', 'Invalid identifier'); return id; };
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '')}`;
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
  return `${root}/${directory}/${doc.id}.md`;
}
export function serializeDocument(doc: Document): string {
  const metadata = { schema_version: 1, id: doc.id, revision_id: doc.revisionId, revision_number: doc.revisionNumber, previous_revision_id: doc.previousRevisionId, scope: doc.scope.type, ...(doc.scope.type === 'global' ? { area: doc.scope.area } : { workspace_id: doc.scope.workspaceId, collection_id: doc.scope.collectionId }), kind: doc.kind, title: doc.title, tags: doc.tags, relations: doc.links, provenance: { evidence: doc.evidence }, status: doc.status, created_at: doc.createdAt, updated_at: doc.updatedAt, created_by: doc.createdBy, metadata: doc.metadata, path: doc.path, uri: doc.uri };
  return `---\n${YAML.stringify(metadata)}---\n${doc.body}`;
}
export function parseDocument(text: string): Document {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new MDBError('INVALID_INPUT', 'Document requires YAML frontmatter');
  let m: Record<string, unknown>; try { m = YAML.parse(match[1]!) as Record<string, unknown>; } catch { throw new MDBError('INVALID_INPUT', 'Invalid YAML frontmatter'); }
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
export class Vault {
  readonly root: string;
  readonly store: ObjectStore;
  constructor(root: string, readonly actor: ActorContext = OWNER, readonly options: { fault?: (stage: string) => void; idFactory?: (prefix: string) => string; now?: () => Date; store?: ObjectStore } = {}) { this.root = path.resolve(root); this.store = options.store ?? (process.env.MDB_STORAGE_BACKEND === 's3' ? createS3ObjectStoreFromEnv() : new LocalObjectStore(this.root, options.fault)); }
  private remoteJournal(): CommitJournalStore | undefined { const store = this.store as Partial<CommitJournalStore>; return typeof store.readCommittedJournal === 'function' && typeof store.appendCommittedEvent === 'function' && typeof store.initializeJournal === 'function' ? store as CommitJournalStore : undefined; }
  private newId(prefix: string): string { return this.options.idFactory?.(prefix) ?? id(prefix); }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  async close(): Promise<void> { const store=this.store as ObjectStore & {close?:()=>void|Promise<void>};await store.close?.(); }
  private owner(): boolean { return this.actor.permissions.includes('*'); }
  private requireOwner(): void { if (!this.owner()) throw inaccessible(); }
  private async readJSON<T>(key: string): Promise<T> { return JSON.parse(Buffer.from(await this.store.read(key)).toString('utf8')) as T; }
  async init(options: { sqlite?: boolean; postgres?: boolean } = {}): Promise<VaultConfig> {
    this.requireOwner(); await safePath(this.root,'mdb.yaml'); await mkdirDurable(this.root, this.options.fault);
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
  async canAccess(scope: Scope, action: 'read' | 'write' | 'promote' = 'read'): Promise<boolean> { return profileAsync('acl.check', () => this.canAccessUnprofiled(scope, action)); }
  private async canAccessUnprofiled(scope: Scope, action: 'read' | 'write' | 'promote'): Promise<boolean> {
    if (this.owner()) return true;
    const permissions = this.actor.permissions;
    if (scope.type === 'global') return permissions.includes(`global:${scope.area}:${action}`) || permissions.includes(`global:*:${action}`) || permissions.includes(`${scopeKey(scope)}:*`);
    let workspace: Workspace; try { workspace = await this.readJSON<Workspace>(`workspaces/${validId(scope.workspaceId)}/.mdb/workspace.json`); } catch { return false; }
    const workspacePermission = permissions.includes(`workspace:${scope.workspaceId}:${action}`) || permissions.includes(`workspace:${scope.workspaceId}:*`);
    const granted = this.actor.credentialBound ? workspace.grants[this.actor.actorId]?.includes(action) === true && workspacePermission : workspace.grants[this.actor.actorId]?.includes(action) || workspacePermission;
    if (!granted) return false;
    if (scope.collectionId) { let collection: Collection; try { collection = await this.readJSON<Collection>(`workspaces/${scope.workspaceId}/collections/${validId(scope.collectionId)}/.mdb/collection.json`); } catch { return false; } if (collection.grants && !collection.grants[this.actor.actorId]?.includes(action)) return false; }
    return true;
  }
  private async requireAccess(scope: Scope, action: 'read'|'write'|'promote'): Promise<void> { if (!(await this.canAccess(scope,action))) throw inaccessible(); if (scope.type === 'workspace') { try { await this.readJSON(`workspaces/${validId(scope.workspaceId)}/.mdb/workspace.json`); if (scope.collectionId) await this.readJSON(`workspaces/${scope.workspaceId}/collections/${validId(scope.collectionId)}/.mdb/collection.json`); } catch { throw inaccessible(); } } }
  async createWorkspace(workspaceId: string, description = '', grants: Workspace['grants'] = {}): Promise<Workspace> {
    this.requireOwner(); validId(workspaceId); const workspace: Workspace = {id:workspaceId,description,grants};
    await withVaultLock(this.root, async () => { const key=`workspaces/${workspaceId}/.mdb/workspace.json`; await rejectCaseAlias(await safePath(this.root,'workspaces'),workspaceId); if (await this.store.stat(key)) throw new MDBError('CONFLICT','Workspace already exists'); await this.store.putImmutable(key,Buffer.from(JSON.stringify(workspace))); await atomicWrite(this.root,`workspaces/${workspaceId}/db.yaml`,YAML.stringify(workspace)); for (const dir of ['memory/episodic','memory/semantic','memory/procedural','insights','decisions','sources/originals','sources/manifests','wiki/pages','wiki/topics','wiki/syntheses','collections']) await fs.mkdir(await safePath(this.root,`workspaces/${workspaceId}/${dir}`),{recursive:true,mode:0o700}); for (const name of ['INDEX','PROFILE','OVERVIEW']) await atomicWrite(this.root,`workspaces/${workspaceId}/${name}.md`,`# ${name}\n`); }); return workspace;
  }
  async listWorkspaces(): Promise<Workspace[]> { const result: Workspace[]=[]; if(this.remoteJournal()){const ids=new Set<string>();for await(const entry of this.store.list('workspaces')){const match=/^workspaces\/([^/]+)\/.mdb\/workspace\.json$/.exec(entry.key);if(match)ids.add(match[1]!);}for(const id of ids)if(await this.canAccess({type:'workspace',workspaceId:id},'read'))result.push(await this.readJSON(`workspaces/${id}/.mdb/workspace.json`));return result;} for (const entry of await fs.readdir(await safePath(this.root,'workspaces'),{withFileTypes:true})) if(entry.isDirectory() && await this.canAccess({type:'workspace',workspaceId:entry.name},'read')) result.push(await this.readJSON(`workspaces/${entry.name}/.mdb/workspace.json`)); return result; }
  async grant(workspaceId:string,actorId:string,permissions:('read'|'write'|'promote')[]):Promise<Workspace> { this.requireOwner(); validId(workspaceId); if(permissions.some(p=>!['read','write','promote'].includes(p))) throw new MDBError('INVALID_INPUT','Invalid grant'); return withVaultLock(this.root,async()=>{const key=`workspaces/${workspaceId}/.mdb/workspace.json`;const old=await this.readJSON<Workspace>(key);const w={...old,grants:{...old.grants,[actorId]:permissions}};if(this.remoteJournal()){if(!await this.store.compareAndSwapPointer(key,JSON.stringify(old),JSON.stringify(w)))throw new MDBError('CONFLICT','Workspace grants changed during update');}else await atomicWrite(this.root,key,JSON.stringify(w));await atomicWrite(this.root,`workspaces/${workspaceId}/db.yaml`,YAML.stringify(w));return w;}); }
  async revoke(workspaceId:string,actorId:string):Promise<Workspace> { return this.grant(workspaceId,actorId,[]); }
  async createCollection(workspaceId:string,collectionId:string,description='',grants?:Collection['grants']):Promise<Collection> { validId(workspaceId);validId(collectionId);await this.requireAccess({type:'workspace',workspaceId},'write'); if(grants && !this.owner()) throw inaccessible(); const collection:Collection={id:collectionId,workspaceId,description,...(grants?{grants}:{})}; await withVaultLock(this.root,async()=>{const key=`workspaces/${workspaceId}/collections/${collectionId}/.mdb/collection.json`;await rejectCaseAlias(await safePath(this.root,`workspaces/${workspaceId}/collections`),collectionId);if(await this.store.stat(key))throw new MDBError('CONFLICT','Collection already exists');await this.store.putImmutable(key,Buffer.from(JSON.stringify(collection))); for(const d of ['working','notes','observations','insights','sessions'])await fs.mkdir(await safePath(this.root,`workspaces/${workspaceId}/collections/${collectionId}/${d}`),{recursive:true,mode:0o700});for(const n of ['PROFILE','INDEX','state','retrospective'])await atomicWrite(this.root,`workspaces/${workspaceId}/collections/${collectionId}/${n}.md`,`# ${n}\n`);});return collection; }
  async listCollections(workspaceId:string):Promise<Collection[]> { await this.requireAccess({type:'workspace',workspaceId},'read');const result:Collection[]=[];if(this.remoteJournal()){const ids=new Set<string>();for await(const entry of this.store.list(`workspaces/${workspaceId}/collections`)){const match=new RegExp(`^workspaces/${workspaceId}/collections/([^/]+)/.mdb/collection\\.json$`).exec(entry.key);if(match)ids.add(match[1]!);}for(const id of ids)if(await this.canAccess({type:'workspace',workspaceId,collectionId:id},'read'))result.push(await this.readJSON(`workspaces/${workspaceId}/collections/${id}/.mdb/collection.json`));return result;}for(const e of await fs.readdir(await safePath(this.root,`workspaces/${workspaceId}/collections`),{withFileTypes:true}))if(e.isDirectory()&&await this.canAccess({type:'workspace',workspaceId,collectionId:e.name},'read'))result.push(await this.readJSON(`workspaces/${workspaceId}/collections/${e.name}/.mdb/collection.json`));return result; }
  /** Parsed journal prefix. The journal is append-only, so only bytes after `offset` are parsed; a replaced (new inode), shrunk or corrupt file forces a full re-read. */
  private journalCache?:{ino:number;dev:number;offset:number;events:CommitEvent[];latest:Map<string,CommitEvent>;byRevision:Map<string,CommitEvent>;purged:Set<string>;idem:Map<string,CommitEvent>};
  private async rawEvents():Promise<CommitEvent[]> { return profileAsync('journal.read_parse', () => this.rawEventsUnprofiled()); }
  private async rawEventsUnprofiled():Promise<CommitEvent[]> {
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
        const events=cache.events.slice();const latest=new Map(cache.latest),byRevision=new Map(cache.byRevision),purged=new Set(cache.purged),idem=new Map(cache.idem);
        for(const line of chunk.subarray(0,end).toString('utf8').split('\n')){if(!line)continue;try{const event=JSON.parse(line) as CommitEvent;if(event.sequence!==events.length+1||!event.objectId||!event.revisionId)throw new Error('Invalid journal record');events.push(event);latest.set(event.objectId,event);byRevision.set(event.revisionId,event);if(event.operation==='purge')purged.add(event.objectId);if(event.idempotencyKey&&!idem.has(`${scopeKey(event.scope)}\0${event.idempotencyKey}`))idem.set(`${scopeKey(event.scope)}\0${event.idempotencyKey}`,event);}catch{this.journalCache=undefined;throw new MDBError('INTERNAL','Committed journal is corrupt');}}
        cache={ino:cache.ino,dev:cache.dev,offset:cache.offset+end+1,events,latest,byRevision,purged,idem};
      }
    }
    this.journalCache=cache;return cache.events.slice();
  }
  /** The committed object created under this idempotency key in this scope, if the caller may read it (O(1): indexed from the journal). */
  async byIdempotencyKey(key:string,scope:Scope):Promise<Document|undefined> {await this.rawEvents();const event=this.journalCache!.idem.get(`${scopeKey(scope)}\0${key}`);if(!event||this.journalCache!.purged.has(event.objectId)||!(await this.canAccess(scope,'read')))return undefined;try{return await this.get(event.objectId);}catch{return undefined;}}
  /** Owner-only configuration update, written atomically. The previous file is not kept as history; configuration is not knowledge. */
  async setConfig(mutate:(config:VaultConfig)=>void):Promise<VaultConfig> {this.requireOwner();return withVaultLock(this.root,async()=>{const oldBytes=await this.store.read('mdb.yaml'),config=await this.config();mutate(config);if(config.schemaVersion!==1)throw new MDBError('INVALID_INPUT','Invalid vault config');const next=YAML.stringify(config);if(this.remoteJournal()){if(!await this.store.compareAndSwapPointer('mdb.yaml',Buffer.from(oldBytes).toString('utf8'),next))throw new MDBError('CONFLICT','Vault config changed during update');}else await atomicWrite(this.root,'mdb.yaml',next);return config;});}
  /** Per-call memo of read access by scope: ACL files are read once per distinct scope instead of once per event. A fresh memo per call keeps grant/revoke effective immediately. */
  private readMemo():(scope:Scope)=>Promise<boolean>{const memo=new Map<string,Promise<boolean>>();return scope=>{const key=scopeKey(scope);let hit=memo.get(key);if(!hit){hit=this.canAccess(scope,'read');memo.set(key,hit);}return hit;};}
  /**
   * INTERNAL, for derived-index builders only: a minimal projection of ALL journal records after `sequence`, regardless of the caller's read access.
   * It exposes no content, and builders must still read every object through get(), which enforces access. It exists so an index can notice
   * objects that become readable later (grants) without re-reading the whole journal.
   */
  async journalSince(sequence:number):Promise<Array<Pick<CommitEvent,'sequence'|'transactionId'|'objectId'|'previousRevisionId'|'operation'|'scope'>>> {await this.rawEvents();return this.journalCache!.events.slice(Math.max(0,sequence)).map(e=>({sequence:e.sequence,transactionId:e.transactionId,objectId:e.objectId,...(e.previousRevisionId?{previousRevisionId:e.previousRevisionId}:{}),operation:e.operation,scope:e.scope}));}
  /** Readable journal records with sequence greater than `sequence`, in order. Cost is proportional to the new records, not the journal. */
  async eventsSince(sequence:number):Promise<CommitEvent[]> {await this.rawEvents();const tail=this.journalCache!.events.slice(Math.max(0,sequence));const result:CommitEvent[]=[];const canRead=this.readMemo();for(const e of tail)if(await canRead(e.scope))result.push(e);return result;}
  async events():Promise<CommitEvent[]> { const result:CommitEvent[]=[];const canRead=this.readMemo();for(const e of await this.rawEvents())if(await canRead(e.scope))result.push(e);return result; }
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
    const missing=events.filter(event=>!this.revisionCache.has(`${event.objectId}/${event.revisionId}`));
    if(missing.length){
      const keys=missing.map(event=>`.mdb/objects/${event.objectId}/revs/${event.revisionId}.md`);
      const bytes=this.store.readMany?await this.store.readMany(keys,8):await Promise.all(keys.map(key=>this.store.read(key)));
      for(let i=0;i<missing.length;i++){
        const event=missing[i]!,key=`${event.objectId}/${event.revisionId}`,doc=parseDocument(Buffer.from(bytes[i]!).toString('utf8'));
        if(doc.id!==event.objectId||doc.revisionId!==event.revisionId||doc.path!==event.path||scopeKey(doc.scope)!==scopeKey(event.scope))throw new MDBError('INTERNAL','Revision and journal disagree');
        this.cacheRevision(key,doc);
      }
    }
    return events.map(event=>{const key=`${event.objectId}/${event.revisionId}`,doc=this.revisionCache.get(key);if(!doc)throw new MDBError('INTERNAL','Revision batch read did not return an object');this.revisionCache.delete(key);this.revisionCache.set(key,doc);return doc;});
  }
  private async rawDocument(objectId:string,revisionId?:string):Promise<Document> { return profileAsync('vault.raw_document', () => this.rawDocumentUnprofiled(objectId, revisionId)); }
  private async rawDocumentUnprofiled(objectId:string,revisionId?:string):Promise<Document> {
    validId(objectId);if(revisionId)validId(revisionId);await this.rawEvents();const index=this.journalCache!;const found=revisionId?index.byRevision.get(revisionId):index.latest.get(objectId);const event=found&&found.objectId===objectId?found:undefined;
    if(!event||index.purged.has(objectId))throw inaccessible();await this.requireAccess(event.scope,'read');
    try{return await this.documentForEvent(event);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw inaccessible();throw e;}
  }
  private async resolveReference(uri:string,revisionId?:string):Promise<Document> {const doc=await this.rawDocument(objectIdFromUri(uri),revisionId);if(uri!==doc.uri&&uri!==doc.id)throw inaccessible();return doc;}
  private async visible(doc:Document):Promise<Document> { const result=structuredClone(doc);const offset=documentBodyLineOffset(doc);if(offset!==undefined)documentBodyLineOffsets.set(result,offset);const links:Document['links']=[],evidence:Document['evidence']=[];for(const l of doc.links){try{await this.resolveReference(l.target,l.revisionId);links.push(l);}catch{/* inaccessible references disclose nothing */}}for(const e of doc.evidence){try{await this.resolveReference(e.uri,e.revisionId);evidence.push(e);}catch{/* inaccessible references disclose nothing */}}result.links=links;result.evidence=evidence;if(!this.owner())for(const key of Object.keys(result.metadata))if(key.startsWith('_'))delete result.metadata[key];return result; }
  async get(objectId:string,revisionId?:string):Promise<Document> { return profileAsync('vault.get', async () => this.visible(await this.rawDocument(objectId,revisionId))); }
  async listDocuments(options:{includeHistory?:boolean;scopes?:Scope[]}={}):Promise<Document[]> {const events=await this.rawEvents();const purged=new Set(events.filter(e=>e.operation==='purge').map(e=>e.objectId));const candidates=options.includeHistory?events: [...new Map(events.map(e=>[e.objectId,e])).values()],canRead=this.readMemo(),readable:CommitEvent[]=[];for(const e of candidates){if(purged.has(e.objectId)||e.operation==='purge'||!(await canRead(e.scope)))continue;if(options.scopes&&!options.scopes.some(s=>s.type===e.scope.type&&(s.type==='global'?e.scope.type==='global'&&s.area===e.scope.area:e.scope.type==='workspace'&&s.workspaceId===e.scope.workspaceId&&(!s.collectionId||s.collectionId===e.scope.collectionId))))continue;readable.push(e);}const result:Document[]=[];for(let at=0;at<readable.length;at+=48){const batch=readable.slice(at,at+48),documents=await this.documentsForEvents(batch);for(let i=0;i<batch.length;i++){const d=documents[i]!;if(d.status!=='deleted'||options.includeHistory)result.push(await this.visible(d));}}return result;}
  private async commit(input:PutInput,previous?:Document,operation='put'):Promise<Document> {
    validateInput(input);if(input.metadata?.profileRole)this.requireOwner();await this.requireAccess(input.scope,'write');const events=await this.repairJournal();this.options.fault?.('commit.before_revision');
    if(input.idempotencyKey){const prior=events.find(e=>e.idempotencyKey===input.idempotencyKey&&scopeKey(e.scope)===scopeKey(input.scope));if(prior)return this.rawDocument(prior.objectId,prior.revisionId);}
    if(previous){const latest=events.findLast(e=>e.objectId===previous.id);if(latest?.revisionId!==previous.revisionId)throw new MDBError('CONFLICT','Expected revision is no longer current');}
    const now=this.now().toISOString();const objectId=previous?.id??this.newId('obj');const revisionId=this.newId('rev');const doc:Document={id:objectId,revisionId,revisionNumber:(previous?.revisionNumber??0)+1,...(previous?{previousRevisionId:previous.revisionId}:{}),scope:input.scope,kind:input.kind,title:input.title,body:input.body,tags:input.tags??[],links:input.links??[],evidence:input.evidence??[],status:input.status??'active',createdAt:previous?.createdAt??now,updatedAt:now,createdBy:previous?.createdBy??this.actor.actorId,metadata:input.metadata??{},path:'',uri:documentUri(objectId,input.scope)};doc.path=viewPath(doc);if(!previous && events.some(e=>e.path===doc.path&&e.operation!=='purge'))throw new MDBError('CONFLICT','Named profile already exists; patch its current revision');
    const text=serializeDocument(doc);await this.store.putImmutable(`.mdb/objects/${objectId}/revs/${revisionId}.md`,Buffer.from(text));this.options.fault?.('after_revision');this.options.fault?.('after_revision_write');this.options.fault?.('revision.after_dirsync');
    const event:CommitEvent={sequence:events.length+1,transactionId:this.newId('tx'),objectId,revisionId,...(previous?{previousRevisionId:previous.revisionId}:{}),path:doc.path,scope:doc.scope,operation,timestamp:now,revisionSha256:createHash('sha256').update(text).digest('hex'),...(input.idempotencyKey?{idempotencyKey:input.idempotencyKey}:{})};
    this.options.fault?.('journal.before_append');const committedEvent = await this.appendEvent(event);/* commit point: durable append or conditional S3 head publication */this.options.fault?.('after_journal');this.options.fault?.('after_journal_append');this.options.fault?.('before_view');this.options.fault?.('before_view_update');
    this.options.fault?.('head.before_replace');await atomicWrite(this.root,`.mdb/heads/${objectId}.json`,JSON.stringify(committedEvent),this.options.fault);this.options.fault?.('view.before_replace');await atomicWrite(this.root,doc.path,text,this.options.fault);this.options.fault?.('view.after_replace');this.options.fault?.('commit.before_ack');return doc;
  }
  async put(input:PutInput):Promise<Document> { return this.visible(await withVaultLock(this.root,()=>this.commit(input))); }
  async patch(input:PatchInput):Promise<Document> {return this.visible(await withVaultLock(this.root,async()=>{const previous=await this.rawDocument(input.objectId);await this.requireAccess(previous.scope,'write');if(previous.revisionId!==input.expectedRevisionId)throw new MDBError('CONFLICT','Expected revision is no longer current');if(previous.kind==='source')throw new MDBError('INVALID_INPUT','Source manifests are immutable; import a new source');if(input.metadataPatch&&Object.keys(input.metadataPatch).some(k=>k.startsWith('_')))throw new MDBError('INVALID_INPUT','Protected metadata cannot be patched');return this.commit({scope:previous.scope,kind:previous.kind,title:input.title??previous.title,body:input.body??previous.body,tags:input.tags??previous.tags,links:input.links??previous.links,evidence:input.evidence??previous.evidence,status:input.status??previous.status,metadata:{...previous.metadata,...input.metadataPatch}},previous,'patch');}));}
  async delete(objectId:string,expectedRevisionId:string):Promise<Document> {return this.visible(await withVaultLock(this.root,async()=>{const d=await this.rawDocument(objectId);if(d.revisionId!==expectedRevisionId)throw new MDBError('CONFLICT','Expected revision is no longer current');return this.commit({...d,body:'',status:'deleted'},d,'delete');}));}
  async history(objectId:string):Promise<Document[]> {await this.rawDocument(objectId);const result:Document[]=[];for(const e of await this.rawEvents())if(e.objectId===objectId)result.push(await this.get(objectId,e.revisionId));return result;}
  async restore(objectId:string,revisionId:string,expectedRevisionId:string):Promise<Document> {return this.visible(await withVaultLock(this.root,async()=>{const current=await this.rawDocument(objectId);if(current.revisionId!==expectedRevisionId)throw new MDBError('CONFLICT','Expected revision is no longer current');const old=await this.rawDocument(objectId,revisionId);return this.commit(old,current,'restore');}));}
  async diff(objectId:string,from:string,to:string):Promise<{from:string;to:string;diff:string}> {const a=await this.get(objectId,from),b=await this.get(objectId,to);return{from,to,diff:`--- ${from}\n+++ ${to}\n${a.body.split('\n').map(l=>'-'+l).join('\n')}\n${b.body.split('\n').map(l=>'+'+l).join('\n')}`};}
  async ingest(file:string,scope:Scope):Promise<Document> {
    await this.requireAccess(scope,'write');const absolute=path.resolve(file);const stat=await fs.lstat(absolute);if(!stat.isFile()||stat.isSymbolicLink())throw new MDBError('INVALID_INPUT','Import requires an explicit regular file');const bytes=await fs.readFile(absolute);const hash=createHash('sha256').update(bytes).digest('hex');const name=path.basename(absolute).replace(/[^a-zA-Z0-9._-]/g,'_');const originalKey=`${scopeRoot(scope)}/sources/originals/${hash}/${name}`;const textNative=['.md','.markdown','.txt'].includes(path.extname(name).toLowerCase());
    return this.visible(await withVaultLock(this.root,async()=>{await this.store.putImmutable(originalKey,bytes);return this.commit({scope,kind:'source',title:name,body:textNative?bytes.toString('utf8'):`Binary attachment preserved; extraction unavailable for ${path.extname(name)||'unknown format'}.`,metadata:{sha256:hash,originalPath:originalKey,originalName:name,size:bytes.length,importPath:absolute,importedAt:new Date().toISOString(),extraction:textNative?'native-text':'unavailable',untrusted:true,consent:'explicit-path'},idempotencyKey:`source:${scopeKey(scope)}:${hash}:${name}`},undefined,'ingest');}));
  }
  private async repairJournal():Promise<CommitEvent[]> {const events=await this.rawEvents();if(this.remoteJournal())return events;const stat=await fs.stat(await safePath(this.root,'.mdb/events/commits.jsonl'));if(this.journalCache&&stat.size!==this.journalCache.offset){/* unterminated torn tail: rewrite the journal as exactly its committed records */this.options.fault?.('recover.before_journal_repair');await atomicWrite(this.root,'.mdb/events/commits.jsonl',events.map(e=>JSON.stringify(e)+'\n').join(''),this.options.fault);this.journalCache=undefined;await this.rawEvents();this.options.fault?.('recover.after_journal_repair');}return events;}
  /** True when `bytes` is exactly one of this object's committed revisions (a stale view left by a crash, not an external edit). */
  private async isCommittedRevision(objectId:string,events:CommitEvent[],bytes:Uint8Array):Promise<boolean> {for(const e of events){if(e.objectId!==objectId||e.operation==='purge')continue;try{if(Buffer.from(await this.store.read(`.mdb/objects/${objectId}/revs/${e.revisionId}.md`)).equals(Buffer.from(bytes)))return true;}catch{/* missing revision is reported by verify */}}return false;}
  private async sweepTemps(directory:string):Promise<number> {let removed=0;let entries:string[];try{entries=await fs.readdir(await safePath(this.root,directory));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'||(e as NodeJS.ErrnoException).code==='ENOTDIR')return 0;throw e;}for(const name of entries)if(/\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(name)){await fs.rm(await safePath(this.root,`${directory}/${name}`),{force:true});removed++;}return removed;}
  async recover():Promise<{committed:number;repaired:number;orphans:number;tempRemoved:number}> {
    this.requireOwner();return withVaultLock(this.root,async()=>{
      let events=await this.repairJournal();
      for(const event of events)if(event.operation==='purge')await this.finishPurge(event.objectId);
      events=await this.rawEvents();
      const latest=new Map(events.map(e=>[e.objectId,e]));
      const purged=new Set(events.filter(e=>e.operation==='purge').map(e=>e.objectId));
      let repaired=0;
      for(const e of latest.values()){
        if(purged.has(e.objectId))continue;
        const bytes=await this.store.read(`.mdb/objects/${e.objectId}/revs/${e.revisionId}.md`);
        if(e.revisionSha256&&createHash('sha256').update(bytes).digest('hex')!==e.revisionSha256)throw new MDBError('INTERNAL',`Revision content hash mismatch: ${e.objectId}/${e.revisionId}`);
        const doc=parseDocument(Buffer.from(bytes).toString('utf8'));
        if(doc.id!==e.objectId||doc.revisionId!==e.revisionId||doc.path!==e.path||scopeKey(doc.scope)!==scopeKey(e.scope))throw new MDBError('INTERNAL','Revision and journal disagree');
        let current:Uint8Array|undefined;
        try{current=await fs.readFile(await safePath(this.root,e.path));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(!current||!Buffer.from(current).equals(Buffer.from(bytes))){
          if(current&&!await this.isCommittedRevision(e.objectId,events,current))await this.store.putImmutable(`.mdb/quarantine/${id('external')}.md`,current);
          this.options.fault?.('recover.before_view_repair');await atomicWrite(this.root,e.path,bytes,this.options.fault);this.options.fault?.('recover.after_view_repair');repaired++;
        }
        this.options.fault?.('recover.before_head_write');await atomicWrite(this.root,`.mdb/heads/${e.objectId}.json`,JSON.stringify(e),this.options.fault);
      }
      let tempRemoved=0;const sweep=new Set<string>(['.mdb/heads','.mdb/events']);
      for(const e of latest.values())if(!purged.has(e.objectId)){sweep.add(e.path.includes('/')?e.path.slice(0,e.path.lastIndexOf('/')):'.');sweep.add(`.mdb/objects/${e.objectId}/revs`);}
      sweep.delete('.');let orphans=0;
      const committed=new Set(events.map(e=>`.mdb/objects/${e.objectId}/revs/${e.revisionId}.md`));
      for await(const entry of this.store.list('.mdb/objects')){
        if(entry.key.endsWith('.md')&&!committed.has(entry.key))orphans++;
        if(!this.remoteJournal()&&/\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(entry.key)){
          const parent=entry.key.slice(0,entry.key.lastIndexOf('/'));if(parent)sweep.add(parent);
        }
      }
      for(const directory of sweep)tempRemoved+=await this.sweepTemps(directory);
      return{committed:events.length,repaired,orphans,tempRemoved};
    });
  }
  async reconcile():Promise<{imported:number;conflicts:number}> {return withVaultLock(this.root,async()=>{const events=await this.repairJournal();const latest=[...new Map(events.map(e=>[e.objectId,e])).values()];let imported=0,conflicts=0;for(const e of latest){if(e.operation==='purge'||!(await this.canAccess(e.scope,'write'))||!(await this.canAccess(e.scope,'read')))continue;const canonical=Buffer.from(await this.store.read(`.mdb/objects/${e.objectId}/revs/${e.revisionId}.md`)).toString('utf8');let edited:string;try{edited=Buffer.from(await this.store.read(e.path)).toString('utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}if(edited===canonical)continue;try{const d=parseDocument(edited),original=parseDocument(canonical);if(d.id!==e.objectId||d.revisionId!==e.revisionId||scopeKey(d.scope)!==scopeKey(original.scope)||d.kind!==original.kind||d.path!==original.path||d.uri!==original.uri||original.kind==='source')throw new MDBError('CONFLICT','External edit changed protected metadata');await this.commit({scope:original.scope,kind:original.kind,title:d.title,body:d.body,tags:d.tags,links:d.links,evidence:d.evidence,status:d.status,metadata:original.metadata},original,'external_edit');imported++;}catch{await this.store.putImmutable(`.mdb/quarantine/${this.newId('conflict')}.md`,Buffer.from(edited));await atomicWrite(this.root,e.path,canonical);conflicts++;}}return{imported,conflicts};});}
  async promote(objectId:string,to:Scope,sanitizedBody:string,title?:string):Promise<Document> {const source=await this.rawDocument(objectId);await this.requireAccess(source.scope,'promote');if(to.type!=='global')throw new MDBError('INVALID_INPUT','Promotion target must be global');await this.requireAccess(to,'write');if(!sanitizedBody.trim())throw new MDBError('INVALID_INPUT','Promotion requires an explicitly sanitized derivative');return this.put({scope:to,kind:source.kind==='source'?'wiki_page':source.kind,title:title??'Promoted knowledge',body:sanitizedBody,status:'promoted',tags:[],metadata:{_promotionOrigin:{uri:source.uri,revisionId:source.revisionId},reviewed:true}});}
  private async appendEvent(event:CommitEvent):Promise<CommitEvent> {
    const remote = this.remoteJournal();
    if (remote) return remote.appendCommittedEvent(event);
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
      const all=await this.repairJournal();if(all.some(e=>e.objectId===objectId&&e.operation==='purge'))return{purged:objectId,removed:await this.finishPurge(objectId),limitations:['External backups and replicas are outside local purge.']};
      const d=await this.rawDocument(objectId);const originalPaths:string[]=[];
      if(typeof d.metadata.originalPath==='string'){let shared=false;const purged=new Set(all.filter(e=>e.operation==='purge').map(e=>e.objectId));for(const event of [...new Map(all.map(e=>[e.objectId,e])).values()]){if(event.objectId===objectId||purged.has(event.objectId))continue;const other=await this.documentForEvent(event);if(other.metadata.originalPath===d.metadata.originalPath)shared=true;}if(!shared)originalPaths.push(d.metadata.originalPath);}
      await atomicWrite(this.root,`.mdb/purge-intents/${objectId}.json`,JSON.stringify({path:d.path,originalPaths}));
      await this.appendEvent({sequence:all.length+1,transactionId:this.newId('tx'),objectId,revisionId:this.newId('purged'),path:'purged',scope:d.scope,operation:'purge',timestamp:this.now().toISOString()});this.options.fault?.('after_purge_event');
      const removed=await this.finishPurge(objectId);return{purged:objectId,removed,limitations:['External backups and future replicas cannot be erased by local purge.','Generated navigation is cleared and requires rebuilding.']};
    });
  }
  async verify():Promise<{ok:boolean;issues:string[];objects:number}> {this.requireOwner();const issues:string[]=[];let objects=0;try{const events=await this.rawEvents();const purged=new Set(events.filter(e=>e.operation==='purge').map(e=>e.objectId));for(const e of events){if(purged.has(e.objectId))continue;objects++;try{const revisionBytes=Buffer.from(await this.store.read(`.mdb/objects/${e.objectId}/revs/${e.revisionId}.md`));if(e.revisionSha256&&createHash('sha256').update(revisionBytes).digest('hex')!==e.revisionSha256)issues.push(`Revision content hash mismatch: ${e.objectId}/${e.revisionId}`);const d=parseDocument(revisionBytes.toString('utf8'));if(d.id!==e.objectId||d.revisionId!==e.revisionId||scopeKey(d.scope)!==scopeKey(e.scope))issues.push(`Journal mismatch: ${e.objectId}`);if(d.kind==='source'&&typeof d.metadata.originalPath==='string'){const b=await this.store.read(d.metadata.originalPath);if(createHash('sha256').update(b).digest('hex')!==d.metadata.sha256)issues.push(`Source hash mismatch: ${e.objectId}`);}}catch{issues.push(`Missing or invalid revision: ${e.objectId}`);}}}catch{issues.push('Invalid journal');}return{ok:issues.length===0,issues,objects};}
  watch(options:{intervalMs?:number;onError?:(error:unknown)=>void}={}):{close():Promise<void>;watcherAvailable:boolean} {
    this.requireOwner();let closed=false,running=false;const intervalMs=Math.max(50,options.intervalMs??5000);
    const reconcile=async()=>{if(closed||running)return;running=true;try{await this.reconcile();}catch(error){options.onError?.(error);}finally{running=false;}};
    let debounce:ReturnType<typeof setTimeout>|undefined;
    const queue=()=>{if(debounce)clearTimeout(debounce);debounce=setTimeout(()=>{void reconcile();},50);debounce.unref();};
    let watcher:ReturnType<typeof fsWatch>|undefined;let watcherAvailable=false;try{watcher=fsWatch(this.root,{recursive:true},(_event,filename)=>{if(filename&&!filename.startsWith('.mdb/')&&!filename.startsWith('.mdb\\')&&!filename.includes('/sources/originals/'))queue();});watcherAvailable=true;watcher.on('error',error=>{watcherAvailable=false;watcher?.close();options.onError?.(error);});watcher.unref();}catch(error){options.onError?.(error);}
    const timer=setInterval(()=>{void reconcile();},intervalMs);timer.unref();return{get watcherAvailable(){return watcherAvailable;},async close(){closed=true;clearInterval(timer);if(debounce)clearTimeout(debounce);watcher?.close();while(running)await new Promise(resolve=>setTimeout(resolve,5));}};
  }
  /**
   * Consistent-point backup (held under the writer lock). Durability is NOT relaxed: every file is written exclusively and fsynced, then each
   * directory is fsynced once (not after every file), and a SHA-256 manifest is written, fsynced and renamed into place LAST, so a backup is complete
   * only if its manifest exists. Files are copied concurrently to shorten the time writers are blocked.
   */
  async backup(destination:string):Promise<{destination:string;files:number;bytes:number}> {this.requireOwner();const target=path.resolve(destination);if(target===this.root||target.startsWith(this.root+path.sep))throw new MDBError('INVALID_INPUT','Backup must be outside the vault');await fs.mkdir(target,{recursive:true,mode:0o700});if((await fs.lstat(target)).isSymbolicLink()||(await fs.readdir(target)).length)throw new MDBError('INVALID_INPUT','Backup destination must be an empty regular directory');return withVaultLock(this.root,()=>Vault.copyTree(this.root,target,{manifest:true}));}
  private static async listFiles(root:string,skip:(relative:string)=>boolean):Promise<string[]> {const files:string[]=[];const walk=async(directory:string)=>{for(const e of await fs.readdir(directory,{withFileTypes:true})){const full=path.join(directory,e.name),relative=path.relative(root,full).split(path.sep).join('/');if(skip(relative))continue;if(e.isSymbolicLink())throw new MDBError('INVALID_INPUT','Backup cannot include symlinks');if(e.isDirectory())await walk(full);else if(e.isFile())files.push(relative);}};await walk(root);return files.sort();}
  private static async copyTree(source:string,target:string,options:{manifest:boolean}):Promise<{destination:string;files:number;bytes:number}> {
    const files=await Vault.listFiles(source,relative=>relative.startsWith('.mdb/locks')||relative===BACKUP_MANIFEST);
    const directories=new Set<string>([target]);const entries:Array<{path:string;size:number;sha256:string}>=[];let next=0,bytes=0;
    const ensureDirectory=async(directory:string)=>{if(directories.has(directory))return;await ensureDirectory(path.dirname(directory));await fs.mkdir(directory,{mode:0o700,recursive:true});directories.add(directory);};
    const worker=async()=>{for(let i=next++;i<files.length;i=next++){
      const relative=files[i]!;const destination=await safePath(target,relative);await ensureDirectory(path.dirname(destination));
      const data=await fs.readFile(path.join(source,relative));const handle=await fs.open(destination,'wx',0o600);
      try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
      entries[i]={path:relative,size:data.length,sha256:createHash('sha256').update(data).digest('hex')};bytes+=data.length;}};
    await Promise.all(Array.from({length:Math.min(16,Math.max(1,files.length))},worker));
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
  static async restoreBackup(source:string,destination:string):Promise<Vault> {const check=await Vault.verifyBackup(path.resolve(source));if(!check.ok)throw new MDBError('INVALID_INPUT',`Backup verification failed: ${check.issues[0]??'unknown'}`);const original=new Vault(source);const report=await original.verify();if(!report.ok)throw new MDBError('INVALID_INPUT','Backup verification failed');const target=path.resolve(destination);await fs.mkdir(target,{recursive:true,mode:0o700});if((await fs.lstat(target)).isSymbolicLink()||(await fs.readdir(target)).length)throw new MDBError('INVALID_INPUT','Restore destination must be an empty regular directory');await Vault.copyTree(path.resolve(source),target,{manifest:false});const restored=new Vault(destination);await restored.recover();return restored;}
}
