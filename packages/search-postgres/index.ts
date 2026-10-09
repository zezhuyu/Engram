import { Pool, type PoolClient, type QueryResult } from 'pg';
import { MDBError, type ActorContext, type Document, type Scope, type SearchInput, type SearchResult } from '../core/types.js';
import { authorizedDocuments, FilesystemSearch, type SearchVault } from '../search-files/index.js';
import { manifestFor } from '../search-files/manifest.js';
import { validateSearchPage } from '../search-files/index.js';
import { chunkDocument } from '../search-semantic/chunk.js';
import { createEmbedder } from '../search-semantic/embedder.js';
import type { EmbeddingProvider } from '../core/types.js';

type Ranked = { object_id: string; revision_id: string; rank: number };
const BATCH = 48;
const envName = (name: string) => /^[A-Z_][A-Z0-9_]{0,127}$/.test(name);

/** Optional PostgreSQL full-text index. Canonical reads and ACLs remain owned by Vault. */
export class PostgresSearch {
  private pool?: Pool;
  private initialized=false;
  private unavailable?: string;
  private vectorUnavailable?: string;
  private readonly files: FilesystemSearch;
  constructor(readonly vault: SearchVault, private readonly options: { connectionString?: string; pool?: Pool; embedder?: EmbeddingProvider; env?: Record<string,string|undefined> } = {}) { this.files = new FilesystemSearch(vault); this.pool = options.pool; }
  capabilities(): Record<string, boolean> { return { ...this.files.capabilities(), postgres: true, postgresFts: true, pgvector: true }; }
  private async config() { return this.vault.config(); }
  private async connection(): Promise<Pool> {
    if (this.pool) return this.pool;
    const config = await this.config(); const envKey = config.postgres?.connectionStringEnv ?? 'MDB_POSTGRES_URL';
    const connectionString=this.options.connectionString??this.options.env?.[envKey]??process.env[envKey];
    if (!envName(envKey) || !connectionString) throw new MDBError('CAPABILITY_UNAVAILABLE', `PostgreSQL is enabled but ${envKey} is not configured`);
    this.pool = new Pool({ connectionString, max: 8, application_name: 'engram-mdb' });
    return this.pool;
  }
  private async ready(): Promise<Pool> {
    const pool = await this.connection();
    if(this.initialized)return pool;
    await pool.query(`CREATE TABLE IF NOT EXISTS engram_documents (
      object_id text PRIMARY KEY, revision_id text NOT NULL, scope_type text NOT NULL, scope_area text,
      workspace_id text, collection_id text, kind text NOT NULL, title text NOT NULL, body text NOT NULL,
      tags text[] NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}', status text NOT NULL,
      updated_at timestamptz NOT NULL, search_vector tsvector NOT NULL
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS engram_documents_search_idx ON engram_documents USING GIN(search_vector)');
    await pool.query('CREATE INDEX IF NOT EXISTS engram_documents_metadata_idx ON engram_documents USING GIN(metadata jsonb_path_ops)');
    await pool.query('CREATE INDEX IF NOT EXISTS engram_documents_scope_idx ON engram_documents(scope_type, workspace_id, collection_id, kind, updated_at)');
    await pool.query('CREATE TABLE IF NOT EXISTS engram_index_state (id boolean PRIMARY KEY DEFAULT true CHECK(id), journal_sequence bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())');
    try { await pool.query('CREATE EXTENSION IF NOT EXISTS vector'); await pool.query('CREATE TABLE IF NOT EXISTS engram_vectors(object_id text NOT NULL,revision_id text NOT NULL,chunk integer NOT NULL,line_start integer NOT NULL,line_end integer NOT NULL,model text NOT NULL,embedding vector NOT NULL,PRIMARY KEY(object_id,revision_id,chunk))'); this.vectorUnavailable=undefined; }
    catch { this.vectorUnavailable='pgvector extension is not installed or available to this database role'; }
    this.initialized=true;
    return pool;
  }
  private async upsert(client: PoolClient, docs: Document[]): Promise<void> {
    for (let start = 0; start < docs.length; start += BATCH) {
      const batch = docs.slice(start, start + BATCH);
      const values: unknown[] = [];
      batch.forEach(d => {
        values.push(d.id,d.revisionId,d.scope.type,d.scope.type === 'global' ? d.scope.area : null,d.scope.type === 'workspace' ? d.scope.workspaceId : null,d.scope.type === 'workspace' ? d.scope.collectionId ?? null : null,d.kind,d.title,d.body,d.tags,JSON.stringify(d.metadata),d.status,d.updatedAt);
      });
      const sqlTuples = batch.map((_,i) => { const n = i*13; return `($${n+1},$${n+2},$${n+3},$${n+4},$${n+5},$${n+6},$${n+7},$${n+8},$${n+9},$${n+10},$${n+11}::jsonb,$${n+12},$${n+13},to_tsvector('simple',$${n+8} || ' ' || $${n+9}))`; });
      await client.query(`INSERT INTO engram_documents(object_id,revision_id,scope_type,scope_area,workspace_id,collection_id,kind,title,body,tags,metadata,status,updated_at,search_vector) VALUES ${sqlTuples.join(',')} ON CONFLICT(object_id) DO UPDATE SET revision_id=EXCLUDED.revision_id,scope_type=EXCLUDED.scope_type,scope_area=EXCLUDED.scope_area,workspace_id=EXCLUDED.workspace_id,collection_id=EXCLUDED.collection_id,kind=EXCLUDED.kind,title=EXCLUDED.title,body=EXCLUDED.body,tags=EXCLUDED.tags,metadata=EXCLUDED.metadata,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at,search_vector=EXCLUDED.search_vector`, values);
    }
  }
  async rebuild(scope?: Scope): Promise<void> {
    if (!this.vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN','PostgreSQL maintenance requires trusted owner identity');
    void scope;
    const pool = await this.ready(), manifest = await manifestFor(this.vault); await manifest.sync();
    const docs = (await this.vault.listDocuments()).filter(d => d.status !== 'deleted' && d.status !== 'tombstone');
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query('DELETE FROM engram_documents'); await this.upsert(client,docs); await client.query('INSERT INTO engram_index_state(id,journal_sequence) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET journal_sequence=EXCLUDED.journal_sequence,updated_at=now()',[manifest.sequence]); await client.query('COMMIT'); this.unavailable=undefined; }
    catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async sync(): Promise<{ databases: number; objects: number }> {
    if (!this.vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN','PostgreSQL maintenance requires trusted owner identity');
    const pool = await this.ready(), manifest = await manifestFor(this.vault); await manifest.sync();
    const state = await pool.query<{journal_sequence:string}>('SELECT journal_sequence::text FROM engram_index_state WHERE id=true');
    if (!state.rows.length) { await this.rebuild(); return { databases: 1, objects: manifest.entries.size }; }
    const checkpoint = Number(state.rows[0]!.journal_sequence);
    if (!Number.isSafeInteger(checkpoint) || checkpoint > manifest.sequence) { await this.rebuild(); return { databases: 1, objects: manifest.entries.size }; }
    const changed = await this.vault.journalSince!(checkpoint); const ids = [...new Set(changed.map(e=>e.objectId))];
    if (!ids.length) { await pool.query('UPDATE engram_index_state SET journal_sequence=$1,updated_at=now() WHERE id=true',[manifest.sequence]); return { databases: 1, objects: 0 }; }
    const docs: Document[] = []; const removals: string[] = [];
    for (let i=0;i<ids.length;i+=BATCH) {
      const batch=ids.slice(i,i+BATCH); const settled=await Promise.all(batch.map(async id=>{try{return await this.vault.get(id);}catch{return undefined;}}));
      for(let j=0;j<batch.length;j++){const d=settled[j];if(d&&d.status!=='deleted'&&d.status!=='tombstone')docs.push(d);else removals.push(batch[j]!);}
    }
    const client=await pool.connect();
    try { await client.query('BEGIN'); if(removals.length)await client.query('DELETE FROM engram_documents WHERE object_id=ANY($1::text[])',[removals]); await this.upsert(client,docs); await client.query('INSERT INTO engram_index_state(id,journal_sequence) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET journal_sequence=EXCLUDED.journal_sequence,updated_at=now()',[manifest.sequence]); await client.query('COMMIT'); }
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    return { databases:1, objects:docs.length+removals.length };
  }
  private async embeddingProvider(): Promise<EmbeddingProvider> { return this.options.embedder ?? createEmbedder((await this.config()).embedding,this.options.env??process.env); }
  async vectorStatus(): Promise<{ready:boolean;reason?:string;model?:string;dimensions?:number}> {
    let embedder:EmbeddingProvider;try{embedder=await this.embeddingProvider();}catch(error){return{ready:false,reason:(error as Error).message};}
    const pool=await this.ready();if(this.vectorUnavailable)return{ready:false,reason:this.vectorUnavailable,model:embedder.modelId,dimensions:embedder.dimensions};
    try{const r=await pool.query('SELECT count(*)::int AS n FROM engram_vectors WHERE model=$1',[embedder.modelId]);if(!r.rows[0]?.n)return{ready:false,reason:'No current pgvector rows; run "mdb embed sync"',model:embedder.modelId,dimensions:embedder.dimensions};return{ready:true,model:embedder.modelId,dimensions:embedder.dimensions};}catch{return{ready:false,reason:'pgvector index unavailable'};}
  }
  async embedSync(options:{signal?:AbortSignal;maxObjects?:number}={}):Promise<{embeddedObjects:number;embeddedChunks:number;skippedPrivate:number;model:string;dimensions:number}> {
    if(!this.vault.actor.permissions.includes('*'))throw new MDBError('NOT_FOUND_OR_FORBIDDEN','Embedding maintenance requires trusted owner identity');
    await this.sync();const config=await this.config(),embedder=await this.embeddingProvider(),pool=await this.ready();if(this.vectorUnavailable)throw new MDBError('CAPABILITY_UNAVAILABLE',this.vectorUnavailable);
    const docs=(await this.vault.listDocuments()).filter(d=>d.status!=='deleted'&&d.status!=='tombstone'),remote=(embedder.locality??'local')==='remote'&&!config.embedding?.allowPrivateContentToRemote;
    const allowed=docs.filter(d=>!(remote&&d.scope.type==='workspace')),skippedPrivate=docs.length-allowed.length,live=new Map(allowed.map(d=>[d.id,d.revisionId]));
    await pool.query('DELETE FROM engram_vectors v WHERE v.model<>$1 OR NOT EXISTS(SELECT 1 FROM engram_documents d WHERE d.object_id=v.object_id AND d.revision_id=v.revision_id)',[embedder.modelId]);
    const rows=await pool.query('SELECT DISTINCT object_id,revision_id FROM engram_vectors WHERE model=$1',[embedder.modelId]);
    const present=new Set<string>((rows.rows as Array<{object_id:string;revision_id:string}>).map(r=>r.object_id+'\0'+r.revision_id));
    const pending=allowed.filter(d=>!present.has(d.id+'\0'+d.revisionId));let embeddedObjects=0,embeddedChunks=0,budget=options.maxObjects??Infinity;
    for(let at=0;at<pending.length&&budget>0;at+=16){if(options.signal?.aborted)break;const batch=pending.slice(at,Math.min(pending.length,at+16,at+budget)),chunks=batch.map(d=>chunkDocument(d.title,d.body)),texts=chunks.flat().map(c=>c.text),vectors=await embedder.embed(texts,options.signal?{signal:options.signal}:{});if(vectors.length!==texts.length||vectors.some(v=>vectors[0]?.length!==v.length))throw new MDBError('INVALID_MODEL_OUTPUT','Embedding provider returned inconsistent vectors');
      const client=await pool.connect();try{await client.query('BEGIN');const values:unknown[]=[],tuples:string[]=[];let n=0;for(let i=0;i<batch.length;i++)for(const c of chunks[i]!){const at=values.length;values.push(batch[i]!.id,batch[i]!.revisionId,c.index,c.lineStart,c.lineEnd,embedder.modelId,'['+vectors[n++]!.join(',')+']');tuples.push('($'+(at+1)+',$'+(at+2)+',$'+(at+3)+',$'+(at+4)+',$'+(at+5)+',$'+(at+6)+',$'+(at+7)+'::vector)');}await client.query('INSERT INTO engram_vectors(object_id,revision_id,chunk,line_start,line_end,model,embedding) VALUES '+tuples.join(',')+' ON CONFLICT(object_id,revision_id,chunk) DO UPDATE SET model=EXCLUDED.model,embedding=EXCLUDED.embedding,line_start=EXCLUDED.line_start,line_end=EXCLUDED.line_end',values);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}embeddedObjects+=batch.length;embeddedChunks+=texts.length;budget-=batch.length;
    }
    return{embeddedObjects,embeddedChunks,skippedPrivate,model:embedder.modelId,dimensions:embedder.dimensions};
  }
  async embedClear():Promise<{buckets:number}>{if(!this.vault.actor.permissions.includes('*'))throw new MDBError('NOT_FOUND_OR_FORBIDDEN','Embedding maintenance requires trusted owner identity');const pool=await this.ready();if(!this.vectorUnavailable)await pool.query('DELETE FROM engram_vectors');return{buckets:this.vectorUnavailable?0:1};}
  private async semantic(input:SearchInput,actor:ActorContext):Promise<SearchResult>{
    if(actor.actorId!==this.vault.actor.actorId)throw new MDBError('NOT_FOUND_OR_FORBIDDEN','Search identity must match trusted identity');const status=await this.vectorStatus();if(!status.ready)throw new MDBError('CAPABILITY_UNAVAILABLE',status.reason??'pgvector unavailable');
    const embedder=await this.embeddingProvider(),vector=(await embedder.embed([input.query.slice(0,2000)]))[0];if(!vector||vector.length!==status.dimensions)throw new MDBError('CAPABILITY_UNAVAILABLE','Query embedding dimensions do not match pgvector index');
    const {limit,offset}=validateSearchPage(input);if(offset+limit>1000)throw new MDBError('INVALID_INPUT','semantic paging is limited to first 1000 results');const docs=await authorizedDocuments(this.vault,input,actor);if(!docs.length)return{hits:[],mode:'semantic',backend:'postgres+pgvector',ranking:'cosine'};
    const rows=await (await this.ready()).query(`WITH ranked AS (
      SELECT v.object_id,v.revision_id,v.line_start,v.line_end,1-(v.embedding <=> $1::vector) AS similarity,
        row_number() OVER (PARTITION BY v.object_id ORDER BY v.embedding <=> $1::vector) AS chunk_rank
      FROM engram_vectors v JOIN engram_documents d ON d.object_id=v.object_id AND d.revision_id=v.revision_id
      WHERE v.model=$2 AND v.object_id=ANY($3::text[]) AND d.status NOT IN ('deleted','tombstone')
    ) SELECT object_id,revision_id,line_start,line_end,similarity FROM ranked WHERE chunk_rank=1
      ORDER BY similarity DESC,object_id ASC LIMIT 1000`,['['+vector.join(',')+']',embedder.modelId,docs.map(d=>d.id)]);
    const byId=new Map(docs.map(d=>[d.id,d.revisionId]));const sorted=(rows.rows as Array<{object_id:string;revision_id:string;line_start:number;line_end:number;similarity:number}>).filter(r=>byId.get(r.object_id)===r.revision_id).sort((a,b)=>b.similarity-a.similarity||a.object_id.localeCompare(b.object_id)).slice(offset,offset+limit+1),hits:SearchResult['hits']=[];
    for(let at=0;at<sorted.length;at+=BATCH){const batch=sorted.slice(at,at+BATCH),docs=await Promise.all(batch.map(r=>this.vault.get(r.object_id,r.revision_id).catch(()=>undefined)));for(let i=0;i<batch.length;i++){const d=docs[i],r=batch[i]!;if(!d)continue;const lines=d.body.split('\n'),start=Math.max(1,r.line_start);hits.push({objectId:d.id,uri:d.uri,revisionId:d.revisionId,title:d.title,kind:d.kind,snippet:lines.slice(start-1,Math.max(start+2,r.line_end)).join('\n').slice(0,600),lineStart:start,lineEnd:r.line_end,score:r.similarity,retrievalMode:'semantic',sources:['semantic']});}}
    const seen=await (await this.ready()).query('SELECT count(DISTINCT v.object_id)::int AS n FROM engram_vectors v JOIN engram_documents d ON d.object_id=v.object_id AND d.revision_id=v.revision_id WHERE v.model=$1 AND v.object_id=ANY($2::text[])',[embedder.modelId,docs.map(d=>d.id)]);
    return{hits:hits.slice(0,limit),mode:'semantic',backend:'postgres+pgvector',ranking:'cosine',...(hits.length>limit?{cursor:String(offset+limit)}:{}),vector:{backend:'pgvector',model:embedder.modelId,dimensions:status.dimensions??0,lagObjects:Math.max(0,docs.length-Number(seen.rows[0]?.n??0))}};
  }
  async query(input:SearchInput,actor:ActorContext=this.vault.actor):Promise<SearchResult>{
    const requested=input.mode??'auto';if(input.includeHistory||requested==='grep'||requested==='keyword'||input.regex)return this.keyword(input,actor);
    if(requested==='auto'&&(await this.config()).embedding?.autoHybrid===false)return this.keyword({...input,mode:'keyword'},actor);
    const status=await this.vectorStatus().catch(()=>({ready:false,reason:'pgvector unavailable'}));
    if(requested==='semantic'){if(!status.ready)throw new MDBError('CAPABILITY_UNAVAILABLE',status.reason??'pgvector unavailable');return this.semantic(input,actor);}
    const hybrid=requested==='hybrid'||(requested==='auto'&&status.ready);if(!hybrid)return this.keyword({...input,mode:'keyword'},actor);
    if(!status.ready){if(requested==='hybrid'&&input.allowFallback)return{...(await this.keyword({...input,mode:'keyword'},actor)),requestedMode:'hybrid',fallback:'Semantic retrieval unavailable ('+(status.reason??'pgvector unavailable')+'); keyword results'};throw new MDBError('CAPABILITY_UNAVAILABLE',status.reason??'pgvector unavailable');}
    const {limit,offset}=validateSearchPage(input);if(offset+limit>1000)throw new MDBError('INVALID_INPUT','hybrid paging is limited to first 1000 results');const depth=Math.min(1000,Math.max(100,5*(offset+limit)));
    const [kw,sem]=await Promise.all([this.keyword({...input,mode:'keyword',limit:depth,cursor:undefined},actor),this.semantic({...input,mode:'semantic',limit:depth,cursor:undefined},actor)]);const fused=new Map<string,{score:number;hit:SearchResult['hits'][number];sources:string[]}>(),k=60;
    kw.hits.forEach((hit,i)=>fused.set(hit.objectId,{score:1/(k+i+1),hit,sources:['keyword']}));sem.hits.forEach((hit,i)=>{const prior=fused.get(hit.objectId);if(prior){prior.score+=1/(k+i+1);prior.sources.push('semantic');}else fused.set(hit.objectId,{score:1/(k+i+1),hit,sources:['semantic']});});
    const hits=[...fused.values()].sort((a,b)=>b.score-a.score||a.hit.objectId.localeCompare(b.hit.objectId)).slice(offset,offset+limit+1).map(x=>({...x.hit,score:x.score,retrievalMode:'hybrid',sources:x.sources}));return{hits:hits.slice(0,limit),mode:'hybrid',...(requested==='auto'?{requestedMode:'auto'}:{}),backend:'postgres+pgvector',ranking:'rrf',...(hits.length>limit?{cursor:String(offset+limit)}:{})};
  }
  private async keyword(input: SearchInput, actor: ActorContext = this.vault.actor): Promise<SearchResult> {
    if (input.includeHistory || input.mode === 'grep' || input.regex) return this.files.query(input,actor);
    const {limit,offset}=validateSearchPage(input); const docs=await authorizedDocuments(this.vault,input,actor);
    if (!docs.length) return { hits:[],mode:'keyword',backend:'postgres',ranking:'ts-rank',...(input.mode==='hybrid'?{requestedMode:'hybrid'}:{}) };
    let pool:Pool; try { pool=await this.ready(); } catch(error) { this.unavailable=error instanceof MDBError?error.message:'PostgreSQL unavailable'; return { ...(await this.files.query({...input,mode:'keyword'},actor)),fallback:`PostgreSQL unavailable (${this.unavailable}); served from canonical Markdown` }; }
    for(const time of [input.since,input.until])if(time!==undefined&&Number.isNaN(Date.parse(time)))throw new MDBError('INVALID_INPUT','Invalid search time range');
    let ranked: QueryResult<Ranked>;try{ranked=await pool.query<Ranked>(`WITH q AS (SELECT websearch_to_tsquery('simple',$1) AS query)
      SELECT d.object_id,d.revision_id,ts_rank_cd(d.search_vector,q.query) AS rank
      FROM engram_documents d CROSS JOIN q
      WHERE d.object_id=ANY($2::text[]) AND d.status NOT IN ('deleted','tombstone') AND d.search_vector @@ q.query
        AND ($3::text[] IS NULL OR d.kind=ANY($3::text[])) AND ($4::text[] IS NULL OR d.tags @> $4::text[])
        AND ($5::timestamptz IS NULL OR d.updated_at >= $5::timestamptz) AND ($6::timestamptz IS NULL OR d.updated_at <= $6::timestamptz)
      ORDER BY rank DESC,d.object_id ASC LIMIT $7 OFFSET $8`,[input.query,docs.map(d=>d.id),input.kinds??null,input.tags??null,input.since??null,input.until??null,Math.min(1000,offset+limit+1),offset]);}
    catch(error){this.unavailable='PostgreSQL query unavailable';return{...(await this.files.query({...input,mode:'keyword'},actor)),fallback:`PostgreSQL unavailable (${this.unavailable}); served from canonical Markdown`};}
    const revisionById=new Map(docs.map(d=>[d.id,d.revisionId])); const hits:SearchResult['hits']=[];
    for(let i=0;i<ranked.rows.length;i+=BATCH){const rows=ranked.rows.slice(i,i+BATCH);const loaded=await Promise.all(rows.map(async r=>{if(revisionById.get(r.object_id)!==r.revision_id)return undefined;try{return await this.vault.get(r.object_id,r.revision_id);}catch{return undefined;}}));
      for(let j=0;j<rows.length;j++){const doc=loaded[j];if(!doc)continue;const r=rows[j]!;const terms=input.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);const lines=doc.body.split('\n');let line=lines.findIndex(s=>terms.some(t=>s.toLocaleLowerCase().includes(t)));if(line<0)line=0;hits.push({objectId:doc.id,uri:doc.uri,revisionId:doc.revisionId,title:doc.title,kind:doc.kind,snippet:lines.slice(line,line+3).join('\n').slice(0,600),lineStart:line+1,lineEnd:Math.min(lines.length,line+3),score:r.rank,retrievalMode:'keyword'});}}
    return {hits:hits.slice(0,limit),mode:'keyword',backend:'postgres',ranking:'ts-rank',...(hits.length>limit?{cursor:String(offset+limit)}:{}),...(input.mode==='hybrid'?{requestedMode:'hybrid',fallback:'PostgreSQL semantic vectors are not configured; keyword results only'}:{})};
  }
  async health(): Promise<Record<string,unknown>> { try { const pool=await this.ready();const state=await pool.query<{journal_sequence:string}>('SELECT journal_sequence::text FROM engram_index_state WHERE id=true');return{backend:'postgres',available:true,derived:true,checkpoint:state.rows[0]?.journal_sequence??null,reason:this.unavailable??null,pgvector:!this.vectorUnavailable,vectorReason:this.vectorUnavailable??null}; } catch { return{backend:'postgres',available:false,derived:true,reason:'PostgreSQL connection or schema unavailable',pgvector:false}; } }
  async close(): Promise<void> { await this.pool?.end(); this.pool=undefined;this.initialized=false; }
}
