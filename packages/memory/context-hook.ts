import { ensureWatcher } from './outbox-watch.js';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureStorageDirectory, resolveStoragePath } from '../core/root.js';
import { assertAvailableStorage, assertStorageQuota } from '../core/storage-lifecycle.js';
import { findTrustedBinding } from '../core/project-trust.js';
import { Engram } from '../sdk/index.js';
import { buildSessionContext } from './session-context.js';
import { defaultOutboxDirectory, listOutbox } from './outbox.js';
import { drainOutboxNow } from './mcp-proxy.js';
import { openRemoteSession, RemoteError } from './remote-client.js';
import { readUserConfig } from './user-config.js';
import { insideProject } from './user-setup.js';

/**
 * SessionStart context hook. Runs once per session, never per prompt. It is silent on every failure (a hook must not break the agent), asks the server for one bounded context for
 * the workspace this project is bound to (or the user's workspace), and prints it as host-documented injection output. A cached copy is used only when the server cannot be reached,
 * is marked STALE, expires, and is deleted the moment the server refuses the credential, so revoked access is never replayed from disk.
 */
export type ContextOutcome = 'fresh' | 'stale' | 'none' | 'revoked' | 'disabled' | 'error';
export interface ContextHookResult { outcome: ContextOutcome; output: string; workspaceId?: string; reason?: string }
export interface ContextHookOptions { host: string; stdin: string; projectRoot?: string; user?: boolean; root?: string; format?: 'claude' | 'text'; env?: NodeJS.ProcessEnv; now?: Date; timeoutMs?: number; cacheTtlMs?: number }

