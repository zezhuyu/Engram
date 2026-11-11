import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MDBError } from '../core/types.js';
import { findTrustedBinding } from '../core/project-trust.js';
import { proxyCall } from '../memory/mcp-proxy.js';

/**
 * Remote mode for the CLI: any client machine runs the same `mdb` commands against the Engram server (the server does all the work; the CLI only sends the request and prints the answer).
 * The target is, in this order: `--server URL` (with `--token-env VAR`, default ENGRAM_TOKEN, and `--workspace ID`), the ENGRAM_URL environment variable, or the remote server of the
 * trusted Engram project binding in the current directory. `--root` always means the local vault. Calls go through the same path as the agent proxy, so task, note and handoff writes made while the
 * server is unreachable are kept in the local outbox (and merged into the server's version when it returns) instead of being lost; reads fail with an explicit error.
 */
export interface RemoteTarget { url: string; tokenEnv: string; token: string; workspaceId?: string; via: 'flag' | 'environment' | 'project' }
type Flags = Record<string, string | boolean>;
const text = (flags: Flags, name: string, fallback?: string): string | undefined => typeof flags[name] === 'string' ? flags[name] as string : fallback;
const num = (flags: Flags, name: string): number | undefined => { const v = text(flags, name); if (v === undefined) return undefined; const n = Number(v); if (!Number.isSafeInteger(n)) throw new MDBError('INVALID_ARGUMENT', `--${name} must be an integer`); return n; };
const csv = (flags: Flags, name: string): string[] | undefined => text(flags, name)?.split(',').map(s => s.trim()).filter(Boolean);
const need = (value: string | undefined, name: string): string => { if (!value) throw new MDBError('INVALID_ARGUMENT', `${name} is required`); return value; };
const jsonFlag = (flags: Flags, name: string): Record<string, unknown> => { const raw = text(flags, name); if (!raw) return {}; let v: unknown; try { v = JSON.parse(raw); } catch { throw new MDBError('INVALID_ARGUMENT', `--${name} must be a JSON object`); } if (!v || typeof v !== 'object' || Array.isArray(v)) throw new MDBError('INVALID_ARGUMENT', `--${name} must be a JSON object`); return v as Record<string, unknown>; };
const bodyOf = async (flags: Flags): Promise<string> => text(flags, 'file') ? readFile(resolve(text(flags, 'file')!), 'utf8') : need(text(flags, 'body'), '--body or --file');
const scopeFlag = (flags: Flags): Record<string, unknown> | undefined => {
  const value = text(flags, 'scope'); if (!value && !text(flags, 'workspace')) return undefined;
  if (!value) return { type: 'workspace', workspaceId: text(flags, 'workspace')!, ...(text(flags, 'collection') ? { collectionId: text(flags, 'collection')! } : {}) };
  const p = value.split(':'); if (p[0] === 'workspace' && p[1]) return { type: 'workspace', workspaceId: p[1], ...(p[2] ? { collectionId: p[2] } : {}) };
  const area = p[0] === 'global' ? p[1] : p[0]; if (['wiki', 'shared', 'discoveries', 'profile'].includes(area ?? '')) return { type: 'global', area };
  throw new MDBError('INVALID_ARGUMENT', 'Scope must be workspace:ID[:COLLECTION] or global:AREA');
};
const compact = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== false));

