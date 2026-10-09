import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactText } from './redact.js';
import { syncDirectory } from '../storage-local/index.js';

type RemoteCapture = { url: string; registrationId: string; payload: Record<string, unknown>; queuedAt: string };
const DEFAULT_CAP = 1000;
const allowed = new Set(['hook_event_name', 'hookEventName', 'event', 'session_id', 'sessionId', 'thread_id', 'threadId', 'cwd', 'source', 'reason', 'prompt_id', 'turn_id', 'turnId', 'tool_use_id', 'prompt', 'user_prompt', 'userPrompt', 'last_assistant_message', 'lastAssistantMessage', 'tool_name', 'toolName']);
function minimized(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) if (allowed.has(key) && typeof value === 'string') result[key] = value.slice(0, key === 'prompt' || key === 'user_prompt' || key === 'userPrompt' || key.startsWith('last_assistant') || key === 'lastAssistantMessage' ? 20_000 : 1000);
  const input = payload.tool_input ?? payload.toolInput;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const selected = input as Record<string, unknown>; result.tool_input = Object.fromEntries(['command', 'file_path', 'path'].filter(key => typeof selected[key] === 'string').map(key => [key, (selected[key] as string).slice(0, 2000)]));
  }
  const response = payload.tool_response ?? payload.toolResponse;
  if (typeof response === 'string') result.tool_response = response.slice(0, 20_000);
  else if (response && typeof response === 'object' && !Array.isArray(response)) {
    const selected = response as Record<string, unknown>; result.tool_response = Object.fromEntries(['stdout', 'stderr', 'output', 'content'].filter(key => typeof selected[key] === 'string').map(key => [key, (selected[key] as string).slice(0, 20_000)]));
  }
  const scrub = (value: unknown): unknown => typeof value === 'string' ? redactText(value) : value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrub(item)])) : value;
  return scrub(result) as Record<string, unknown>;
}
export const defaultRemoteSpoolDirectory = () => process.env.ENGRAM_REMOTE_SPOOL ?? path.join(os.homedir(), '.Engram-remote-spool');
async function persist(directory: string, capture: RemoteCapture): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(path.dirname(directory));
  const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
  if (names.length >= DEFAULT_CAP) throw new Error('Remote capture spool is full');
  const target = path.join(directory, `${String(Date.now()).padStart(14, '0')}-${randomUUID()}.json`);
  const temporary = `${target}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(capture)); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, target); await syncDirectory(directory); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}
export async function drainRemoteCaptureSpool(options: { token: string; directory?: string; limit?: number }): Promise<{ delivered: number; queued: number }> {
  const directory = options.directory ?? defaultRemoteSpoolDirectory(); let delivered = 0;
  const files = (await fs.readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json')).sort().slice(0, options.limit ?? 100);
  for (const name of files) {
    const file = path.join(directory, name); let capture: RemoteCapture;
    try { capture = JSON.parse(await fs.readFile(file, 'utf8')) as RemoteCapture; } catch { continue; }
    try {
      const response = await fetch(capture.url, { method: 'POST', headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ registrationId: capture.registrationId, payload: capture.payload }), signal: AbortSignal.timeout(2000) });
      if (!response.ok) break;
      await fs.rm(file, { force: true }); delivered++;
    } catch { break; }
  }
  const queued = (await fs.readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json')).length;
  return { delivered, queued };
}
/** Persist first, then attempt delivery. Tokens are supplied at send time and never enter the spool. */
export async function queueRemoteCapture(options: { url: string; registrationId: string; token?: string; payload: Record<string, unknown>; directory?: string }): Promise<{ delivered: number; queued: number }> {
  const url = new URL(options.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) throw new Error('Remote capture requires HTTPS except on localhost');
  if (url.pathname.endsWith('/mcp')) url.pathname = `${url.pathname.slice(0, -4)}/capture`;
  else if (!url.pathname.endsWith('/capture')) url.pathname = `${url.pathname.replace(/\/$/, '')}/capture`;
  const directory = options.directory ?? defaultRemoteSpoolDirectory();
  await persist(directory, { url: url.toString(), registrationId: options.registrationId, payload: minimized(options.payload), queuedAt: new Date().toISOString() });
  return options.token ? drainRemoteCaptureSpool({ token: options.token, directory }) : { delivered: 0, queued: (await fs.readdir(directory)).filter(name => name.endsWith('.json')).length };
}
