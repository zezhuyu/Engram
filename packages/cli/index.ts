import { readFile } from 'node:fs/promises';
import { queryCommand, lineGrep, STREAM_COMMANDS, STREAMED } from './query.js';
import { detectUnix, unixMain } from './unix.js';
import { resolve } from 'node:path';
import { initializeProject, refreshContext, type Host } from '../project-init.js';
import { projectDoctor } from '../memory/project-doctor.js';
import { runContextHook } from '../memory/context-hook.js';
import { localSink, pathsFromHookPayload, reconcile, remoteSink, syncFile, syncReport } from '../memory/file-sync.js';
import { readBinding } from '../core/project-binding.js';
import { captureForUser, insideProject, setUserPaused, setupUser, uninstallUser, userStatus } from '../memory/user-setup.js';
import { touchActivity } from '../adaptive/activity.js';
import { createHttpCredential, credentialAudit, revokeHttpCredential, rotateHttpCredential } from '../mcp/credentials.js';
import { createRegistration, revokeRegistration } from '../memory/capture.js';
import { drainRemoteCaptureSpool, queueRemoteCapture } from '../memory/remote-spool.js';
import type { JobKind } from '../intelligence/index.js';
import { Engram, Vault, MDBError, OWNER, resolveRoot, createAdapter, captureFromHook, readStdin, recordExplicit, drainSpool, sweepAbandoned, spoolStats, listRegistrations, type MemorySearchRequest, type MemoryEventType, type InsightCategory, recordFeedback, rateDiscovery, resetLearning, learnedParams, familyOf, type RankingLabel, staleDiscoveries, readStats, type DiscoveryOutcome, type DreamMode, createProviderFromConfig, isBuiltinProvider, effectiveProvider, type ModelProvider, type Scope, type PutInput, type PatchInput } from '../sdk/index.js';

/** Builds the vault-configured built-in provider (openai, ollama, openai-compatible). Returns undefined, with a stderr note, when unavailable. */
async function configuredProvider(root: string): Promise<ModelProvider | undefined> {
  let config; try { config = await new Vault(root).config(); } catch { return undefined; }
  if (!isBuiltinProvider(effectiveProvider(config.model))) return undefined;
  try { return createProviderFromConfig(config.model); }
  catch (error) { if (error instanceof MDBError && ['CAPABILITY_UNAVAILABLE'].includes(error.code)) { process.stderr.write(`model provider unavailable: ${error.message}\n`); return undefined; } throw error; }
}