export async function remoteTarget(flags: Flags, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<RemoteTarget | undefined> {
  if (text(flags, 'root') || flags.local) return undefined; // an explicit local vault always wins
  const explicit = text(flags, 'server') ?? text(flags, 'mcp-url') ?? env.ENGRAM_URL;
  let url: string | undefined, tokenEnv: string | undefined, workspaceId = text(flags, 'workspace'), via: RemoteTarget['via'] = 'flag';
  if (explicit) { url = explicit; tokenEnv = text(flags, 'token-env') ?? env.ENGRAM_TOKEN_ENV ?? 'ENGRAM_TOKEN'; via = text(flags, 'server') || text(flags, 'mcp-url') ? 'flag' : 'environment'; }
  else { const found = await findTrustedBinding(cwd, env).catch(() => undefined); if (!found?.trusted || !found.binding.serverUrl || !found.binding.credentialRef || found.binding.mode==='replica') return undefined; url = found.binding.serverUrl; tokenEnv = found.binding.credentialRef; workspaceId ??= found.binding.workspaceId; via = 'project'; }
  const token = env[tokenEnv!]; if (!token) throw new MDBError('INVALID_ARGUMENT', `Environment variable ${tokenEnv} is not set (it holds the credential for ${url})`);
  return { url: url!, tokenEnv: tokenEnv!, token, ...(workspaceId ? { workspaceId } : {}), via };
}

/** CLI commands that have a server equivalent. Everything else keeps working on a local vault. */
export const REMOTE_COMMANDS = new Set(['search', 'grep', 'context', 'get', 'history', 'put', 'patch', 'workspace', 'collection', 'memory', 'insight', 'profile', 'capabilities', 'task', 'note', 'handoff', 'remote', 'wiki']);
const REMOTE_SUBCOMMANDS: Record<string, string[]> = { profile: ['domains'], workspace: ['list', 'create'], collection: ['list'], memory: ['recent', 'timeline', 'search', 'get'], insight: ['search'], task: ['upsert'], note: ['upsert'], handoff: ['write'], remote: ['tools', 'call'], wiki: ['lint', 'propose', 'proposals'] };
export const usesServer = (command: string, sub: string | undefined): boolean => REMOTE_COMMANDS.has(command) && (!REMOTE_SUBCOMMANDS[command] || REMOTE_SUBCOMMANDS[command]!.includes(sub ?? ''));

export async function mapCommand(command: string, args: string[], flags: Flags): Promise<{ tool: string; input: Record<string, unknown> } | 'list'> {
  const [, sub, third] = args; const scope = command === 'wiki' ? undefined : scopeFlag(flags);
  const searchArgs = () => compact({ query: need(command === 'context' ? text(flags, 'task', sub) : sub, 'query'), mode: text(flags, 'mode', command === 'grep' ? 'grep' : 'auto'), regex: !!flags.regex, caseSensitive: !!flags['case-sensitive'], allowFallback: !!flags['allow-fallback'], includeHistory: !!flags['include-history'], limit: num(flags, 'limit'), cursor: text(flags, 'cursor'), kinds: csv(flags, 'kinds'), tags: csv(flags, 'tags'), since: text(flags, 'since'), until: text(flags, 'until'), scopes: scope ? [scope] : undefined });
  switch (command) {
    case 'profile': { const action = third; if (!['list','suggest','apply','set','registry','add','rename','merge','retire','auto-apply'].includes(action ?? '')) throw new MDBError('INVALID_ARGUMENT', 'profile domains list|suggest|apply|set|registry|add|rename|merge|retire|auto-apply'); return { tool: 'mdb_profile_domains', input: compact({ action, id: action === 'set' ? args[3] : undefined, slug: action === 'rename' || action === 'merge' || action === 'retire' ? args[3] : text(flags, 'slug'), domains: csv(flags, 'domains'), label: text(flags, 'label'), description: text(flags, 'description'), keywords: csv(flags, 'keywords'), evidence: text(flags, 'evidence') ? [text(flags, 'evidence')] : undefined, into: text(flags, 'into'), enabled: action === 'auto-apply' ? text(flags, 'enabled') !== 'false' : undefined, yes: !!flags.yes }) }; }
    case 'wiki': {
      if (sub === 'proposals') return { tool: 'mdb_wiki_proposals', input: compact({ status: text(flags, 'status') }) };
      if (sub === 'propose') {
        const action = third; if (!['retire', 'restore', 'rename', 'merge'].includes(action ?? '')) throw new MDBError('INVALID_ARGUMENT', 'wiki propose requires retire, restore, rename, or merge');
        const sourceRefs = csv(flags, 'source')?.map(value => { const [pageId, revisionId, ...extra] = value.split(':'); if (!pageId || !revisionId || extra.length) throw new MDBError('INVALID_ARGUMENT', '--source must be ID:REVISION'); return { pageId, revisionId }; });
        const refs = csv(flags, 'evidence')?.map(value => { const match = /^(.*):([^:]+)(?::(.*))?$/.exec(value); if (!match?.[1]) throw new MDBError('INVALID_ARGUMENT', '--evidence must be URI:REVISION[:SPAN]'); return { uri: match[1], revisionId: match[2]!, ...(match[3] ? { span: match[3] } : {}) }; });
        return { tool: 'mdb_wiki_propose_change', input: compact({ action, targetPageId: need(text(flags, action === 'merge' ? 'target' : 'page'), action === 'merge' ? '--target' : '--page'), targetRevisionId: need(text(flags, 'revision'), '--revision'), reason: need(text(flags, 'reason'), '--reason'), restoreRevisionId: action === 'restore' ? need(text(flags, 'to-revision'), '--to-revision') : undefined, newTitle: action === 'rename' ? need(text(flags, 'title'), '--title') : undefined, mergeSources: sourceRefs, title: action === 'merge' ? need(text(flags, 'title'), '--title') : undefined, body: action === 'merge' ? await bodyOf(flags) : undefined, evidence: action === 'merge' ? refs : undefined }) };
      }
      const scope = (value: string): Record<string, unknown> => {
        const p = value.split(':'); if (p[0] === 'workspace' && p[1]) return { type: 'workspace', workspaceId: p[1], ...(p[2] ? { collectionId: p[2] } : {}) };
        const area = p[0] === 'global' ? p[1] : p[0]; if (['wiki', 'shared', 'discoveries', 'profile'].includes(area ?? '')) return { type: 'global', area };
        throw new MDBError('INVALID_ARGUMENT', 'Scope must be workspace:ID[:COLLECTION] or global:AREA');
      };
      return { tool: 'mdb_wiki_lint', input: compact({ scopes: csv(flags, 'scope')?.map(scope), checks: csv(flags, 'check'), minSeverity: text(flags, 'min-severity'), limit: num(flags, 'limit') }) };
    }
    case 'search': case 'grep': return { tool: command === 'grep' ? 'mdb_grep' : 'mdb_search', input: searchArgs() };
    case 'context': return { tool: 'mdb_context', input: { ...searchArgs(), ...(num(flags, 'budget') ? { budgetTokens: num(flags, 'budget') } : {}) } };
    case 'get': return { tool: 'mdb_get', input: compact({ objectId: need(sub, 'object ID'), revisionId: text(flags, 'revision') }) };
    case 'history': return { tool: 'mdb_history', input: { objectId: need(sub, 'object ID') } };
    case 'put': return { tool: 'mdb_put', input: compact({ scope, kind: text(flags, 'kind', 'note'), title: need(text(flags, 'title'), '--title'), body: await bodyOf(flags), tags: csv(flags, 'tags'), status: text(flags, 'status'), idempotencyKey: text(flags, 'idempotency-key') }) };
    case 'patch': return { tool: 'mdb_patch', input: compact({ objectId: need(sub, 'object ID'), expectedRevisionId: need(text(flags, 'revision'), '--revision'), title: text(flags, 'title'), body: text(flags, 'body') || text(flags, 'file') ? await bodyOf(flags) : undefined, tags: csv(flags, 'tags'), status: text(flags, 'status') }) };
    case 'workspace': return sub === 'list' ? { tool: 'mdb_workspace_list', input: {} } : { tool: 'mdb_workspace_create', input: compact({ workspaceId: need(third, 'workspace ID'), description: text(flags, 'description') }) };
    case 'collection': return { tool: 'mdb_collection_list', input: { workspaceId: need(third ?? text(flags, 'workspace'), 'workspace ID') } };
    case 'insight': return { tool: 'mdb_insight_search', input: compact({ query: third, category: text(flags, 'category'), status: text(flags, 'status'), scopeLabel: text(flags, 'scope-label'), limit: num(flags, 'limit') }) };
    case 'capabilities': return { tool: 'mdb_capabilities', input: {} };
    case 'memory': {
      // the memory tools use an enum scope (current_collection|workspace|shared|authorized_all) plus separate workspace and collection ids, not a scope object
      const memoryScope = ['current_collection', 'workspace', 'shared', 'authorized_all'].includes(text(flags, 'scope') ?? '') ? text(flags, 'scope') : undefined;
      const common = { scope: memoryScope, workspaceId: text(flags, 'workspace'), collectionId: text(flags, 'collection'), limit: num(flags, 'limit'), types: csv(flags, 'types'), from: text(flags, 'from'), to: text(flags, 'to'), detail: text(flags, 'detail'), tokenBudget: num(flags, 'budget') };
      if (sub === 'recent') return { tool: 'mdb_memory_recent', input: compact(common) };
      if (sub === 'timeline') return { tool: 'mdb_memory_timeline', input: compact({ ...common, sessionId: text(flags, 'session'), aroundId: text(flags, 'around'), window: num(flags, 'window') }) };
      if (sub === 'search') return { tool: 'mdb_memory_search', input: compact({ ...common, mode: text(flags, 'mode', 'keyword'), query: third, sessionId: text(flags, 'session'), aroundId: text(flags, 'around') }) };
      return { tool: 'mdb_memory_get', input: compact({ ids: args.slice(2), tokenBudget: num(flags, 'budget') }) };
    }
    case 'task': return { tool: 'engram_task_upsert', input: compact({ scope, taskId: need(text(flags, 'id'), '--id'), title: need(text(flags, 'title'), '--title'), status: need(text(flags, 'status'), '--status'), body: text(flags, 'body') || text(flags, 'file') ? await bodyOf(flags) : undefined, assignee: text(flags, 'assignee'), sessionId: text(flags, 'session'), expectedRevisionId: text(flags, 'expected-revision'), asOf: text(flags, 'as-of') }) };
    case 'note': return { tool: 'engram_note_upsert', input: compact({ scope, noteId: need(text(flags, 'id'), '--id'), title: need(text(flags, 'title'), '--title'), body: await bodyOf(flags), tags: csv(flags, 'tags'), sourcePath: text(flags, 'source-path'), sessionId: text(flags, 'session'), status: text(flags, 'status'), expectedRevisionId: text(flags, 'expected-revision'), asOf: text(flags, 'as-of') }) };
    case 'handoff': return { tool: 'engram_handoff_write', input: compact({ scope, sessionId: need(text(flags, 'session'), '--session'), state: need(text(flags, 'state'), '--state'), completed: csv(flags, 'completed') ?? [], next: csv(flags, 'next') ?? [], blockers: csv(flags, 'blockers') ?? [], filesTouched: csv(flags, 'files') ?? [], openTasks: csv(flags, 'open-tasks') ?? [], asOf: text(flags, 'as-of') }) };
    case 'remote': if (sub === 'tools') return 'list'; return { tool: need(third, 'tool name'), input: jsonFlag(flags, 'input') };
    default: throw new MDBError('INVALID_ARGUMENT', `${command} has no server equivalent`);
  }
}

export async function runRemote(target: RemoteTarget, args: string[], flags: Flags): Promise<unknown> {
  const mapped = await mapCommand(args[0]!, args, flags); const options = { url: target.url, token: target.token, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}), ...(text(flags, 'outbox') ? { outbox: resolve(text(flags, 'outbox')!) } : {}) };
  if (mapped === 'list') { const reply = await proxyCall(options, 'tools/list'); if (reply.isError) throw new MDBError('SERVER_UNREACHABLE', reply.text); return ((reply.value as { tools?: Array<{ name: string; description?: string }> }).tools ?? []).map(t => ({ name: t.name, description: (t.description ?? '').split(/(?<=\.)\s/)[0] })); }
  const reply = await proxyCall(options, 'tools/call', { name: mapped.tool, arguments: mapped.input });
  if (reply.isError) { const error = (reply.value as { error?: { code?: string; message?: string } } | undefined)?.error; throw new MDBError(error?.code ?? 'REMOTE_ERROR', error?.message ?? reply.text); }
  return reply.value;
}
