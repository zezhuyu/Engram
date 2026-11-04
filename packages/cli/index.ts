import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { queryCommand, lineGrep, STREAM_COMMANDS, STREAMED } from './query.js';
import { detectUnix, unixMain } from './unix.js';
import { resolve } from 'node:path';
import { initializeProject, refreshContext, type Host } from '../project-init.js';
import { projectDoctor } from '../memory/project-doctor.js';
import { runContextHook } from '../memory/context-hook.js';
import { trustEngramCodexHooks } from '../memory/codex-trust.js';
import { recordHandoffState, runHandoffHook } from '../memory/handoff-hook.js';
import { localSink, pathsFromHookPayload, reconcile, remoteSink, syncFile, syncReport } from '../memory/file-sync.js';
import { readBinding } from '../core/project-binding.js';
import { isTrusted } from '../core/project-trust.js';
import { captureForUser, insideProject, setUserPaused, setupUser, uninstallUser, userStatus } from '../memory/user-setup.js';
import { touchActivity } from '../adaptive/activity.js';
import { mapCommand, remoteTarget, runRemote, usesServer } from './remote.js';
import { findTrustedBinding } from '../core/project-trust.js';
import { manageClientService, runClientDaemon } from './service.js';
import { createHttpCredential, credentialAudit, revokeHttpCredential, rotateHttpCredential } from '../mcp/credentials.js';
import { createRegistration, revokeRegistration } from '../memory/capture.js';
import { drainRemoteCaptureSpool, queueRemoteCapture } from '../memory/remote-spool.js';
import type { JobKind } from '../intelligence/index.js';
import { Engram, Vault, MDBError, OWNER, resolveRoot, createAdapter, captureFromHook, readStdin, recordExplicit, drainSpool, sweepAbandoned, spoolStats, listRegistrations, type MemorySearchRequest, type MemoryEventType, type InsightCategory, recordFeedback, rateDiscovery, resetLearning, learnedParams, familyOf, type RankingLabel, staleDiscoveries, readStats, type DiscoveryOutcome, type DreamMode, createProviderFromConfig, refreshRelevance, readRanking, clearRanking, relevanceStatus, showModel, setModel, testModel, isBuiltinProvider, effectiveProvider, type ModelProvider, type Scope, type PutInput, type PatchInput, CHAT_PROVIDERS, importChatEvents, parseGenericJson, parseChatGptExport, parseChatGptZip, parseClaudeExport, parseClaudeZip, parseGeminiTakeoutActivity, parseGeminiTakeoutZip, parseGenericJsonl } from '../sdk/index.js';

/** Builds the vault-configured built-in provider (openai, ollama, openai-compatible). Returns undefined, with a stderr note, when unavailable. */
async function configuredProvider(root: string): Promise<ModelProvider | undefined> {
  let config; try { config = await new Vault(root).config(); } catch { return undefined; }
  if (!isBuiltinProvider(effectiveProvider(config.model))) return undefined;
  try { return createProviderFromConfig(config.model); }
  catch (error) { if (error instanceof MDBError && ['CAPABILITY_UNAVAILABLE'].includes(error.code)) { process.stderr.write(`model provider unavailable: ${error.message}\n`); return undefined; } throw error; }
}