const HELP = `mdb — Markdown-native agent knowledge database
Usage: mdb COMMAND [arguments] [--root PATH] [--json]

init [--no-sqlite] [--postgres] Initialize a vault (Markdown is canonical)
init --project --host claude-code|codex [--project-dir PATH] [--settings-path PATH] [--mcp-url URL --token-env NAME]
                               [--registration REG_ID --principal ACTOR --consent]
                               Initialize project memory, host capture, and AGENTS.md/CLAUDE.md
                               [--hosts claude-code,codex|auto instead of --host] [--workspace ID]: writes .engram/project.json (gitignored), managed blocks, MCP config
setup --user --consent --hosts H --mcp-url URL --token-env NAME --registration REG --principal ACTOR [--workspace personal] [--exclude PATTERN,...]
                               One-time user-level capture for EVERY project (also --show --pause --resume --uninstall)
notes sync [--project-dir PATH] [--report]          Synchronize approved Markdown files (needs init --file-sync-consent)
project refresh-context [--project-dir PATH] [--remote]   Rewrite the managed blocks from the current accepted profile
doctor --project [--project-dir PATH] [--no-probe]        Per-feature PASS/INCOMPLETE/DISABLED/FAIL/NOT_RUN report for this project
doctor | verify | recover | reconcile
credential create --actor ID --permissions SCOPE:read,SCOPE:write | rotate ID [--permissions ...] | revoke ID | audit
workspace create ID | list | info ID | grant ID ACTOR --permissions read,write | revoke ID ACTOR
collection create ID --workspace ID | list --workspace ID | info ID --workspace ID
put --scope workspace:ID[:COLLECTION] --kind note --title TITLE --body TEXT [--file PATH]
get ID [--revision REV] | patch ID --revision REV [--body TEXT] | delete ID --revision REV
history ID | diff ID FROM TO | restore ID REV --revision CURRENT
ingest PATH --scope SCOPE       Explicit local source only; bytes preserved
grep TEXT [--regex] | search QUERY --mode keyword|semantic|hybrid|auto [--scope SCOPE]
links ID | backlinks ID | related ID --depth N
context --task TEXT --scope SCOPE --budget-tokens N
promote ID --to shared|wiki|discoveries --review --body SANITIZED_TEXT
session start --scope SCOPE | observe --session ID --body TEXT | end --session ID
profile show | propose --scope SCOPE | proposals | approve ID [--confirm-sensitive] [--confirm-hypothesis] | reject ID --reason TEXT | reconcile
profile correct --key SLUG --claim TEXT --category preference|goal|interest|capability|working_style|knowledge_gap [--workspace W] [--reason T] [--source URI --revision R --span QUOTE] | profile project
intelligence run --job index|profile|wiki|memory|reflect|dream
intelligence run --snapshot now --stage daily [--key IDEMPOTENCY_KEY]   (sealed-snapshot daily cycle: workspaces -> global profile -> dream)
intelligence schedule status|configure|pause|resume|tick|worker|service launchd|systemd [--label L] [--log FILE] [--interval-s N]|events   configure: --enable|--disable --timezone IANA --time HH:MM --quiet-start HH:MM --quiet-end HH:MM --mode adaptive|fixed --auto-accept none|low-risk --include A,B --exclude C
intelligence cycles list | cycles show ID
workspace daily list --workspace ID [--from DATE --to DATE] | daily show --workspace ID --date YYYY-MM-DD | changes --workspace ID --since DATE
dream rate ID --label useful|not_useful|duplicate|incorrect|needs_evidence --note T [--origin real-user|validated-evidence|synthetic|simulated-reviewer] | dream learning status [--as-of-version N] | dream learning reset --note T | dream run [--mode micro|deep|strategic] [--background] | dream feedback ID --outcome tested|validated|rejected|superseded --note T [--by user|experiment --evidence URI@REV] | dream status | dream list [--status S]
jobs status | index status|rebuild|sync|verify
query --json '{AST}' | --file F [--format table|json|jsonl|text] [--explain] | query save NAME --scope S --file F | query capabilities
cat ID | grep PATTERN --path ID | head|tail -n N | cut -c R | sed SCRIPT | trim | split -d D | replace A B | uniq | distinct | sort --by f:desc | select|pluck|count|sum|avg|min|max   (stream aliases read JSONL from stdin)
embed status | sync [--max-objects N] | clear     (optional semantic index; needs sqlite.enabled and embedding.* in mdb.yaml)
memory recent|timeline|range|search|grep|get   (secondary recall; use your host's native memory first)
memory adapter detect|install|status|uninstall --host claude-code|codex [--consent --principal P --workspace W]
  remote hooks: add --mcp-url https://HOST/mcp --token-env ENV --registration REG_ID
memory register --host claude-code|codex --principal ACTOR --workspace W --consent
memory revoke --registration REG_ID | memory drain-remote --token-env ENV
memory record --registration R --type note.created|decision|finding|task.completed --session S --text T | memory drain|sweep|status|capabilities | insight search QUERY | capabilities
skills list | show NAME | run NAME [--input JSON]
backup PATH | backup restore SOURCE DESTINATION

Examples:
  mdb init --root ./vault --no-sqlite
  mdb workspace create research --root ./vault
  mdb put --root ./vault --workspace research --kind note --title Example --body 'Authored note'
  mdb grep note --root ./vault --scope workspace:research --json
The CLI is a trusted local owner. MCP hosts must separately assign identity and grants.
No configured model means deterministic maintenance only. No implicit downloads or conversation scanning.
`;
type Flags = Record<string, string | boolean>;
function parse(argv: string[]): { args: string[]; flags: Flags } {
  const args: string[] = [], flags: Flags = {};
  const switches = new Set(['enable', 'disable', 'json', 'help', 'no-sqlite', 'postgres', 'project', 'file-sync-consent', 'hook', 'user', 'show', 'report', 'pause', 'resume', 'uninstall', 'no-probe', 'remote', 'regex', 'case-sensitive', 'allow-fallback', 'include-history', 'review', 'consent', 'dry-run', 'quiet', 'sensitive', 'confirm-sensitive', 'confirm-hypothesis', 'explain', 'meta', 'coerce', 'no-shared', 'allow-cursor-drift', 'stdin', 'first', 'all']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') { args.push(...argv.slice(i + 1)); break; }
    if (!token.startsWith('--')) { args.push(token); continue; }
    const [key, ...parts] = token.slice(2).split('=');
    if (parts.length) flags[key!] = parts.join('=');
    else if (switches.has(key!)) flags[key!] = true;
    else { const value = argv[++i]; if (!value || value.startsWith('--')) throw new MDBError('INVALID_ARGUMENT', `--${key} requires a value`); flags[key!] = value; }
  }
  return { args, flags };
}
function text(flags: Flags, name: string, fallback?: string): string | undefined { return typeof flags[name] === 'string' ? flags[name] as string : fallback; }
function required(value: string | undefined, name: string): string { if (!value) throw new MDBError('INVALID_ARGUMENT', `${name} is required`); return value; }
/** Provenance of a feedback label; the default (real-user) applies when the flag is absent. */
function origin(flags: Flags): 'real-user' | 'validated-evidence' | 'synthetic' | 'simulated-reviewer' { const value = text(flags, 'origin'); if (!['real-user', 'validated-evidence', 'synthetic', 'simulated-reviewer'].includes(value ?? '')) throw new MDBError('INVALID_ARGUMENT', '--origin must be real-user, validated-evidence, synthetic or simulated-reviewer'); return value as never; }
function number(flags: Flags, name: string): number | undefined { const value = text(flags, name); if (value === undefined) return undefined; const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new MDBError('INVALID_ARGUMENT', `--${name} must be a positive integer`); return n; }
const list = (flags: Flags, name: string): string[] | undefined => text(flags, name)?.split(',').map(s => s.trim()).filter(Boolean);
/** `mdb memory ...`: passive capture hook, spool draining, adapters, and on-demand recall. */
async function memoryCommand(client: Engram, root: string, sub: string | undefined, third: string | undefined, flags: Flags): Promise<unknown> {
  if (sub === 'capture') { // lifecycle hook: silent, fail-open, never touches the vault or a model
    try {
      const input = await readStdin();
      if (text(flags, 'project-root') && !(await insideProject(input, text(flags, 'project-root')!))) return ''; // a hook is installed once per machine but belongs to one project
      if (flags.user) { await captureForUser(required(text(flags, 'host'), '--host'), input); return ''; }
      if (text(flags, 'remote-url')) {
        const token = process.env[required(text(flags, 'token-env'), '--token-env')];
        await queueRemoteCapture({ url: required(text(flags, 'remote-url'), '--remote-url'), registrationId: required(text(flags, 'registration'), '--registration'), token, payload: JSON.parse(input) });
      } else await captureFromHook({ root, host: required(text(flags, 'host'), '--host'), registrationId: required(text(flags, 'registration'), '--registration') }, input);
    } catch { /* the host must never be affected */ }
    return '';
  }
  if (sub === 'context') { // SessionStart hook: prints host injection output only; silent and fail-open
    try { const result = await runContextHook({ host: required(text(flags, 'host'), '--host'), stdin: await readStdin(), ...(text(flags, 'project-root') ? { projectRoot: text(flags, 'project-root')! } : {}), ...(flags.user ? { user: true } : {}), ...(text(flags, 'root') ? { root: text(flags, 'root')! } : {}), ...(text(flags, 'format') ? { format: text(flags, 'format') as 'claude' | 'text' } : {}) }); return result.output; }
    catch { return ''; }
  }
  if (sub === 'drain') { const r = await drainSpool(root, { limit: number(flags, 'limit') }); return flags.quiet ? '' : r; }
  if (sub === 'record') return recordExplicit(root, required(text(flags, 'registration'), '--registration'), { type: required(text(flags, 'type'), '--type') as 'decision', sessionId: required(text(flags, 'session'), '--session'), text: required(text(flags, 'text'), '--text'), ...(text(flags, 'title') ? { title: text(flags, 'title')! } : {}), ...(text(flags, 'speaker') ? { speaker: text(flags, 'speaker') as 'user' } : {}) });
  if (sub === 'register') return createRegistration(client.vault, { host: required(text(flags, 'host'), '--host'), principalId: required(text(flags, 'principal'), '--principal'), workspaceId: required(text(flags, 'workspace'), '--workspace'), ...(text(flags, 'collection') ? { collectionId: text(flags, 'collection')! } : {}), ...(list(flags, 'capture') ? { capture: list(flags, 'capture') as MemoryEventType[] } : {}), ...(list(flags, 'exclude') ? { excludePatterns: list(flags, 'exclude')! } : {}), consent: flags.consent === true });
  if (sub === 'revoke') return revokeRegistration(root, required(text(flags, 'registration'), '--registration'));
  if (sub === 'drain-remote') { const token = process.env[required(text(flags, 'token-env'), '--token-env')]; if (!token) throw new MDBError('INVALID_ARGUMENT', 'Remote bearer token environment variable is empty'); return drainRemoteCaptureSpool({ token }); }
  if (sub === 'sweep') return sweepAbandoned(client.vault, { timeoutMs: (number(flags, 'timeout-minutes') ?? 60) * 60_000 });
  if (sub === 'status') return { registrations: (await listRegistrations(root)).map(r => ({ id: r.id, host: r.host, workspaceId: r.workspaceId, collectionId: r.collectionId ?? null, capture: r.capture, settingsPath: r.settingsPath ?? null })), spool: await spoolStats(root) };
  if (sub === 'capabilities') return client.capabilities();
  if (sub === 'adapter') {
    const host = required(text(flags, 'host'), '--host'); const adapter = createAdapter(host, { root, ...(text(flags, 'settings-path') ? { settingsPath: text(flags, 'settings-path')! } : {}) });
    const action = required(third, 'adapter action (detect|install|status|uninstall)');
    if (action === 'detect') return adapter.detect(); if (action === 'status') return adapter.status(); if (action === 'uninstall') return adapter.uninstall();
    if (action === 'install') return adapter.install({ consent: flags.consent === true, dryRun: flags['dry-run'] === true, principalId: required(text(flags, 'principal'), '--principal'), workspaceId: required(text(flags, 'workspace'), '--workspace'), ...(text(flags, 'collection') ? { collectionId: text(flags, 'collection')! } : {}), ...(list(flags, 'capture') ? { capture: list(flags, 'capture') as MemoryEventType[] } : {}), ...(list(flags, 'exclude') ? { excludePatterns: list(flags, 'exclude')! } : {}), ...(text(flags, 'mcp-url') ? { mcpUrl: text(flags, 'mcp-url')! } : {}), ...(text(flags, 'token-env') ? { tokenEnv: text(flags, 'token-env')! } : {}), ...(text(flags, 'registration') ? { registrationId: text(flags, 'registration')! } : {}) });
    throw new MDBError('INVALID_ARGUMENT', 'Unknown adapter action');
  }
  const request = (mode: MemorySearchRequest['mode'], query?: string): MemorySearchRequest => ({
    mode, ...(query ? { query } : {}), ...(text(flags, 'scope') ? { scope: text(flags, 'scope') as MemorySearchRequest['scope'] } : {}), ...(text(flags, 'workspace') ? { workspaceId: text(flags, 'workspace')! } : {}), ...(text(flags, 'collection') ? { collectionId: text(flags, 'collection')! } : {}),
    ...(text(flags, 'from') ?? text(flags, 'since') ? { from: (text(flags, 'from') ?? text(flags, 'since'))! } : {}), ...(text(flags, 'to') ?? text(flags, 'until') ? { to: (text(flags, 'to') ?? text(flags, 'until'))! } : {}), ...(list(flags, 'types') ? { types: list(flags, 'types')! } : {}),
    ...(text(flags, 'session') ? { sessionId: text(flags, 'session')! } : {}), ...(text(flags, 'around') ? { aroundId: text(flags, 'around')! } : {}), ...(number(flags, 'window') ? { window: number(flags, 'window')! } : {}), ...(number(flags, 'limit') ? { limit: number(flags, 'limit')! } : {}),
    ...(text(flags, 'cursor') ? { cursor: text(flags, 'cursor')! } : {}), ...(text(flags, 'detail') ? { detail: text(flags, 'detail') as MemorySearchRequest['detail'] } : {}), ...(number(flags, 'budget-tokens') ? { tokenBudget: number(flags, 'budget-tokens')! } : {})
  });
  if (sub === 'recent') return client.memory.recent(request('recent')); if (sub === 'timeline') return client.memory.timeline(request('timeline')); if (sub === 'range') return client.memory.timeRange(request('time_range'));
  if (sub === 'get') return client.memory.get(required(text(flags, 'ids'), '--ids').split(',').filter(Boolean), { ...(number(flags, 'budget-tokens') ? { tokenBudget: number(flags, 'budget-tokens')! } : {}) });
  if (sub === 'grep') return client.memory.query(request(flags.regex ? 'regex' : 'grep', required(third, 'query')));
  if (sub === 'search') return client.memory.query(request((text(flags, 'mode') ?? 'auto') as MemorySearchRequest['mode'], third));
  throw new MDBError('INVALID_ARGUMENT', 'Unknown memory command. Run mdb help.');
}
function parseScope(flags: Flags): Scope {
  const value = text(flags, 'scope');
  if (value) {
    const pieces = value.split(':');
    if (pieces[0] === 'workspace' && pieces[1] && pieces.length <= 3) return { type: 'workspace', workspaceId: pieces[1], ...(pieces[2] ? { collectionId: pieces[2] } : {}) };
    const area = pieces[0] === 'global' ? pieces[1] : pieces[0];
    if (['wiki', 'shared', 'discoveries', 'profile'].includes(area ?? '') && pieces.length <= 2) return { type: 'global', area: area as 'wiki' | 'shared' | 'discoveries' | 'profile' };
    throw new MDBError('INVALID_ARGUMENT', 'Scope must be workspace:ID[:COLLECTION] or global:AREA');
  }
  return { type: 'workspace', workspaceId: required(text(flags, 'workspace'), '--scope or --workspace'), ...(text(flags, 'collection') ? { collectionId: text(flags, 'collection')! } : {}) };
}
async function body(flags: Flags): Promise<string> { return text(flags, 'file') ? readFile(resolve(text(flags, 'file')!), 'utf8') : required(text(flags, 'body'), '--body or --file'); }
function jsonInput(flags: Flags): Record<string, unknown> { const value = JSON.parse(text(flags, 'input', '{}')!); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MDBError('INVALID_ARGUMENT', '--input must be a JSON object'); return value; }

