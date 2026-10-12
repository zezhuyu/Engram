import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findTrustedBinding } from '../core/project-trust.js';
import { Engram } from '../sdk/index.js';
import { openRemoteSession, RemoteError } from './remote-client.js';
import { cacheDir, type ContextState, contextStateFile } from './context-hook.js';
import { insideProject } from './user-setup.js';

/**
 * Stop hook: asks the AGENT to write the session handoff, once, when the session did real work and no handoff exists for it. Engram never writes a handoff itself: the content (what was
 * completed, what is next) is only known to the agent, so a derived summary would be a fabrication. The request carries the exact session id so the handoff can be found again.
 */
export type HandoffOutcome = 'requested' | 'skipped' | 'error';
export interface HandoffResult { outcome: HandoffOutcome; reason: string; output: string; sessionId?: string }
const WORK_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$|engram_(note|task)_upsert/;
/** A shell tool counts as work only when its command looks like it changes files or history; plain reads do not. */
const MUTATING_SHELL = /(^|[\s;&|"'(])(rm|mv|cp|mkdir|touch|tee|patch|chmod|ln|git\s+(add|commit|apply|mv|rm|checkout|merge|rebase|stash)|sed\s+-i|npm\s+(install|i|run\s+build)|pnpm\s+(install|add)|yarn\s+(install|add))\b|[^<>=!-]>{1,2}[^&>=]|<<-?\s*['"]?\w+/;
export interface ToolCall { name: string; input: string }
export const isWork = (call: ToolCall): boolean => WORK_TOOLS.test(call.name) || (/^(Bash|shell|exec_command|local_shell)$/.test(call.name) && MUTATING_SHELL.test(call.input));
/** The tool calls a session transcript shows (Claude Code `tool_use` blocks and Codex `response_item` function/custom tool calls); bounded read of the end of the file. Unreadable: undefined. */
export async function toolCalls(transcriptPath: string, limitBytes = 4 * 1024 * 1024): Promise<ToolCall[] | undefined> {
  try {
    const handle = await fs.open(transcriptPath, 'r'); try {
      const size = (await handle.stat()).size; const start = Math.max(0, size - limitBytes); const buffer = Buffer.alloc(size - start); await handle.read(buffer, 0, buffer.length, start);
      const calls: ToolCall[] = [];
      for (const line of buffer.toString('utf8').split('\n')) {
        if (!line.includes('tool_use') && !line.includes('function_call') && !line.includes('custom_tool_call')) continue;
        try {
          const entry = JSON.parse(line) as { message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> }; type?: string; payload?: { type?: string; name?: string; arguments?: unknown; input?: unknown } };
          for (const part of entry.message?.content ?? []) if (part.type === 'tool_use' && typeof part.name === 'string') calls.push({ name: part.name, input: JSON.stringify(part.input ?? '').slice(0, 2000) });
          const p = entry.payload; if (entry.type === 'response_item' && p && (p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.name === 'string') calls.push({ name: p.name, input: (typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : JSON.stringify(p.arguments ?? p.input ?? '')).slice(0, 2000) });
        } catch { /* a cut first line */ }
      }
      return calls;
    } finally { await handle.close(); }
  } catch { return undefined; }
}
export async function runHandoffHook(options: { host: string; stdin: string; projectRoot?: string; root?: string; env?: NodeJS.ProcessEnv; now?: Date; timeoutMs?: number }): Promise<HandoffResult> {
  const env = options.env ?? process.env; const skip = (reason: string, sessionId?: string): HandoffResult => ({ outcome: 'skipped', reason, output: '', ...(sessionId ? { sessionId } : {}) });
  try {
    if (options.projectRoot && !(await insideProject(options.stdin, options.projectRoot))) return skip('session is outside this project');
    const payload = JSON.parse(options.stdin) as { cwd?: string; session_id?: string; stop_hook_active?: boolean; transcript_path?: string };
    if (payload.stop_hook_active) return skip('already continuing because of a stop hook'); // never loops: at most one request per stop
    const sessionId = typeof payload.session_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(payload.session_id) ? payload.session_id : undefined; if (!sessionId) return skip('no usable session id');
    const found = await findTrustedBinding(String(payload.cwd ?? ''), env).catch(() => undefined); if (!found?.trusted) return skip('project binding is not trusted or missing', sessionId);
    const marker = path.join(cacheDir(env), 'handoff-requested', createHash('sha256').update(sessionId).digest('hex').slice(0, 24)); if (await fs.stat(marker).then(() => true, () => false)) return skip('a handoff was already requested for this session', sessionId);
    const used = typeof payload.transcript_path === 'string' ? await toolCalls(payload.transcript_path) : undefined;
    if (!used) return skip('the session transcript is not readable, so whether work was done is unknown', sessionId);
    if (!used.some(isWork)) return skip('no files or Engram records were written in this session', sessionId);
    if (used.some(call => /engram_handoff_write/.test(call.name))) return skip('the session already wrote a handoff', sessionId);
    const scope = { type: 'workspace' as const, workspaceId: found.binding.workspaceId }; let exists = false;
    if (found.binding.serverUrl) {
      const token = found.binding.credentialRef ? env[found.binding.credentialRef] : undefined; if (!token) return skip('no credential available to check for an existing handoff', sessionId);
      try { const s = await openRemoteSession({ url: found.binding.serverUrl, token, workspaceId: found.binding.workspaceId, timeoutMs: options.timeoutMs ?? 1500 }); exists = !!((await s.call('engram_handoff_status', { scope, sessionId })).value as { exists?: boolean } | undefined)?.exists; }
      catch (error) { return skip(error instanceof RemoteError ? error.message : 'server unreachable; no handoff requested', sessionId); }
    } else if (options.root) exists = !!(await new Engram(options.root).vault.byIdempotencyKey(`handoff:${sessionId}`, scope)); else return skip('local mode needs a vault root', sessionId);
    if (exists) return skip('a handoff for this session already exists', sessionId);
    await fs.mkdir(path.dirname(marker), { recursive: true, mode: 0o700 }); await fs.writeFile(marker, `${(options.now ?? new Date()).toISOString()}\n`, { mode: 0o600 });
    const reason = `Before you finish: record this session's handoff in Engram. Call engram_handoff_write with sessionId "${sessionId}", state "ended", and short lists for completed, next, blockers, filesTouched and openTasks (use the task ids you used). Report only what actually happened in this session. Then finish.`;
    return { outcome: 'requested', reason: 'work was done and no handoff exists', output: `${JSON.stringify({ decision: 'block', reason })}\n`, sessionId };
  } catch (error) { return { outcome: 'error', reason: error instanceof Error ? error.name : 'error', output: '' }; }
}
export async function recordHandoffState(host: string, result: HandoffResult, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try { let all: Record<string, ContextState> = {}; try { all = JSON.parse(await fs.readFile(contextStateFile(env), 'utf8')); } catch { /* none */ } all[`${host}:handoff`] = { host, at: new Date().toISOString(), outcome: result.outcome === 'requested' ? 'fresh' : result.outcome === 'skipped' ? 'none' : 'error', reason: `${result.outcome}: ${result.reason}` }; await fs.mkdir(path.dirname(contextStateFile(env)), { recursive: true, mode: 0o700 }); await fs.writeFile(contextStateFile(env), JSON.stringify(all, null, 2), { mode: 0o600 }); } catch { /* diagnostics only */ }
}
