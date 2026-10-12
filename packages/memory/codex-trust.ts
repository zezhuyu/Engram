import { spawn } from 'node:child_process';
import path from 'node:path';
import { contextHookCommand, contextHookId, fileSyncHookCommand, handoffHookCommand } from './adapters.js';
import { findExecutable } from '../models/cli.js';
import { MDBError } from '../core/types.js';

/**
 * Codex runs a hook only after it is trusted (a per-hook sha256 recorded in the Codex user config), so hooks that `mdb init` writes into a project's `.codex/hooks.json` do nothing until the
 * user trusts them. This module asks Codex itself (its app-server `hooks/list`) what it thinks of the project's hooks, and, only when the user explicitly asks, records trust through Codex's own
 * config API. It trusts a hook only if its command line is exactly one this installation would write for this project, never one that merely carries an Engram marker.
 */
export interface CodexHook { key: string; eventName: string; command: string; trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified'; currentHash: string; sourcePath: string; source: string }
type Rpc = (method: string, params: unknown) => Promise<{ result?: any; error?: { message?: string } }>;
async function withCodex<T>(timeoutMs: number, work: (call: Rpc) => Promise<T>): Promise<T> {
  const binary = findExecutable('codex'); if (!binary) throw new MDBError('CAPABILITY_UNAVAILABLE', 'The codex executable was not found on PATH');
  const child = spawn(binary, ['app-server'], { env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = ''; const waiting = new Map<number, (m: any) => void>(); let id = 1;
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { buffer += chunk; let index: number; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); try { const m = JSON.parse(line); if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); } } catch { /* not a protocol line */ } } });
  const call: Rpc = (method, params) => new Promise((resolve, reject) => { const mine = id++; const timer = setTimeout(() => reject(new Error(`Codex did not answer ${method} in ${timeoutMs} ms`)), timeoutMs); waiting.set(mine, m => { clearTimeout(timer); resolve(m); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`); });
  try { await call('initialize', { clientInfo: { name: 'engram', title: null, version: '1' }, capabilities: null }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`); return await work(call); }
  finally { child.kill('SIGTERM'); }
}
export async function listCodexHooks(projectDir: string, timeoutMs = 8000): Promise<CodexHook[]> {
  return withCodex(timeoutMs, async call => { const reply = await call('hooks/list', { cwds: [path.resolve(projectDir)] }); if (reply.error) throw new Error(reply.error.message ?? 'hooks/list failed'); return (reply.result?.data?.[0]?.hooks ?? []) as CodexHook[]; });
}
/** The three command lines `mdb init` writes into a Codex project (context, handoff, file sync). Local-mode `--root` variants are accepted by prefix and suffix checks. */
export function isEngramCommandFor(projectDir: string, command: string): boolean {
  const id = contextHookId({ projectRoot: projectDir }, 'local'); const root = path.resolve(projectDir);
  const exact = [contextHookCommand('codex', id, { projectRoot: root }), handoffHookCommand('codex', id, { projectRoot: root }), fileSyncHookCommand(id, { projectRoot: root })];
  if (exact.includes(command)) return true;
  // local-vault installs add `--root "<vault>"` before `--project-root`; accept only that one inserted option
  return exact.some(candidate => { const at = candidate.indexOf(' --project-root '); return at > 0 && command.startsWith(candidate.slice(0, at)) && / --root "[^"]+"$/.test(command.slice(0, command.indexOf(' --project-root '))) && command.endsWith(candidate.slice(at)); });
}
export async function codexHookState(projectDir: string, timeoutMs = 8000): Promise<{ engram: CodexHook[]; untrusted: CodexHook[]; other: number }> {
  const hooks = await listCodexHooks(projectDir, timeoutMs); const mine = hooks.filter(h => h.source === 'project' && isEngramCommandFor(projectDir, h.command));
  return { engram: mine, untrusted: mine.filter(h => h.trustStatus === 'untrusted' || h.trustStatus === 'modified'), other: hooks.length - mine.length };
}
/** Records trust for this project's Engram hooks through Codex's own config API. Does nothing unless `confirm` is true. Never touches any other hook. */
export async function trustEngramCodexHooks(projectDir: string, options: { confirm: boolean; timeoutMs?: number }): Promise<{ trusted: string[]; alreadyTrusted: string[]; wouldTrust: Array<{ key: string; command: string }>; ignored: Array<{ key: string; reason: string }> }> {
  return withCodex(options.timeoutMs ?? 10000, async call => {
    const reply = await call('hooks/list', { cwds: [path.resolve(projectDir)] }); if (reply.error) throw new Error(reply.error.message ?? 'hooks/list failed');
    const hooks = (reply.result?.data?.[0]?.hooks ?? []) as CodexHook[]; const trusted: string[] = [], alreadyTrusted: string[] = [], wouldTrust: Array<{ key: string; command: string }> = [], ignored: Array<{ key: string; reason: string }> = [];
    for (const hook of hooks) {
      if (!isEngramCommandFor(projectDir, hook.command)) { if (/engram-mdb-/.test(hook.command)) ignored.push({ key: hook.key, reason: 'carries an Engram marker but is not a command this installation writes for this project' }); continue; }
      if (hook.source !== 'project') { ignored.push({ key: hook.key, reason: `not a project hook (source ${hook.source})` }); continue; }
      if (hook.trustStatus === 'trusted' || hook.trustStatus === 'managed') { alreadyTrusted.push(hook.key); continue; }
      wouldTrust.push({ key: hook.key, command: hook.command });
      if (!options.confirm) continue;
      const write = await call('config/batchWrite', { edits: [{ keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, mergeStrategy: 'upsert', value: hook.currentHash }], reloadUserConfig: true });
      if (write.error || write.result?.status !== 'ok') throw new Error(`Codex refused the trust update for ${hook.key}: ${write.error?.message ?? JSON.stringify(write.result?.status)}`);
      trusted.push(hook.key);
    }
    return { trusted, alreadyTrusted, wouldTrust: options.confirm ? [] : wouldTrust, ignored };
  });
}