const HELP = `mdb — Markdown-native agent knowledge database
Usage: mdb COMMAND [arguments] [--root PATH] [--json]

mcp-proxy --url URL --token-env VAR [--workspace ID] [--outbox DIR] [--transport-trust tailscale]   stdio proxy for an agent host; keeps task/note/handoff writes locally while the server is unreachable and sends them when it returns
remote mode: any client runs these against the server instead of a local vault when --server URL [--token-env VAR] [--workspace ID] is given, ENGRAM_URL is set, or the current project is bound to a server (--root or --local forces a local vault)
service install|uninstall|status|start|stop|logs [--platform macos|linux] [--url URL --token-file F] [--workspace ID] [--project-dir D] [--dry-run]   manage the per-user outbox delivery daemon
    search | grep | context | get | history | put | patch | workspace list|create | collection list | memory recent|timeline|search|get | chat account|project|import|list|get|search | insight search | capabilities
chat account register|revoke|list --provider chatgpt|claude|gemini|generic --account ID [--label LABEL]
chat client register --provider P --account A --principal ACTOR --consent   owner-consented Engram-controlled two-way chat capture
chat project create|link --provider P --account A --project ID --workspace W [--name N] | remap|unlink --expected-version N | list|resolve
chat import preview|run|resume --provider P --account A --file PATH --format generic-json|generic-jsonl|chatgpt-json|chatgpt-zip|claude-json|claude-zip|gemini-takeout-json|gemini-takeout-zip [--batch ID --membership standalone|member|unknown]
chat import status --batch ID | list [filters] | get --conversation ID [filters] | search --query TEXT [filters]
    task upsert --id ID --title T --status S [--body B] [--expected-revision R | --as-of TIME]    note upsert --id ID --title T (--body B | --file F)    handoff write --session ID --state ended|interrupted [--completed a,b --next ... --blockers ... --files ... --open-tasks ...]
    remote tools | remote call TOOL --input JSON      (every server tool; task/note/handoff writes made while the server is unreachable are kept in the local outbox and merged in later)
outbox [drain --url URL --token-env VAR [--workspace ID] | watch --url URL (--token-env VAR | --token-file F) [--workspace ID] [--project-dir D] [--interval-sec N] [--exit-when-empty-sec N] | watch-unit --url URL --token-file F [--platform macos|linux] | log [--limit N]]   what is waiting on this machine (queued, conflicts, rejected); drain sends it now; log is the timestamped record
dashboard [--host ADDR] [--port N] [--open] [--allow-remote] [--client] [--reset-password] | credential create|list|revoke  password dashboard; remote admin is opt-in with MDB_DASHBOARD_REMOTE_ADMIN=true
storage status | breakdown | cleanup --dry-run   report logical storage paths/usage and preview only positively marked orphan scratch (nothing is deleted)
wiki lint [--scope S ...] [--check CODE ...] [--min-severity error|warning|info] [--limit N] [--propose [--dry-run]]   deterministic ACL-safe wiki lint and pending proposal generation
wiki propose retire --page ID --revision REV --reason TEXT | restore --page ID --to-revision REV --revision CURRENT --reason TEXT | rename --page ID --revision REV --title NEW | merge --target ID --revision REV --source ID:REV ... --title T (--body T | --file F) --evidence URI:REV[:SPAN] ... --reason TEXT
wiki proposals [--status pending|approved|rejected]   list visible reviewed wiki changes; trusted host reviews with intelligence approve|reject
model show | test | set (--local-agent [claude|codex|auto] | --api URL [--model NAME] [--api-key-env VAR] [--allow-network]) [--allow-private-to-remote] [--no-check]
    one vault-wide model switch for profile/insight collection, dream and project insight relevance; keys come from the environment only

init [--no-sqlite] [--postgres] Initialize a vault (Markdown is canonical)
init --project --host claude-code|codex [--no-local-mcp] [--project-dir PATH] [--settings-path PATH] [--mcp-url URL --token-env NAME]
                               [--registration REG_ID --principal ACTOR --consent]
                               Initialize project memory, host capture, and AGENTS.md/CLAUDE.md
                               [--hosts claude-code,codex|auto instead of --host] [--workspace ID] [--no-profile-in-files] [--trust-codex-hooks] [--approve-engram-tools]: writes .engram/project.json (gitignored), managed blocks, MCP config
setup --user --consent --hosts H --mcp-url URL --token-env NAME --registration REG --principal ACTOR [--workspace personal] [--exclude PATTERN,...] [--include PATTERN,...]
                               One-time user-level capture for EVERY project (also --show --pause --resume --uninstall)
notes sync [--project-dir PATH] [--report]          Synchronize approved Markdown files (needs init --file-sync-consent)
project trust-codex-hooks [--yes] [--project-dir PATH]   Codex runs project hooks only once trusted: show, then (with --yes) trust, this project's Engram hooks
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
  remote offline buffer: with --mcp-url add --offline-buffer so task/note/handoff writes made while the server is unreachable are kept on this machine, then merged into the server's version (like git) and deleted locally when it returns
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
  const switches = new Set(['local', 'enable', 'disable', 'json', 'help', 'no-sqlite', 'postgres', 'project', 'file-sync-consent', 'offline-buffer', 'no-local-mcp', 'no-profile-in-files', 'trust-codex-hooks', 'approve-engram-tools', 'yes', 'hook', 'user', 'show', 'report', 'pause', 'resume', 'uninstall', 'no-probe', 'remote', 'allow-remote', 'regex', 'case-sensitive', 'allow-fallback', 'include-history', 'review', 'consent', 'dry-run', 'allow-root', 'propose', 'quiet', 'sensitive', 'confirm-sensitive', 'confirm-hypothesis', 'explain', 'meta', 'coerce', 'no-shared', 'allow-cursor-drift', 'stdin', 'first', 'all', 'open', 'client', 'reset-password']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') { args.push(...argv.slice(i + 1)); break; }
    if (!token.startsWith('--')) { args.push(token); continue; }
    const [key, ...parts] = token.slice(2).split('=');
    if (parts.length) {
      const value = parts.join('=');
      flags[key!] = ['scope', 'check', 'source', 'evidence'].includes(key!) && typeof flags[key!] === 'string' ? `${flags[key!] as string},${value}` : value;
    }
    else if (switches.has(key!)) flags[key!] = true;
    else { const value = argv[++i]; if (!value || value.startsWith('--')) throw new MDBError('INVALID_ARGUMENT', `--${key} requires a value`); flags[key!] = ['scope', 'check', 'source', 'evidence'].includes(key!) && typeof flags[key!] === 'string' ? `${flags[key!] as string},${value}` : value; }
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
  if (sub === 'handoff-check') { // Stop hook: asks the agent (once) to write the handoff; silent otherwise
    try { const result = await runHandoffHook({ host: required(text(flags, 'host'), '--host'), stdin: await readStdin(), ...(text(flags, 'project-root') ? { projectRoot: text(flags, 'project-root')! } : {}), ...(text(flags, 'root') ? { root: text(flags, 'root')! } : {}) }); if (result.outcome !== 'skipped' || !/outside this project/.test(result.reason)) await recordHandoffState(text(flags, 'host')!, result); return result.output; }
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
    if (action === 'install') { const projectRoot = text(flags, 'project-root'); const installed = await adapter.install({ ...(projectRoot ? { projectRoot: resolve(projectRoot) } : {}), consent: flags.consent === true, dryRun: flags['dry-run'] === true, principalId: required(text(flags, 'principal'), '--principal'), workspaceId: required(text(flags, 'workspace'), '--workspace'), ...(text(flags, 'collection') ? { collectionId: text(flags, 'collection')! } : {}), ...(list(flags, 'capture') ? { capture: list(flags, 'capture') as MemoryEventType[] } : {}), ...(list(flags, 'exclude') ? { excludePatterns: list(flags, 'exclude')! } : {}), ...(text(flags, 'mcp-url') ? { mcpUrl: text(flags, 'mcp-url')! } : {}), ...(text(flags, 'token-env') ? { tokenEnv: text(flags, 'token-env')! } : {}), ...(text(flags, 'registration') ? { registrationId: text(flags, 'registration')! } : {}) }); return projectRoot ? installed : { ...installed, warnings: ['These hooks live in the host\'s user-level settings file and fire for EVERY project on this machine, not only this workspace\'s project. Add --project-root PATH to limit them to one project, or use `mdb init --project`, which does that for you.'] }; }
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

async function chatFileEvents(file: string, format: string) {
  const info = await stat(file);
  if (!info.isFile()) throw new MDBError('INVALID_INPUT', '--file must be a regular file');
  const limit = format === 'chatgpt-zip' || format === 'claude-zip' || format === 'gemini-takeout-zip' ? 256 * 1024 * 1024 : 64 * 1024 * 1024;
  if (info.size > limit) throw new MDBError('INVALID_INPUT', `Chat export exceeds the ${limit} byte CLI limit`);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  const sourceSha256 = digest.digest('hex');
  if (format === 'generic-jsonl') return { sourceSha256, events: parseGenericJsonl(createReadStream(file)) };
  const bytes = await readFile(file);
  const content = bytes.toString('utf8');
  const parsers: Record<string, () => ReturnType<typeof parseGenericJson>> = {
    'generic-json': () => parseGenericJson(content),
    'chatgpt-json': () => parseChatGptExport(content),
    'chatgpt-zip': () => parseChatGptZip(bytes),
    'claude-json': () => parseClaudeExport(content),
    'claude-zip': () => parseClaudeZip(bytes),
    'gemini-takeout-json': () => parseGeminiTakeoutActivity(content),
    'gemini-takeout-zip': () => parseGeminiTakeoutZip(bytes),
  };
  const parser = parsers[format];
  if (!parser) throw new MDBError('INVALID_ARGUMENT', 'Unsupported --format; use generic-jsonl, generic-json, chatgpt-json|zip, claude-json|zip, or gemini-takeout-json|zip');
  return { sourceSha256, events: parser() };
}

async function chatCommand(client: Engram, sub: string | undefined, action: string | undefined, flags: Flags): Promise<unknown> {
  const registry = client.chatProjects;
  if (sub === 'account') {
    if (action === 'list') return registry.listSourceAccounts();
    const provider = required(text(flags, 'provider'), '--provider') as typeof CHAT_PROVIDERS[number];
    if (!(CHAT_PROVIDERS as readonly string[]).includes(provider)) throw new MDBError('INVALID_ARGUMENT', 'Unsupported provider');
    const account = required(text(flags, 'account'), '--account');
    if (action === 'register') return registry.registerSourceAccount({ provider, sourceAccountId: account, ...(text(flags, 'label') ? { label: text(flags, 'label')! } : {}) });
    if (action === 'revoke') return registry.revokeSourceAccount(provider, account);
    throw new MDBError('INVALID_ARGUMENT', 'usage: chat account register|revoke|list --provider P --account ID');
  }
  if (sub === 'client') {
    if (action !== 'register') throw new MDBError('INVALID_ARGUMENT', 'usage: chat client register --provider P --account A --principal ACTOR --consent');
    const provider = required(text(flags, 'provider'), '--provider') as typeof CHAT_PROVIDERS[number];
    if (!(CHAT_PROVIDERS as readonly string[]).includes(provider)) throw new MDBError('INVALID_ARGUMENT', 'Unsupported provider');
    return createRegistration(client.vault, {
      host: 'engram-chat-client', principalId: required(text(flags, 'principal'), '--principal'), workspaceId: 'personal',
      consent: flags.consent === true, chatSource: { provider, sourceAccountId: required(text(flags, 'account'), '--account') },
      capture: ['user.message', 'assistant.message']
    });
  }
  if (sub === 'project') {
    if (action === 'list') return registry.listProjects();
    const provider = required(text(flags, 'provider'), '--provider') as typeof CHAT_PROVIDERS[number];
    if (!(CHAT_PROVIDERS as readonly string[]).includes(provider)) throw new MDBError('INVALID_ARGUMENT', 'Unsupported provider');
    const sourceAccountId = required(text(flags, 'account'), '--account');
    const externalProjectId = text(flags, 'project');
    if (action !== 'resolve' && !externalProjectId) throw new MDBError('INVALID_ARGUMENT', '--project is required');
    if (action === 'create') return registry.createWorkspaceAndLink({ provider, sourceAccountId, externalProjectId: externalProjectId!, projectName: text(flags, 'name', externalProjectId)!, workspaceId: required(text(flags, 'workspace'), '--workspace'), ...(text(flags, 'description') ? { description: text(flags, 'description')! } : {}) });
    if (action === 'link') return registry.linkProject({ provider, sourceAccountId, externalProjectId: externalProjectId!, projectName: text(flags, 'name'), workspaceId: required(text(flags, 'workspace'), '--workspace') });
    if (action === 'remap') return registry.remapProject({ provider, sourceAccountId, externalProjectId: externalProjectId!, workspaceId: required(text(flags, 'workspace'), '--workspace'), expectedVersion: number(flags, 'expected-version')! });
    if (action === 'unlink') return registry.unlinkProject({ provider, sourceAccountId, externalProjectId: externalProjectId!, expectedVersion: number(flags, 'expected-version')! });
    if (action === 'resolve') {
      const membership = required(text(flags, 'membership'), '--membership') as 'member' | 'standalone' | 'unknown';
      return registry.resolveProject({ provider, sourceAccountId, ...(externalProjectId ? { externalProjectId } : {}), membership });
    }
    throw new MDBError('INVALID_ARGUMENT', 'usage: chat project create|link|remap|unlink|list|resolve');
  }
  if (sub === 'import') {
    if (action === 'status') {
      const batchId = required(text(flags, 'batch'), '--batch');
      const personal = await client.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] });
      const record = personal.find(doc => doc.kind === 'chat_import_run' && doc.metadata.batchId === batchId);
      return record ? { ...JSON.parse(record.body) as Record<string, unknown>, warnings: personal.filter(doc => doc.kind === 'chat_import_warning' && doc.metadata.batchId === batchId).map(doc => JSON.parse(doc.body) as unknown) } : null;
    }
    if (!['preview', 'run', 'resume'].includes(action ?? '')) throw new MDBError('INVALID_ARGUMENT', 'usage: chat import preview|run|resume|status');
    const provider = required(text(flags, 'provider'), '--provider') as typeof CHAT_PROVIDERS[number];
    if (!(CHAT_PROVIDERS as readonly string[]).includes(provider)) throw new MDBError('INVALID_ARGUMENT', 'Unsupported provider');
    const sourceAccountId = required(text(flags, 'account'), '--account');
    const file = resolve(required(text(flags, 'file'), '--file'));
    const format = required(text(flags, 'format'), '--format');
    const batchId = action === 'resume'
      ? required(text(flags, 'batch'), '--batch (resume requires the original batch ID)')
      : required(text(flags, 'batch', `chat-${Date.now().toString(36)}`), '--batch');
    const parsed = await chatFileEvents(file, format);
    let startOffset = action === 'resume' ? number(flags, 'offset') : undefined;
    if (action === 'resume' && startOffset === undefined) {
      const docs = await client.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] });
      const saved = docs.find(doc => doc.kind === 'chat_import_run' && doc.metadata.batchId === batchId);
      if (!saved) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Import checkpoint not found');
      startOffset = Number((JSON.parse(saved.body) as { nextOffset?: number }).nextOffset);
    }
    const membership = text(flags, 'membership', 'unknown')! as 'member' | 'standalone' | 'unknown';
    if (!['member', 'standalone', 'unknown'].includes(membership)) throw new MDBError('INVALID_ARGUMENT', '--membership must be member, standalone or unknown');
    return importChatEvents(client.vault, registry, parsed.events, { provider, sourceAccountId, batchId, sourceSha256: parsed.sourceSha256, ...(startOffset !== undefined ? { startOffset } : {}), ...(number(flags, 'max-records') ? { maxRecords: number(flags, 'max-records')! } : {}), preview: action === 'preview', membershipForProject: projectId => projectId ? 'member' : membership });
  }
  const scopes = text(flags, 'workspace') ? [{ type: 'workspace' as const, workspaceId: text(flags, 'workspace')! }] : undefined;
  const provider = text(flags, 'provider'), sourceAccountId = text(flags, 'account'), externalProjectId = text(flags, 'project'), role = text(flags, 'role');
  const includeNonUser = flags['include-non-user'] === true || flags['include-non-user'] === 'true';
  if (sub === 'list') return client.chatConversations.list({ ...(scopes ? { scopes } : {}), ...(provider ? { provider } : {}), ...(sourceAccountId ? { sourceAccountId } : {}), ...(externalProjectId ? { externalProjectId } : {}), ...(role ? { role } : {}), ...(text(flags, 'since') ? { since: text(flags, 'since')! } : {}), ...(text(flags, 'until') ? { until: text(flags, 'until')! } : {}), ...(includeNonUser ? { includeNonUser } : {}), ...(number(flags, 'limit') ? { limit: number(flags, 'limit')! } : {}), ...(text(flags, 'cursor') ? { cursor: text(flags, 'cursor')! } : {}) });
  if (sub === 'get') return client.chatConversations.get({ externalConversationId: required(text(flags, 'conversation'), '--conversation'), ...(scopes ? { scopes } : {}), ...(provider ? { provider } : {}), ...(sourceAccountId ? { sourceAccountId } : {}), ...(includeNonUser ? { includeNonUser } : {}), ...(text(flags, 'cursor') ? { cursor: text(flags, 'cursor')! } : {}), ...(number(flags, 'max-messages') ? { maxMessages: number(flags, 'max-messages')! } : {}) });
  if (sub === 'search') return client.chatConversations.search({ query: required(text(flags, 'query'), '--query'), mode: text(flags, 'mode') as 'keyword' | 'grep' | undefined, ...(scopes ? { scopes } : {}), ...(provider ? { provider } : {}), ...(sourceAccountId ? { sourceAccountId } : {}), ...(externalProjectId ? { externalProjectId } : {}), ...(role ? { role } : {}), ...(text(flags, 'since') ? { since: text(flags, 'since')! } : {}), ...(text(flags, 'until') ? { until: text(flags, 'until')! } : {}), ...(includeNonUser ? { includeNonUser } : {}), ...(number(flags, 'limit') ? { limit: number(flags, 'limit')! } : {}), ...(text(flags, 'cursor') ? { cursor: text(flags, 'cursor')! } : {}), ...(text(flags, 'source-cursor') ? { sourceCursor: text(flags, 'source-cursor')! } : {}) });
  throw new MDBError('INVALID_ARGUMENT', 'usage: chat account|project|import|list|get|search');
}

function summarizeRun(r: { cycle?: { id: string; state: string; watermark: number; error?: { category: string; message: string }; workspaces: Record<string, { status: string; outcome?: string }>; global: { status: string }; dream: { status: string; proposals: unknown[] } }; ran: boolean; reason?: string }): unknown {
  const c = r.cycle; return { ran: r.ran, ...(r.reason ? { reason: r.reason } : {}), ...(c ? { cycle: c.id, state: c.state, watermark: c.watermark, workspaces: Object.fromEntries(Object.entries(c.workspaces).map(([k, w]) => [k, w.outcome ?? w.status])), global: c.global.status, dream: c.dream.status, dreams: c.dream.proposals.length, ...(c.error ? { error: `${c.error.category}: ${c.error.message}` } : {}) } : {}) };
}
/** Commands that never change the vault: they must not record activity either (a read leaves the vault byte-identical). */
const READ_ONLY_COMMANDS = new Set(['doctor', 'verify', 'get', 'history', 'diff', 'grep', 'search', 'context', 'links', 'backlinks', 'related', 'query', 'capabilities', 'insight', 'storage', 'dashboard']);
const READ_ONLY_SUBCOMMANDS: Record<string, string[]> = { model: ['show', 'test'], wiki: ['lint', 'proposals'], intelligence: ['proposals'], workspace: ['list', 'info', 'daily', 'changes'], collection: ['list', 'info'], credential: ['audit'], profile: ['show', 'proposals'], jobs: ['status'], index: ['status', 'verify'], memory: ['recent', 'timeline', 'range', 'search', 'grep', 'get', 'status', 'capabilities', 'adapter'], embed: ['status'], skills: ['list', 'show'] };
export function isReadOnlyCommand(command: string | undefined, sub: string | undefined, third?: string): boolean { if (!command) return true; if (command === 'query') return sub !== 'save'; if (command === 'memory' && sub === 'adapter') return true; if (command === 'chat') return ['list', 'get', 'search'].includes(sub ?? '') || (sub === 'project' && ['list', 'resolve'].includes(third ?? '')) || (sub === 'account' && third === 'list') || (sub === 'import' && ['preview', 'status'].includes(third ?? '')); return READ_ONLY_COMMANDS.has(command) || (READ_ONLY_SUBCOMMANDS[command]?.includes(sub ?? '') ?? false); }
export async function execute(argv: string[]): Promise<unknown> {
  const { args, flags } = parse(argv);
  const [command, sub, third, fourth] = args;
  if (!command || command === 'help' || flags.help) return HELP;
  if (command === 'service') {
    if (sub === 'daemon') return runClientDaemon({ url: required(text(flags, 'url'), '--url'), tokenFile: resolve(required(text(flags, 'token-file'), '--token-file')), allowRoot: !!flags['allow-root'], ...(text(flags, 'log-file') ? { logFile: resolve(text(flags, 'log-file')!) } : {}), ...(text(flags, 'workspace') ? { workspace: text(flags, 'workspace') } : {}), ...(text(flags, 'outbox') ? { outbox: resolve(text(flags, 'outbox')!) } : {}), ...(text(flags, 'project-dir') ? { projectDir: resolve(text(flags, 'project-dir')!) } : {}) });
    return manageClientService({ action: sub ?? '', ...(text(flags, 'platform') ? { platform: text(flags, 'platform') as 'macos' | 'linux' } : {}), ...(text(flags, 'home') ? { home: text(flags, 'home') } : {}), ...(text(flags, 'url') ? { url: text(flags, 'url') } : {}), ...(text(flags, 'token-file') ? { tokenFile: text(flags, 'token-file') } : {}), ...(text(flags, 'workspace') ? { workspace: text(flags, 'workspace') } : {}), ...(text(flags, 'outbox') ? { outbox: text(flags, 'outbox') } : {}), ...(text(flags, 'project-dir') ? { projectDir: text(flags, 'project-dir') } : {}), dryRun: !!flags['dry-run'], allowRoot: !!flags['allow-root'] });
  }
  if (command === 'mcp-proxy') {
    if (text(flags, 'transport-trust')) process.env.MDB_TRANSPORT_TRUST = text(flags, 'transport-trust')!; // stdio proxy for an agent host: forwards to the server and keeps task/note/handoff writes in a local outbox while it is unreachable
    const tokenEnv = required(text(flags, 'token-env'), '--token-env'), token = process.env[tokenEnv];
    if (!token) throw new MDBError('INVALID_ARGUMENT', `Environment variable ${tokenEnv} is not set`);
    const { runMcpProxy } = await import('../memory/mcp-proxy.js');
    await runMcpProxy({ url: required(text(flags, 'url'), '--url'), token, ...(text(flags, 'workspace') ? { workspaceId: text(flags, 'workspace')! } : {}), ...(text(flags, 'outbox') ? { outbox: resolve(text(flags, 'outbox')!) } : {}), input: process.stdin, output: process.stdout, log: line => process.stderr.write(`engram-proxy: ${line}\n`) });
    return STREAMED; // stdout is the protocol channel: never print a result into it
  }
  if (command === 'outbox') { // writes kept on this machine while the server was unreachable: status (default), `drain` to send them now, `log` for the timestamped record
    const { outboxStatus, defaultOutboxDirectory, readLog } = await import('../memory/outbox.js'); const directory = text(flags, 'outbox') ? resolve(text(flags, 'outbox')!) : defaultOutboxDirectory();
    if (sub === 'log') return readLog(directory, number(flags, 'limit') ?? 50);
    if (sub === 'watch' || sub === 'watch-unit') { // keeps retrying by itself so delivery does not wait for the next agent session; `watch-unit` only PRINTS a launchd/systemd definition (nothing is installed)
      if (process.env.ENGRAM_AUTO_RECONNECT === '0') throw new MDBError('CAPABILITY_UNAVAILABLE', 'Outbox watch is disabled by ENGRAM_AUTO_RECONNECT=0');
      const url = required(text(flags, 'url'), '--url'); const tokenFile = text(flags, 'token-file') ? resolve(text(flags, 'token-file')!) : undefined;
      if (sub === 'watch-unit') { const { watcherServiceText } = await import('../memory/outbox-watch.js'); return watcherServiceText(text(flags, 'platform') === 'linux' ? 'linux' : 'macos', { node: process.execPath, mdb: process.argv[1] ?? 'mdb', url, tokenFile: required(tokenFile ? text(flags, 'token-file') : undefined, '--token-file'), ...(text(flags, 'workspace') ? { workspaceId: text(flags, 'workspace')! } : {}), ...(text(flags, 'outbox') ? { outbox: directory } : {}), ...(text(flags, 'project-dir') ? { projectDir: resolve(text(flags, 'project-dir')!) } : {}) }); }
      let token: string | undefined;
      if (tokenFile) { const info = await stat(tokenFile).catch(() => undefined); if (!info?.isFile()) throw new MDBError('INVALID_ARGUMENT', `Token file ${tokenFile} does not exist`); if ((info.mode & 0o077) !== 0) throw new MDBError('INVALID_ARGUMENT', `Token file ${tokenFile} must not be readable by others (chmod 600)`); token = (await readFile(tokenFile, 'utf8')).trim(); }
      else { const tokenEnv = required(text(flags, 'token-env'), '--token-env or --token-file'); token = process.env[tokenEnv]; if (!token) throw new MDBError('INVALID_ARGUMENT', `Environment variable ${tokenEnv} is not set`); }
      const projectDir = text(flags, 'project-dir') ? resolve(text(flags, 'project-dir')!) : undefined; const { watchOutbox } = await import('../memory/outbox-watch.js');
      const syncProject = projectDir ? async () => { const binding = await readBinding(projectDir); if (!binding.serverUrl || !(await isTrusted(projectDir, binding))) return; await reconcile({ projectDir, binding, sink: remoteSink(binding) }); } : undefined;
      const abort = new AbortController(); for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort());
      await watchOutbox({ url, token, ...(text(flags, 'workspace') ? { workspaceId: text(flags, 'workspace')! } : {}), outbox: directory, intervalMs: (number(flags, 'interval-sec') ?? 10) * 1000, ...(number(flags, 'exit-when-empty-sec') !== undefined ? { exitWhenEmptyMs: number(flags, 'exit-when-empty-sec')! * 1000 } : {}), ...(projectDir && syncProject ? { projectDir, syncProject } : {}), signal: abort.signal, onEvent: event => process.stderr.write(`engram-outbox-watch: ${JSON.stringify(event)}\n`) });
      process.exit(0); // a service command: leave when asked, even if an idle keep-alive connection is still open
    }
    if (sub === 'drain') {
      const tokenEnv = required(text(flags, 'token-env'), '--token-env'), token = process.env[tokenEnv]; if (!token) throw new MDBError('INVALID_ARGUMENT', `Environment variable ${tokenEnv} is not set`);
      const url = required(text(flags, 'url'), '--url'); const { drainOutboxNow } = await import('../memory/mcp-proxy.js');
      const drained = await drainOutboxNow({ url, token, ...(text(flags, 'workspace') ? { workspaceId: text(flags, 'workspace')! } : {}), outbox: directory }); return { ...(await outboxStatus(directory, entry => entry.url === url)), drain: { ...(drained ?? {}), ...(drained?.stopped === 'auth' ? { note: 'The server refused the credential: nothing was lost, every queued write is kept. Set the new token in the environment variable and drain again.' } : drained?.stopped ? { note: 'The server did not answer: every queued write is kept.' } : {}) } };
    }
    return outboxStatus(directory);
  }
  // Remote mode: a client machine runs the same commands against the server (see cli/remote.ts). --root or --local keeps a command on a local vault.
  if (usesServer(command, sub)) { const target = await remoteTarget(flags); if (target) return runRemote(target, args, flags); }
  const root = resolveRoot(text(flags, 'root'));
  const client = new Engram(root, OWNER, (['intelligence', 'dream', 'profile'].includes(command) || (command === 'model' && sub === 'test') || (command === 'project' && sub === 'relevance' && third === 'refresh')) ? await configuredProvider(root) : undefined);
  if (STREAM_COMMANDS.has(command)) return queryCommand(argv, client, root); // typed query AST and stream aliases (packages/cli/query.ts)
  if (command === 'grep' && (flags.path || flags.stdin)) return lineGrep(argv, client);
  const abort = new AbortController(); const interrupt = () => abort.abort(); process.once('SIGINT', interrupt);
  try {
  const v = client.vault, engine = client.intelligence;
  const id = () => required(sub, 'object ID');
  const revision = () => required(text(flags, 'revision'), '--revision');
  const search = () => ({ query: required(command === 'context' ? text(flags, 'task', sub) : sub, 'query'), mode: text(flags, 'mode', command === 'grep' ? 'grep' : 'auto') as 'grep' | 'keyword' | 'semantic' | 'hybrid' | 'auto', ...(flags.scope || flags.workspace ? { scopes: [parseScope(flags)] } : {}), regex: !!flags.regex, caseSensitive: !!flags['case-sensitive'], allowFallback: !!flags['allow-fallback'], includeHistory: !!flags['include-history'], limit: number(flags, 'limit'), cursor: text(flags, 'cursor'), kinds: text(flags, 'kinds')?.split(','), tags: text(flags, 'tags')?.split(',') });
  switch (command) {
    case 'dashboard': {
      const { dashboardEnabled } = await import('../dashboard/server.js');
      if (sub === 'credential') {
        const { createDashboardCredential, listDashboardCredentials, revokeDashboardCredential } = await import('../dashboard/credentials.js');
        if (third === 'list') return listDashboardCredentials(root);
        if (third === 'create') {
          const label = required(text(flags, 'label'), '--label'), mode = text(flags, 'mode', 'admin');
          if (mode !== 'admin' && mode !== 'view') throw new MDBError('INVALID_ARGUMENT', '--mode must be admin or view');
          const expires = text(flags, 'expires-days'); const days = expires === undefined ? 90 : Number(expires);
          if (!Number.isInteger(days) || days < 1 || days > 366) throw new MDBError('INVALID_ARGUMENT', '--expires-days must be between 1 and 366');
          return createDashboardCredential(root, { label, mode, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(), ...(text(flags, 'source-ips') ? { sourceIps: text(flags, 'source-ips')!.split(',').map(item => item.trim()).filter(Boolean) } : {}) });
        }
        if (third === 'revoke') return { revoked: await revokeDashboardCredential(root, required(text(flags, 'id'), '--id')) };
        throw new MDBError('INVALID_ARGUMENT', 'usage: mdb dashboard credential create --label NAME [--mode admin|view] | list | revoke --id ID');
      }
      if (flags['reset-password']) {
        const { resetPassword } = await import('../dashboard/password.js');
        const removed = await resetPassword(root);
        return removed ? 'Dashboard password removed. The next dashboard start requires the one-time token URL to set a new password.\n' : 'No dashboard password was set.\n';
      }
      let enabled: boolean;
      try { enabled = dashboardEnabled(); } catch (error) { throw new MDBError('INVALID_ARGUMENT', (error as Error).message); }
      if (!enabled) throw new MDBError('INVALID_ARGUMENT', 'Dashboard disabled by MDB_DASHBOARD_ENABLED=false');
      const portValue = text(flags, 'port') ?? process.env.MDB_DASHBOARD_PORT ?? '0';
      const port = Number(portValue);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new MDBError('INVALID_ARGUMENT', '--port must be between 0 and 65535');
      const { createDashboardServer } = await import('../dashboard/server.js');
      const idleMinutes = Number(process.env.MDB_DASHBOARD_IDLE_MINUTES ?? '0');
      if (!Number.isFinite(idleMinutes) || idleMinutes < 0) throw new MDBError('INVALID_ARGUMENT', 'MDB_DASHBOARD_IDLE_MINUTES must be a positive number of minutes when set.');
      const testIdleMs = process.env.NODE_ENV === 'test' && /^\d+$/.test(process.env.MDB_DASHBOARD_TEST_IDLE_MS ?? '')
        ? Number(process.env.MDB_DASHBOARD_TEST_IDLE_MS) : undefined;
      const requestedHost = text(flags, 'host') ?? (flags['allow-remote'] ? '0.0.0.0' : process.env.MDB_DASHBOARD_HOST ?? '127.0.0.1');
      let dashboard;
      const idleMs = idleMinutes > 0 ? idleMinutes * 60_000 : testIdleMs && testIdleMs >= 1 && testIdleMs <= 60_000 ? testIdleMs : undefined;
      try { dashboard = await createDashboardServer({ engram: client, host: requestedHost, port, clientMode: !!flags.client, ...(idleMs ? { idleMs } : {}) }); }
      catch (error) { throw new MDBError('INVALID_ARGUMENT', (error as Error).message); }
      const { passwordFilePath, passwordIsSet } = await import('../dashboard/password.js');
      process.stderr.write(`Dashboard password file: ${await passwordFilePath(root)}\n`);
      process.stderr.write(`Dashboard password: ${await passwordIsSet(root) ? 'set' : 'not set; use the printed one-time URL for first setup'}\n`);
      const remote = dashboard.host !== '127.0.0.1' && dashboard.host !== '::1';
      const scheme = process.env.MDB_DASHBOARD_TLS_CERT && process.env.MDB_DASHBOARD_TLS_KEY ? 'https' : 'http';
      const urlFor = (ip: string) => `${scheme}://${ip.includes(':') ? `[${ip}]` : ip}:${dashboard.port}/#t=${dashboard.token}`;
      const urls = dashboard.host === '0.0.0.0' || dashboard.host === '::'
        ? [...(await import('../dashboard/server.js')).dashboardIPv4Addresses().map(urlFor), urlFor('127.0.0.1')]
        : [urlFor(dashboard.host)];
      const url = urls[0]!;
      if (remote && scheme === 'http') process.stderr.write('WARNING: Remote dashboard uses plain HTTP on the network. Anyone who can reach this port and has the token gets owner-level settings access. Prefer a trusted LAN or VPN. Keep the token private.\n');
      if (flags.open) {
        const { spawn } = await import('node:child_process');
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        spawn(opener, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
      }
      return `${urls.join('\n')}\n`;
    }
    case 'init': {
      const mcpUrl = text(flags, 'mcp-url');
      const initialized = flags.project && mcpUrl ? { mode: 'remote-mcp' } : await v.init({ sqlite: !flags['no-sqlite'], ...(flags.postgres ? { postgres: true } : {}) });
      if (!flags.project) return initialized;
      const hostsFlag = text(flags, 'hosts'); const singleHost = text(flags, 'host');
      if (hostsFlag && singleHost) throw new MDBError('INVALID_ARGUMENT', 'use --host or --hosts, not both');
      const hostList = hostsFlag === 'auto' ? 'auto' as const : (hostsFlag ?? required(singleHost, '--host or --hosts')).split(',').map(item => item.trim()).filter(Boolean) as Host[];
      if (hostList !== 'auto') for (const item of hostList) if (item !== 'claude-code' && item !== 'codex') throw new MDBError('INVALID_ARGUMENT', '--host/--hosts must name claude-code and/or codex (or --hosts auto)');
      const setup = await initializeProject(mcpUrl ? undefined : client, { projectDir: resolve(text(flags, 'project-dir', process.cwd())!), hosts: hostList, ...(flags['offline-buffer'] ? { offlineBuffer: true } : {}), ...(flags['no-local-mcp'] ? { noLocalMcp: true } : {}), ...(flags['file-sync-consent'] ? { fileSyncConsent: true } : {}), ...(flags['no-profile-in-files'] ? { profileInFiles: false } : {}), ...(flags['trust-codex-hooks'] ? { trustCodexHooks: true } : {}), ...(flags['approve-engram-tools'] ? { approveEngramTools: true } : {}), ...(list(flags, 'notes-include') ? { notesInclude: list(flags, 'notes-include')! } : {}), ...(text(flags, 'workspace') ? { workspaceId: text(flags, 'workspace')! } : {}), ...(text(flags, 'settings-path') ? { settingsPath: text(flags, 'settings-path')! } : {}), ...(text(flags, 'principal') ? { principalId: text(flags, 'principal')! } : {}), ...(mcpUrl ? { mcpUrl, tokenEnv: text(flags, 'token-env', 'ENGRAM_MCP_TOKEN')! } : {}), ...(text(flags, 'registration') ? { registrationId: text(flags, 'registration')! } : {}), ...(flags.consent ? { consent: true } : {}) });
      return { initialized, project: setup };
    }
    case 'notes': {
      if (sub !== 'sync') throw new MDBError('INVALID_ARGUMENT', 'usage: notes sync [--project-dir PATH] [--report] [--hook --project-root PATH]');
      const dir = resolve(text(flags, 'project-root') ?? text(flags, 'project-dir', process.cwd())!);
      const quiet = !!flags.hook; // a hook is silent and fail-open
      try {
        const binding = await readBinding(dir); if (flags.report) return syncReport(dir, binding);
        if (!(await isTrusted(dir, binding))) { if (quiet) return ''; throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'This project binding is not trusted on this machine; run `mdb init --project` here first'); }
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
      return setupUser({ hosts: hostList, mcpUrl: required(text(flags, 'mcp-url'), '--mcp-url'), tokenEnv: text(flags, 'token-env', 'ENGRAM_MCP_TOKEN')!, registrationId: required(text(flags, 'registration'), '--registration'), principalId: required(text(flags, 'principal'), '--principal'), ...(text(flags, 'workspace') ? { workspaceId: text(flags, 'workspace')! } : {}), ...(list(flags, 'exclude') ? { exclude: list(flags, 'exclude')! } : {}), ...(list(flags, 'include') ? { include: list(flags, 'include')! } : {}), consent: !!flags.consent });
    }
    case 'doctor': if (flags.project) return projectDoctor(resolve(text(flags, 'project-dir', process.cwd())!), { ...(flags['no-probe'] ? { probeRemote: false } : {}) }); return v.doctor();
    case 'project': {
      if (sub === 'trust-codex-hooks') { const dir = resolve(text(flags, 'project-dir', process.cwd())!); const result = await trustEngramCodexHooks(dir, { confirm: !!flags.yes }); return flags.yes ? result : { ...result, note: 'Nothing was changed. These are the exact hook commands Codex would then run in this project; rerun with --yes to record trust for them (only these) in your Codex config.' }; }
      if (sub === 'relevance') {
        const workspaceId = required(text(flags, 'workspace'), '--workspace');
        if (third === 'refresh') return refreshRelevance(client, workspaceId, await configuredProvider(root), await v.config());
        if (third === 'clear') return clearRanking(client, workspaceId);
        if (third === 'show' || !third) return { workspaceId, status: await relevanceStatus(client, workspaceId), ranking: (await readRanking(client, workspaceId)) ?? null };
        throw new MDBError('INVALID_ARGUMENT', 'usage: project relevance refresh|show|clear --workspace ID');
      }
      if (sub !== 'refresh-context') throw new MDBError('INVALID_ARGUMENT', 'usage: project refresh-context | relevance refresh|show|clear | trust-codex-hooks [--yes] [--project-dir PATH]');
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
    // Await here so a rejected chat operation settles before the shared activity
    // cleanup runs; returning the promise lets a rejection become temporarily
    // unhandled while the async finally block is still pending.
    case 'chat': return await chatCommand(client, sub, third, flags);
    case 'model': {
      if (!sub || sub === 'show') return showModel(await v.config());
      if (sub === 'test') return testModel(await configuredProvider(root), await v.config());
      if (sub !== 'set') throw new MDBError('INVALID_INPUT', 'Usage: mdb model show | set | test');
      const bool = (name: string): boolean | undefined => flags[name] === undefined ? undefined : flags[name] === true || flags[name] === 'true';
      const localAgent = flags['local-agent'] === undefined ? undefined : flags['local-agent'] === true ? 'auto' : String(flags['local-agent']);
      return setModel(v, { provider: text(flags, 'provider'), localAgent: localAgent as 'claude' | 'codex' | 'auto' | undefined, api: text(flags, 'api'), modelName: text(flags, 'model'), baseUrl: text(flags, 'base-url'), apiKeyEnv: text(flags, 'api-key-env'), command: text(flags, 'command'), allowNetwork: bool('allow-network'), allowPrivateContentToRemote: bool('allow-private-to-remote'), redactPiiForLocal: bool('redact-pii-for-local'), timeoutMs: number(flags, 'timeout-ms'), maxOutputTokens: number(flags, 'max-output-tokens'), maxInputTokens: number(flags, 'max-input-tokens'), locality: text(flags, 'locality') as 'local' | 'remote' | undefined, check: flags['no-check'] ? false : true });
    }
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
      if (sub === 'approve' || sub === 'reject') return engine.review(required(third, 'proposal ID'), sub === 'approve', text(flags, 'reason'));
      if (sub === 'proposals') return engine.proposals().then(proposals => proposals.filter(p => !text(flags, 'status') || p.status === text(flags, 'status')));
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
    case 'task': case 'note': case 'handoff': { // typed work records on a local vault (the built-in server's tools, no network); with a server target they were handled above
      if (!usesServer(command, sub)) throw new MDBError('INVALID_ARGUMENT', `usage: ${command} ${command === 'handoff' ? 'write' : 'upsert'} ...`);
      const mapped = await mapCommand(command, args, flags); if (mapped === 'list') break;
      const server = await import('../mcp/index.js').catch(() => undefined); if (!server) throw new MDBError('CAPABILITY_UNAVAILABLE', 'This installation has no built-in server: pass --server URL to use a remote one');
      const bound = await findTrustedBinding(process.cwd()).catch(() => undefined); const workspace = text(flags, 'workspace') ?? (bound?.trusted && !bound.binding.serverUrl ? bound.binding.workspaceId : undefined);
      const tool = server.withDefaultWorkspace(server.toolsFor(client), workspace).find(t => t.name === mapped.tool); if (!tool) throw new MDBError('NOT_FOUND', `No tool ${mapped.tool}`);
      return tool.execute(mapped.input);
    }
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
    case 'wiki':
      if (sub === 'proposals') return (await engine.proposals()).filter(p => p.input.kind === 'wiki_change' && (!text(flags, 'status') || p.status === text(flags, 'status')));
      if (sub === 'propose') {
        const action = third; if (!['retire', 'restore', 'rename', 'merge'].includes(action ?? '')) throw new MDBError('INVALID_ARGUMENT', 'wiki propose requires retire, restore, rename, or merge');
        const splitRef = (value: string, label: string) => { const match = /^(.*):(rev_[A-Za-z0-9_-]+)(?::(.*))?$/.exec(value); if (!match?.[1]) throw new MDBError('INVALID_ARGUMENT', `${label} must be URI:REVISION[:SPAN]`); return { uri: match[1], revisionId: match[2]!, ...(match[3] ? { span: match[3] } : {}) }; };
        return engine.proposeWikiChange({ action: action as 'retire'|'restore'|'rename'|'merge', targetPageId: required(text(flags, action === 'merge' ? 'target' : 'page'), action === 'merge' ? '--target' : '--page'), targetRevisionId: required(text(flags, 'revision'), '--revision'), reason: text(flags, 'reason') ?? '', ...(action === 'restore' ? { restoreRevisionId: required(text(flags, 'to-revision'), '--to-revision') } : {}), ...(action === 'rename' ? { newTitle: required(text(flags, 'title'), '--title') } : {}), ...(action === 'merge' ? { mergeSources: (list(flags, 'source') ?? []).map(value => { const [pageId, revisionId, ...extra] = value.split(':'); if (!pageId || !revisionId || extra.length) throw new MDBError('INVALID_ARGUMENT', '--source must be ID:REVISION'); return { pageId, revisionId }; }), title: required(text(flags, 'title'), '--title'), body: await body(flags), evidence: (list(flags, 'evidence') ?? []).map(value => splitRef(value, '--evidence')) } : {}) });
      }
      if (sub === 'lint') {
        const scopes = text(flags, 'scope')?.split(',').filter(Boolean).map(value => {
          const scopeFlags: Flags = { scope: value }; return parseScope(scopeFlags);
        });
        const checks = text(flags, 'check')?.split(',').filter(Boolean);
        const lintOptions = { ...(scopes ? { scopes } : {}), ...(checks ? { checks: checks as never } : {}), ...(text(flags, 'min-severity') ? { minSeverity: text(flags, 'min-severity') as never } : {}), ...(number(flags, 'limit') !== undefined ? { limit: number(flags, 'limit')! } : {}) };
        return flags.propose ? engine.proposeFromLint({ issues: (await client.wikiLint(lintOptions)).issues, dryRun: flags['dry-run'] === true, limit: number(flags, 'proposal-limit') }) : client.wikiLint(lintOptions);
      }
      break;
    case 'storage': {
      const { storageStatus, cleanupPreview } = await import('../core/storage-lifecycle.js');
      if (sub === 'status' || !sub) return storageStatus();
      if (sub === 'breakdown') return storageStatus();
      if (sub === 'cleanup') {
        if (!flags['dry-run']) throw new MDBError('INVALID_ARGUMENT', 'storage cleanup is report-only; pass --dry-run to preview eligible orphan markers');
        const preview = await cleanupPreview(); const status = await storageStatus();
        return { ...preview, pressure: status.pressure };
      }
      throw new MDBError('INVALID_ARGUMENT', 'usage: mdb storage status|breakdown|cleanup --dry-run');
    }
    case 'skills':
      if (sub === 'list') return client.skills();
      if (sub === 'show') return client.skill(required(third, 'skill name'));
      if (sub === 'run') return client.runSkill(required(third, 'skill name'), jsonInput(flags));
      break;
    case 'backup': if (sub === 'restore') { const restored = await Vault.restoreBackup(required(third, 'source'), required(fourth, 'destination')); return { root: restored.root }; } return v.backup(resolve(id()));
  }
  throw new MDBError('INVALID_ARGUMENT', 'Unknown command. Run mdb help.');
  } finally { process.removeListener('SIGINT', interrupt); if (!['init', 'help', 'intelligence'].includes(command) && !isReadOnlyCommand(command, sub, third)) await touchActivity(root); }
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const unix = detectUnix(argv); if (unix) { process.exitCode = await unixMain(unix.command, unix.rest, unix.root); process.stdin.destroy(); return; } // Unix-style text tools: own option parsing and exit codes (docs/unix.md)
  const json = argv.includes('--json');
  try { const result = await execute(argv); if (result === STREAMED) return; process.stdout.write(typeof result === 'string' && !json ? result : `${JSON.stringify(result ?? null, null, json ? undefined : 2)}\n`); }
  catch (error) { const code = error instanceof MDBError ? error.code : error instanceof SyntaxError ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR'; const message = (error as Error).message; process.stderr.write(json ? `${JSON.stringify({ error: { code, message } })}\n` : `${code}: ${message}\n`); process.exitCode = 1; }
}