function summarizeRun(r: { cycle?: { id: string; state: string; watermark: number; error?: { category: string; message: string }; workspaces: Record<string, { status: string; outcome?: string }>; global: { status: string }; dream: { status: string; proposals: unknown[] } }; ran: boolean; reason?: string }): unknown {
  const c = r.cycle; return { ran: r.ran, ...(r.reason ? { reason: r.reason } : {}), ...(c ? { cycle: c.id, state: c.state, watermark: c.watermark, workspaces: Object.fromEntries(Object.entries(c.workspaces).map(([k, w]) => [k, w.outcome ?? w.status])), global: c.global.status, dream: c.dream.status, dreams: c.dream.proposals.length, ...(c.error ? { error: `${c.error.category}: ${c.error.message}` } : {}) } : {}) };
}
/** Commands that never change the vault: they must not record activity either (a read leaves the vault byte-identical). */
const READ_ONLY_COMMANDS = new Set(['doctor', 'verify', 'get', 'history', 'diff', 'grep', 'search', 'context', 'links', 'backlinks', 'related', 'query', 'capabilities', 'insight']);
const READ_ONLY_SUBCOMMANDS: Record<string, string[]> = { workspace: ['list', 'info', 'daily', 'changes'], collection: ['list', 'info'], credential: ['audit'], profile: ['show', 'proposals'], jobs: ['status'], index: ['status', 'verify'], memory: ['recent', 'timeline', 'range', 'search', 'grep', 'get', 'status', 'capabilities', 'adapter'], embed: ['status'], skills: ['list', 'show'] };
export function isReadOnlyCommand(command: string | undefined, sub: string | undefined): boolean { if (!command) return true; if (command === 'query') return sub !== 'save'; if (command === 'memory' && sub === 'adapter') return true; return READ_ONLY_COMMANDS.has(command) || (READ_ONLY_SUBCOMMANDS[command]?.includes(sub ?? '') ?? false); }
export async function execute(argv: string[]): Promise<unknown> {
  const { args, flags } = parse(argv);
  const [command, sub, third, fourth] = args;
  if (!command || command === 'help' || flags.help) return HELP;
  const root = resolveRoot(text(flags, 'root'));
  const client = new Engram(root, OWNER, ['intelligence', 'dream', 'profile'].includes(command) ? await configuredProvider(root) : undefined);
  if (STREAM_COMMANDS.has(command)) return queryCommand(argv, client, root); // typed query AST and stream aliases (packages/cli/query.ts)
  if (command === 'grep' && (flags.path || flags.stdin)) return lineGrep(argv, client);
  const abort = new AbortController(); const interrupt = () => abort.abort(); process.once('SIGINT', interrupt);
  try {
  const v = client.vault, engine = client.intelligence;
  const id = () => required(sub, 'object ID');
  const revision = () => required(text(flags, 'revision'), '--revision');
  const search = () => ({ query: required(command === 'context' ? text(flags, 'task', sub) : sub, 'query'), mode: text(flags, 'mode', command === 'grep' ? 'grep' : 'auto') as 'grep' | 'keyword' | 'semantic' | 'hybrid' | 'auto', ...(flags.scope || flags.workspace ? { scopes: [parseScope(flags)] } : {}), regex: !!flags.regex, caseSensitive: !!flags['case-sensitive'], allowFallback: !!flags['allow-fallback'], includeHistory: !!flags['include-history'], limit: number(flags, 'limit'), cursor: text(flags, 'cursor'), kinds: text(flags, 'kinds')?.split(','), tags: text(flags, 'tags')?.split(',') });
  switch (command) {
    case 'init': {
      const mcpUrl = text(flags, 'mcp-url');
      const initialized = flags.project && mcpUrl ? { mode: 'remote-mcp' } : await v.init({ sqlite: !flags['no-sqlite'], ...(flags.postgres ? { postgres: true } : {}) });
      if (!flags.project) return initialized;
      const hostsFlag = text(flags, 'hosts'); const singleHost = text(flags, 'host');
      if (hostsFlag && singleHost) throw new MDBError('INVALID_ARGUMENT', 'use --host or --hosts, not both');
      const hostList = hostsFlag === 'auto' ? 'auto' as const : (hostsFlag ?? required(singleHost, '--host or --hosts')).split(',').map(item => item.trim()).filter(Boolean) as Host[];
      if (hostList !== 'auto') for (const item of hostList) if (item !== 'claude-code' && item !== 'codex') throw new MDBError('INVALID_ARGUMENT', '--host/--hosts must name claude-code and/or codex (or --hosts auto)');
      const setup = await initializeProject(mcpUrl ? undefined : client, { projectDir: resolve(text(flags, 'project-dir', process.cwd())!), hosts: hostList, ...(flags['file-sync-consent'] ? { fileSyncConsent: true } : {}), ...(list(flags, 'notes-include') ? { notesInclude: list(flags, 'notes-include')! } : {}), ...(text(flags, 'workspace') ? { workspaceId: text(flags, 'workspace')! } : {}), ...(text(flags, 'settings-path') ? { settingsPath: text(flags, 'settings-path')! } : {}), ...(text(flags, 'principal') ? { principalId: text(flags, 'principal')! } : {}), ...(mcpUrl ? { mcpUrl, tokenEnv: text(flags, 'token-env', 'ENGRAM_MCP_TOKEN')! } : {}), ...(text(flags, 'registration') ? { registrationId: text(flags, 'registration')! } : {}), ...(flags.consent ? { consent: true } : {}) });
      return { initialized, project: setup };
    }
    case 'notes': {
      if (sub !== 'sync') throw new MDBError('INVALID_ARGUMENT', 'usage: notes sync [--project-dir PATH] [--report] [--hook --project-root PATH]');
      const dir = resolve(text(flags, 'project-root') ?? text(flags, 'project-dir', process.cwd())!);
      const quiet = !!flags.hook; // a hook is silent and fail-open
      try {
        const binding = await readBinding(dir); if (flags.report) return syncReport(dir, binding);
        const input = quiet ? await readStdin() : ''; if (quiet && text(flags, 'project-root') && !(await insideProject(input, dir))) return '';
        const sink = binding.serverUrl ? remoteSink(binding) : localSink(new Engram(required(text(flags, 'root'), '--root (local mode)')), binding.workspaceId);
        const ctx = { projectDir: dir, binding, sink }; const paths = quiet ? pathsFromHookPayload(input) : undefined;
        if (paths) { const outcomes = []; for (const p of paths) outcomes.push(await syncFile(ctx, p)); return quiet ? '' : { outcomes }; }
        const result = await reconcile(ctx); return quiet ? '' : { ...result, report: await syncReport(dir, binding) };
      } catch (error) { if (quiet) return ''; throw error; }
    }
    case 'setup': {
      if (!flags.user) throw new MDBError('INVALID_ARGUMENT', 'usage: setup --user (--consent --hosts H --mcp-url URL --token-env NAME --registration REG --principal ACTOR [--workspace personal] [--exclude PATTERN,...]) | --show | --pause | --resume | --uninstall');
      if (flags.show) return userStatus();
      if (flags.pause) return setUserPaused(true);
      if (flags.resume) return setUserPaused(false);
      if (flags.uninstall) return uninstallUser();
      const hostList = required(text(flags, 'hosts'), '--hosts').split(',').map(item => item.trim()).filter(Boolean) as Host[];
      for (const item of hostList) if (item !== 'claude-code' && item !== 'codex') throw new MDBError('INVALID_ARGUMENT', '--hosts must name claude-code and/or codex');
      return setupUser({ hosts: hostList, mcpUrl: required(text(flags, 'mcp-url'), '--mcp-url'), tokenEnv: text(flags, 'token-env', 'ENGRAM_MCP_TOKEN')!, registrationId: required(text(flags, 'registration'), '--registration'), principalId: required(text(flags, 'principal'), '--principal'), ...(text(flags, 'workspace') ? { workspaceId: text(flags, 'workspace')! } : {}), ...(list(flags, 'exclude') ? { exclude: list(flags, 'exclude')! } : {}), consent: !!flags.consent });
    }
    case 'doctor': if (flags.project) return projectDoctor(resolve(text(flags, 'project-dir', process.cwd())!), { ...(flags['no-probe'] ? { probeRemote: false } : {}) }); return v.doctor();
    case 'project': {
      if (sub !== 'refresh-context') throw new MDBError('INVALID_ARGUMENT', 'usage: project refresh-context [--project-dir PATH]');
      return refreshContext(resolve(text(flags, 'project-dir', process.cwd())!), flags.remote ? {} : { client });
    }
    case 'verify': return v.verify();
    case 'recover': return v.recover();
    case 'reconcile': return v.reconcile();
    case 'workspace':
      if (sub === 'daily') { const a = client.adaptive; const ws = required(text(flags, 'workspace'), '--workspace'); if (third === 'show') return a.dailyShow(ws, required(text(flags, 'date'), '--date')); return a.dailyList(ws, { ...(text(flags, 'from') ? { from: text(flags, 'from')! } : {}), ...(text(flags, 'to') ? { to: text(flags, 'to')! } : {}) }); }
      if (sub === 'changes') return client.adaptive.changesSince(required(text(flags, 'workspace'), '--workspace'), required(text(flags, 'since'), '--since'));
      if (sub === 'create') return v.createWorkspace(required(third, 'workspace ID'), text(flags, 'description', ''));
      if (sub === 'list') return v.listWorkspaces();
      if (sub === 'info') return (await v.listWorkspaces()).find(w => w.id === required(third, 'workspace ID')) ?? null;
      if (sub === 'grant') { const permissions = required(text(flags, 'permissions'), '--permissions').split(','); if (permissions.some(p => !['read', 'write', 'promote'].includes(p))) throw new MDBError('INVALID_ARGUMENT', 'Invalid grant permission'); return v.grant(required(third, 'workspace ID'), required(fourth, 'actor ID'), permissions as ('read' | 'write' | 'promote')[]); }
      if (sub === 'revoke') return v.revoke(required(third, 'workspace ID'), required(fourth, 'actor ID'));
      break;
    case 'collection':
      if (sub === 'create') return v.createCollection(required(text(flags, 'workspace'), '--workspace'), required(third, 'collection ID'), text(flags, 'description', ''));
      if (sub === 'list') return v.listCollections(required(text(flags, 'workspace'), '--workspace'));
      if (sub === 'info') return (await v.listCollections(required(text(flags, 'workspace'), '--workspace'))).find(c => c.id === required(third, 'collection ID')) ?? null;
      break;
    case 'put': return v.put({ scope: parseScope(flags), kind: text(flags, 'kind', 'note')!, title: required(text(flags, 'title'), '--title'), body: await body(flags), tags: text(flags, 'tags')?.split(','), idempotencyKey: text(flags, 'idempotency-key') } satisfies PutInput);
    case 'get': return v.get(id(), text(flags, 'revision'));
    case 'patch': { const input: PatchInput = { objectId: id(), expectedRevisionId: revision() }; if (flags.body !== undefined || flags.file !== undefined) input.body = await body(flags); if (flags.title) input.title = text(flags, 'title'); if (flags.tags) input.tags = text(flags, 'tags')!.split(','); if (flags.status) input.status = text(flags, 'status'); return v.patch(input); }
    case 'delete': return v.delete(id(), revision());
    case 'history': return v.history(id());
    case 'diff': return v.diff(id(), required(third, 'from revision'), required(fourth, 'to revision'));
    case 'restore': return v.restore(id(), required(third, 'revision to restore'), revision());
    case 'ingest': return v.ingest(resolve(id()), parseScope(flags));
    case 'grep': case 'search': return await client.query(search());
    case 'context': return client.context({ ...search(), budgetTokens: number(flags, 'budget-tokens') });
    case 'links': return client.search.links(id());
    case 'backlinks': return client.search.backlinks(id());
    case 'related': return client.search.related(id(), number(flags, 'depth'));
    case 'promote': if (!flags.review) throw new MDBError('INVALID_ARGUMENT', '--review is required'); return v.promote(id(), { type: 'global', area: required(text(flags, 'to'), '--to') as 'shared' | 'wiki' | 'discoveries' }, await body(flags));
    case 'session':
      if (sub === 'start') return engine.sessionStart({ scope: parseScope(flags), source: text(flags, 'source') });
      if (sub === 'observe') return engine.observe({ sessionId: required(text(flags, 'session'), '--session'), body: await body(flags), source: text(flags, 'source') });
      if (sub === 'end') return engine.sessionEnd({ sessionId: required(text(flags, 'session'), '--session'), ...(flags.body || flags.file ? { body: await body(flags) } : {}) });
      break;
    case 'profile':
      if (sub === 'show') return (await v.listDocuments({ scopes: [{ type: 'global', area: 'profile' }] }));
      if (sub === 'propose') return engine.enqueue('profile', { ...jsonInput(flags), scope: parseScope(flags) });
      if (sub === 'approve' || sub === 'reject') return engine.review(required(third, 'proposal ID'), sub === 'approve', text(flags, 'reason'), { confirmSensitive: !!flags['confirm-sensitive'], confirmHypothesis: !!flags['confirm-hypothesis'] });
      if (sub === 'correct') return engine.correctInsight({ scope: flags.scope || flags.workspace ? parseScope(flags) : { type: 'global', area: 'profile' }, preferenceKey: required(text(flags, 'key'), '--key'), claim: required(text(flags, 'claim'), '--claim'), category: required(text(flags, 'category'), '--category') as InsightCategory, ...(text(flags, 'reason') ? { reason: text(flags, 'reason')! } : {}), ...(text(flags, 'source') ? { source: { uri: text(flags, 'source')!, revisionId: required(text(flags, 'revision'), '--revision'), ...(text(flags, 'span') ? { span: text(flags, 'span')! } : {}) } } : {}), ...(flags.sensitive ? { sensitive: true } : {}) });
      if (sub === 'project') return engine.projectProfile();
      if (sub === 'reconcile') return engine.reconcileProfile();
      if (sub === 'proposals') return engine.proposals();
      break;
    case 'intelligence':
      if (sub === 'run' && text(flags, 'snapshot')) {
        if (text(flags, 'snapshot') !== 'now') throw new MDBError('INVALID_ARGUMENT', '--snapshot must be now'); if ((text(flags, 'stage') ?? 'daily') !== 'daily') throw new MDBError('INVALID_ARGUMENT', '--stage must be daily');
        return summarizeRun(await client.adaptive.runCycle({ kind: 'manual', ...(text(flags, 'key') ? { idempotencyKey: text(flags, 'key')! } : {}), signal: abort.signal }));
      }
      if (sub === 'schedule') {
        const a = client.adaptive; const action = third ?? 'status';
        if (action === 'status') return a.status();
        if (action === 'pause') return a.pause(); if (action === 'resume') return a.resume();
        if (action === 'events') return a.events(number(flags, 'limit') ?? 50);
        if (action === 'worker') { const summary = await a.worker({ intervalMs: (number(flags, 'interval-s') ?? 300) * 1000, signal: abort.signal, ...(number(flags, 'max-ticks') ? { maxTicks: number(flags, 'max-ticks')! } : {}), onTick: t => process.stderr.write(`${JSON.stringify(t)}\n`) }); return summary; }
        if (action === 'service') { if (fourth !== 'launchd' && fourth !== 'systemd') throw new MDBError('INVALID_ARGUMENT', 'schedule service needs launchd or systemd'); const kind = fourth; const def = a.serviceDefinition(kind, { node: process.execPath, script: process.argv[1] ?? 'mdb', root, intervalSeconds: number(flags, 'interval-s') ?? 300, ...(text(flags, 'label') ? { label: text(flags, 'label')! } : {}), ...(text(flags, 'log') ? { logPath: resolve(text(flags, 'log')!) } : {}) }); return { note: 'Printed only; nothing was installed or started.', filename: def.filename, install: def.install, content: def.content }; }
        if (action === 'tick') { const r = await a.tick(undefined, { signal: abort.signal }); return { decision: r.decision, ...(r.run ? summarizeRun(r.run) as object : {}) }; }
        if (action === 'configure') {
          const patch: Record<string, unknown> = {}; if (flags.enable) patch.enabled = true; if (flags.disable) patch.enabled = false;
          if (text(flags, 'timezone')) patch.timezone = text(flags, 'timezone'); if (text(flags, 'time')) patch.targetLocalTime = text(flags, 'time'); if (text(flags, 'quiet-start')) patch.quietStart = text(flags, 'quiet-start'); if (text(flags, 'quiet-end')) patch.quietEnd = text(flags, 'quiet-end');
          if (text(flags, 'micro')) { const m = text(flags, 'micro'); if (m !== 'on' && m !== 'off') throw new MDBError('INVALID_ARGUMENT', '--micro must be on or off'); patch.micro = { ...(await a.store.config()).micro, enabled: m === 'on', ...(number(flags, 'micro-debounce-minutes') ? { debounceMinutes: number(flags, 'micro-debounce-minutes')! } : {}), ...(number(flags, 'micro-max-per-day') ? { maxPerDay: number(flags, 'micro-max-per-day')! } : {}) }; }
          if (text(flags, 'mode')) patch.mode = text(flags, 'mode'); if (text(flags, 'auto-accept')) patch.autoAccept = text(flags, 'auto-accept'); if (text(flags, 'inactivity-minutes')) patch.inactivityMinutes = Number(text(flags, 'inactivity-minutes'));
          if (list(flags, 'include')) patch.workspaces = { include: list(flags, 'include')!, exclude: list(flags, 'exclude') ?? [] }; else if (list(flags, 'exclude')) patch.workspaces = { include: (await a.store.config()).workspaces.include, exclude: list(flags, 'exclude')! };
          return a.configure(patch as never);
        }
        throw new MDBError('INVALID_ARGUMENT', 'schedule action must be status, configure, pause, resume, tick, worker, service or events');
      }
      if (sub === 'cycles') { const a = client.adaptive; if (third === 'show') { const found = await a.cycle(required(fourth, 'cycle ID')); if (!found) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Cycle not found'); return found; } return (await a.cycles()).map(c => ({ id: c.id, kind: c.kind, localDate: c.localDate, state: c.state, watermark: c.watermark, workspaces: Object.keys(c.workspaces).length, dream: c.dream.status, updatedAt: c.updatedAt, ...(c.error ? { error: `${c.error.category}: ${c.error.message}` } : {}) })); }
      if (sub === 'run') return engine.run({ job: text(flags, 'job') as JobKind | undefined, limit: number(flags, 'limit'), signal: abort.signal }); if (sub === 'proposals') return engine.proposals(); break;
    case 'dream':
      if (sub === 'run') { await engine.enqueue('dream', { mode: (text(flags, 'mode') ?? 'micro') as DreamMode, ...(flags.background ? { background: true } : {}), ...(flags.scope || flags.workspace ? { scope: parseScope(flags) } : {}) }); return engine.run({ job: 'dream', limit: number(flags, 'limit'), signal: abort.signal }); }
      if (sub === 'feedback') return recordFeedback(client.vault, required(third, 'discovery ID'), { outcome: required(text(flags, 'outcome'), '--outcome') as DiscoveryOutcome, note: required(text(flags, 'note'), '--note'), ...(text(flags, 'by') ? { validatedBy: text(flags, 'by') as 'user' | 'experiment' } : {}), ...(list(flags, 'evidence') ? { evidence: list(flags, 'evidence')!.map(item => { const [uri, revisionId] = item.split('@'); return { uri: required(uri, 'evidence uri'), revisionId: required(revisionId, 'evidence revision') }; }) } : {}), ...(list(flags, 'reused-by') ? { reusedBy: list(flags, 'reused-by')! } : {}), ...(text(flags, 'origin') ? { origin: origin(flags) } : {}) });
      if (sub === 'rate') { const r = await rateDiscovery(client.vault, required(third, 'discovery ID'), { label: required(text(flags, 'label'), '--label') as RankingLabel, note: required(text(flags, 'note'), '--note'), ...(text(flags, 'origin') ? { origin: origin(flags) } : {}) }); await client.adaptive.store.appendEvent({ type: 'feedback_applied', label: required(text(flags, 'label'), '--label'), family: familyOf(r.document) }); return { id: r.document.id, revisionId: r.document.revisionId, feedbackVersion: r.version }; }
      if (sub === 'learning') { if (third === 'reset') return { resetAtVersion: await resetLearning(client.vault, required(text(flags, 'note'), '--note')) }; if (!third || third === 'status') return learnedParams(client.vault, ...(number(flags, 'as-of-version') ? [{ asOfVersion: number(flags, 'as-of-version')! }] : [])); throw new MDBError('INVALID_ARGUMENT', 'dream learning status|reset'); }
      if (sub === 'status') return { stats: await readStats(client.vault), stale: await staleDiscoveries(client.vault), jobs: (await engine.jobs()).filter(j => j.kind === 'dream').map(j => ({ id: j.id, status: j.status, mode: j.input.mode ?? 'micro', error: j.error, trace: j.trace })) };
      if (sub === 'list') { const docs = (await client.listDocuments()).filter(d => d.kind === 'discovery' && (!text(flags, 'status') || d.status === text(flags, 'status'))); return docs.map(d => ({ id: d.id, title: d.title, status: d.status, mode: d.metadata.mode, subtype: d.metadata.subtype, novelty: d.metadata.novelty, critic: d.metadata.critic })); }
      break;
    case 'memory': return memoryCommand(client, root, sub, third, flags);
    case 'insight': if (sub === 'search') return client.memory.insights({ ...(third ?? text(flags, 'query') ? { query: third ?? text(flags, 'query')! } : {}), ...(text(flags, 'category') ? { category: text(flags, 'category')! } : {}), ...(text(flags, 'status') ? { status: text(flags, 'status')! } : {}), ...(text(flags, 'evidence-class') ? { evidenceClass: text(flags, 'evidence-class')! } : {}), ...(number(flags, 'limit') ? { limit: number(flags, 'limit')! } : {}) }); break;
    case 'capabilities': return client.capabilities();
    case 'credential':
      if (sub === 'create') return createHttpCredential(v, required(text(flags, 'actor'), '--actor'), required(text(flags, 'permissions'), '--permissions').split(',').map(value => value.trim()).filter(Boolean));
      if (sub === 'rotate') return rotateHttpCredential(v, required(third, 'credential ID'), text(flags, 'permissions')?.split(',').map(value => value.trim()).filter(Boolean));
      if (sub === 'revoke') return { revoked: await revokeHttpCredential(v, required(third, 'credential ID')) };
      if (sub === 'audit') return credentialAudit(v);
      break;
    case 'jobs': if (sub === 'status') return engine.jobs(); break;
    case 'embed': // optional semantic index: lives in the SQLite index, needs an embedding provider; keyword and grep never depend on it
      if (!sub || sub === 'status') return client.search.vectors.status();
      if (sub === 'sync') return client.search.embedSync({ signal: abort.signal, ...(number(flags, 'max-objects') ? { maxObjects: number(flags, 'max-objects')! } : {}) });
      if (sub === 'clear') return client.search.embedClear();
      break;
    case 'index':
      if (sub === 'status') return client.search.health();
      if (sub === 'rebuild') { await client.search.rebuild(flags.scope || flags.workspace ? parseScope(flags) : undefined); return { rebuilt: true }; }
      if (sub === 'sync') return client.search.sync();
      if (sub === 'verify') return v.verify();
      break;
    case 'skills':
      if (sub === 'list') return client.skills();
      if (sub === 'show') return client.skill(required(third, 'skill name'));
      if (sub === 'run') return client.runSkill(required(third, 'skill name'), jsonInput(flags));
      break;
    case 'backup': if (sub === 'restore') { const restored = await Vault.restoreBackup(required(third, 'source'), required(fourth, 'destination')); return { root: restored.root }; } return v.backup(resolve(id()));
  }
  throw new MDBError('INVALID_ARGUMENT', 'Unknown command. Run mdb help.');
  } finally { process.removeListener('SIGINT', interrupt); if (!['init', 'help', 'intelligence'].includes(command) && !isReadOnlyCommand(command, sub)) await touchActivity(root); }
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const unix = detectUnix(argv); if (unix) { process.exitCode = await unixMain(unix.command, unix.rest, unix.root); process.stdin.destroy(); return; } // Unix-style text tools: own option parsing and exit codes (docs/unix.md)
  const json = argv.includes('--json');
  try { const result = await execute(argv); if (result === STREAMED) return; process.stdout.write(typeof result === 'string' && !json ? result : `${JSON.stringify(result ?? null, null, json ? undefined : 2)}\n`); }
  catch (error) { const code = error instanceof MDBError ? error.code : error instanceof SyntaxError ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR'; const message = (error as Error).message; process.stderr.write(json ? `${JSON.stringify({ error: { code, message } })}\n` : `${code}: ${message}\n`); process.exitCode = 1; }
}