export const cacheDir = (env: NodeJS.ProcessEnv = process.env): string => resolveStoragePath('cache', env);
const cacheFile = (env: NodeJS.ProcessEnv, url: string, workspace: string, credential: string) => path.join(cacheDir(env), 'context', `${createHash('sha256').update(`${url}\0${workspace}\0${credential}`).digest('hex').slice(0, 24)}.json`);
async function writePrivate(file: string, content: string): Promise<void> { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${process.pid}.${randomUUID()}.tmp`; try { await fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); } }
export interface ContextState { host: string; at: string; outcome: ContextOutcome; workspaceId?: string; reason?: string }
export const contextStateFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(resolveStoragePath('state', env), 'context-state.json');
async function recordState(env: NodeJS.ProcessEnv, state: ContextState): Promise<void> {
  try { await ensureStorageDirectory('state', env); let all: Record<string, ContextState> = {}; try { all = JSON.parse(await fs.readFile(contextStateFile(env), 'utf8')); } catch { /* first run */ } all[`${state.host}:${state.workspaceId ?? '-'}`] = state; await writePrivate(contextStateFile(env), JSON.stringify(all, null, 2)); } catch { /* diagnostics only */ }
}
const render = (host: string, text: string, format: 'claude' | 'text'): string => format === 'claude' ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n` : `${text}\n`;
function profileProjectionRows(content: string): Array<{id:string;scope:string;category:string;claim:string}> {
  const rows:Array<{id:string;scope:string;category:string;claim:string}>=[];
  for(const section of content.split(/\n(?=# (?:PROFILE|USER_INSIGHT)\s*$)/m)){
    let scope='global';
    for(const line of section.split('\n')){
      const heading=/^### Workspace: (.+)$/.exec(line);if(heading){scope=heading[1]!.trim();continue;}if(/^### Global$/.test(line)){scope='global';continue;}
      const item=/^- \*\*([^*]+)\*\* — (.*?) _\(/.exec(line);if(item)rows.push({id:`snapshot-${rows.length}`,scope,category:item[1]!.toLowerCase().replace(/[^a-z_]+/g,'_'),claim:item[2]!});
    }
  }
  return rows;
}

async function drainWaitingWrites(url: string, token: string, workspaceId: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const directory = env.ENGRAM_OUTBOX ?? defaultOutboxDirectory(); if (!(await listOutbox(directory, entry => entry.url === url && (entry.workspaceId ?? '') === workspaceId)).length) return;
    const result = await drainOutboxNow({ url, token, workspaceId, outbox: directory, timeoutMs: 1200, waitMs: 1800 });
    if (result?.stopped === 'offline' || (result?.remaining ?? 0) > 0) await ensureWatcher({ url, token, workspaceId, outbox: directory, env }); // still waiting (after a reboot, say): keep trying in the background
  } catch { /* the outbox is retried by the proxy and by the next session */ }
}
export async function runContextHook(options: ContextHookOptions): Promise<ContextHookResult> {
  const env = options.env ?? process.env; const now = options.now ?? new Date(); const format = options.format ?? (options.host === 'claude-code' ? 'claude' : 'text');
  const finish = async (result: ContextHookResult): Promise<ContextHookResult> => { await recordState(env, { host: options.host, at: now.toISOString(), outcome: result.outcome, ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}), ...(result.reason ? { reason: result.reason } : {}) }); return result; };
  try {
    if (options.projectRoot && !(await insideProject(options.stdin, options.projectRoot))) return { outcome: 'disabled', output: '', reason: 'session is outside this project' };
    let payload: { cwd?: unknown }; try { payload = JSON.parse(options.stdin) as { cwd?: unknown }; } catch { return { outcome: 'disabled', output: '', reason: 'unreadable hook payload' }; }
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''; if (!cwd) return { outcome: 'disabled', output: '', reason: 'no working directory' };
    const found = await findTrustedBinding(cwd, env).catch(() => undefined);
    // A binding this machine did not create is never obeyed: it could name any server and any environment variable as the credential.
    if (found && !found.trusted && !options.user) return { outcome: 'disabled', output: '', reason: 'this project binding is not trusted on this machine (run mdb init here)' };
    const bound = found?.trusted ? found : undefined;
    let workspaceId: string, serverUrl: string | undefined, tokenEnv: string | undefined, maxTokens = 2500, domains: import('../profile/domains.js').ProfileDomain[] | undefined, replicaId:string|undefined;
    if (bound) { if (options.user) return { outcome: 'disabled', output: '', reason: 'project hook handles this project' }; workspaceId = bound.binding.workspaceId; serverUrl = bound.binding.serverUrl; tokenEnv = bound.binding.credentialRef; maxTokens = bound.binding.sessionContextMaxTokens; domains = bound.binding.domains; replicaId=bound.binding.mode==='replica'?bound.binding.replicaId:undefined; }
    else if (options.user) {
      const config = await readUserConfig(env); if (!config || config.paused) return { outcome: 'disabled', output: '', reason: 'user-level capture is not active' };
      if (config.excludeProjects.some(pattern => new RegExp(pattern, 'i').test(cwd))) return { outcome: 'disabled', output: '', reason: 'project is excluded' };
      if (config.includeProjects?.length && !config.includeProjects.some(pattern => new RegExp(pattern, 'i').test(cwd))) return { outcome: 'disabled', output: '', reason: 'project is not on the recording allowlist' };
      workspaceId = config.workspaceId; serverUrl = config.serverUrl; tokenEnv = config.tokenEnv;
    } else return { outcome: 'disabled', output: '', reason: 'project is not initialized' };
    if (replicaId) { // Replica-mode context is entirely local, including the server-filtered profile snapshot.
      const {openReplica}=await import('../replication/client.js');const{store}=await openReplica(replicaId);const client=new Engram(store.vault.root,store.vault.actor,undefined,{vault:store.vault});const context=await buildSessionContext(client,{workspaceId,maxTokens,now,...(domains?{domains}:{})});let extra='';try{const snapshot=JSON.parse(await fs.readFile(path.join(store.state,'profile-snapshot.json'),'utf8')) as {content?:string};if(typeof snapshot.content==='string'){const rows=profileProjectionRows(snapshot.content);const projection=(await import('../project-init.js')).buildProjection(rows,workspaceId,Math.min(800,Math.floor(maxTokens*.35)),'local',undefined,domains);const items=[...projection.preferences,...projection.insights];if(items.length)extra=`\n\n## Server profile snapshot (read-only)\n${items.map(item=>`- ${item.claim}`).join('\n')}`;}}catch{/* a missing snapshot is a normal first-run state */}return finish({outcome:'fresh',output:render(options.host,context.text+extra,format),workspaceId});
    }
    if (!serverUrl) { // local mode: read the local vault directly, no network
      if (!options.root) return { outcome: 'none', output: '', workspaceId, reason: 'no vault root given for local mode' };
      const context = await buildSessionContext(new Engram(options.root), { workspaceId, maxTokens, now, ...(domains ? { domains } : {}) });
      return finish({ outcome: 'fresh', output: render(options.host, context.text, format), workspaceId });
    }
    const token = tokenEnv ? env[tokenEnv] : undefined; if (!token) return finish({ outcome: 'none', output: '', workspaceId, reason: `$${tokenEnv} is not set; no context without authentication` });
    // Writes this machine kept while the server was unreachable are sent now that a session is starting (bounded: the hook has a few seconds). Failure here never affects the context.
    await drainWaitingWrites(serverUrl, token, workspaceId, env);
    await ensureStorageDirectory('cache', env);
    const credential = createHash('sha256').update(`engram-credential\0${token}`).digest('hex').slice(0, 24); // identity of the credential, never the credential
    const file = cacheFile(env, serverUrl, workspaceId, credential);
    try {
      const session = await openRemoteSession({ url: serverUrl, token, workspaceId, timeoutMs: options.timeoutMs ?? 1500 });
      const reply = await session.call('engram_session_context', { maxTokens, ...(domains ? { domains } : {}) });
      const value = reply.value as { text?: string; revision?: string } | undefined;
      if (reply.isError || !value?.text) { if (/NOT_FOUND_OR_FORBIDDEN/.test(JSON.stringify(reply.value))) throw new RemoteError('workspace', 'access refused'); return finish({ outcome: 'none', output: '', workspaceId, reason: 'the server returned no context' }); }
      const sections = { profile: /## Accepted user (?:preferences|insights)/.test(value.text), shared: /## Shared notes/.test(value.text), wiki: /## Accepted wiki pages/.test(value.text) };
      const contentBinding = createHash('sha256').update(`${value.revision ?? ''}\0${JSON.stringify(sections)}\0${credential}`).digest('hex');
      const cachedContent = JSON.stringify({ workspaceId, serverUrl, credential, sections, contentBinding, fetchedAt: now.toISOString(), revision: value.revision, text: value.text });
      await assertAvailableStorage(cacheDir(env), env, Buffer.byteLength(cachedContent));
      await assertStorageQuota('cache', cacheDir(env), Buffer.byteLength(cachedContent), env);
      await writePrivate(file, cachedContent);
      return finish({ outcome: 'fresh', output: render(options.host, value.text, format), workspaceId });
    } catch (error) {
      if (error instanceof RemoteError && (error.kind === 'auth' || error.kind === 'workspace')) { await fs.rm(file, { force: true }); return finish({ outcome: 'revoked', output: '', workspaceId, reason: error.message }); }
      if (error instanceof RemoteError && error.kind === 'transport-refused') return finish({ outcome: 'none', output: '', workspaceId, reason: error.message });
      // unreachable or unreadable: a recent cached copy of what this credential was allowed to see, clearly marked
      try {
        const cached = JSON.parse(await fs.readFile(file, 'utf8')) as { workspaceId: string; serverUrl: string; credential?: string; sections?: { profile?: boolean; shared?: boolean; wiki?: boolean }; contentBinding?: string; revision?: string; fetchedAt: string; text: string };
        if (cached.credential !== credential) { await fs.rm(file, { force: true }); return finish({ outcome: 'none', output: '', workspaceId, reason: 'the cached context belongs to a different credential' }); } // another identity must never be served what the previous one was allowed to see
        const expectedBinding = createHash('sha256').update(`${cached.revision ?? ''}\0${JSON.stringify(cached.sections ?? {})}\0${credential}`).digest('hex');
        if (cached.contentBinding !== expectedBinding) { await fs.rm(file, { force: true }); return finish({ outcome: 'none', output: '', workspaceId, reason: 'the cached context binding is invalid' }); }
        const age = now.getTime() - Date.parse(cached.fetchedAt); const ttl = options.cacheTtlMs ?? 24 * 3600_000;
        if (cached.workspaceId === workspaceId && cached.serverUrl === serverUrl && Number.isFinite(age) && age >= 0 && age <= ttl) {
          const text = cached.text.replace(/status: FRESH/, `status: STALE (cached ${cached.fetchedAt}; the server could not be reached)`);
          return finish({ outcome: 'stale', output: render(options.host, text, format), workspaceId, reason: 'server unreachable' });
        }
        await fs.rm(file, { force: true });
      } catch { /* no usable cache */ }
      return finish({ outcome: 'none', output: '', workspaceId, reason: error instanceof Error ? error.message : 'server unreachable' });
    }
  } catch (error) { return { outcome: 'error', output: '', reason: error instanceof Error ? error.name : 'error' }; }
}
