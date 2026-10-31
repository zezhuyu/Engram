import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactText } from './redact.js';
import { remoteUrlAllowed } from '../core/private-network.js';
import { ensureStorageDirectory, resolveStoragePath } from '../core/root.js';
import { syncDirectory } from '../storage-local/index.js';
import { assertAvailableStorage } from '../core/storage-lifecycle.js';

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
export const defaultRemoteSpoolDirectory = (env: NodeJS.ProcessEnv = process.env) => resolveStoragePath('remote-spool', env);
async function persist(directory: string, capture: RemoteCapture): Promise<void> {
  await assertAvailableStorage(directory, process.env, Buffer.byteLength(JSON.stringify(capture)) + 4096);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(path.dirname(directory));
  const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
  if (names.length >= DEFAULT_CAP) throw new Error('Remote capture spool is full');
  const target = path.join(directory, `${String(Date.now()).padStart(14, '0')}-${randomUUID()}.json`);
  const temporary = `${target}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(capture)); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, target); await syncDirectory(directory); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  // The size check above races with concurrent hook processes, so re-check after publishing and withdraw our own entry if the cap was exceeded.
  // Concurrent writers may both withdraw, which can leave the spool slightly under the cap, but never over it.
  if ((await fs.readdir(directory)).filter(name => name.endsWith('.json')).length > DEFAULT_CAP) { await fs.rm(target, { force: true }); await syncDirectory(directory).catch(() => undefined); throw new Error('Remote capture spool is full'); }
}
export async function drainRemoteCaptureSpool(options: { token: string; directory?: string; limit?: number }): Promise<{ delivered: number; queued: number; rejected: number }> {
  const directory = options.directory ?? defaultRemoteSpoolDirectory(); let delivered = 0, rejected = 0;
  const files = (await fs.readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json')).sort().slice(0, options.limit ?? 100);
  for (const name of files) {
    const file = path.join(directory, name); let capture: RemoteCapture;
    const quarantine = async (reason: string) => {
      const rejectedDir = path.join(directory, 'rejected'); await fs.mkdir(rejectedDir, { recursive: true, mode: 0o700 });
      await fs.rename(file, path.join(rejectedDir, name));
      await fs.writeFile(path.join(rejectedDir, `${name}.reason.json`), JSON.stringify({ status: reason, rejectedAt: new Date().toISOString() }), { mode: 0o600 });
      rejected++;
    };
    try {
      capture = JSON.parse(await fs.readFile(file, 'utf8')) as RemoteCapture;
      if (!capture || typeof capture.url !== 'string' || typeof capture.registrationId !== 'string' || !capture.payload || typeof capture.payload !== 'object' || Array.isArray(capture.payload) || typeof capture.queuedAt !== 'string' || !Number.isFinite(Date.parse(capture.queuedAt))) throw new Error('invalid queued capture');
      const url = new URL(capture.url);
      if (!remoteUrlAllowed(url)) throw new Error('invalid queued endpoint');
    } catch { await quarantine('invalid queued capture'); continue; }
    try {
      const response = await fetch(capture.url, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ registrationId: capture.registrationId, payload: { ...capture.payload, _engramCapturedAt: capture.queuedAt } }), signal: AbortSignal.timeout(2000) });
      if (!response.ok) {
        // Transient (timeout, throttle, server error) and credential problems (401/403: revoked, rotated or expired token) are not properties of the envelope: stop and keep the backlog so it can be delivered after the server recovers or the client is re-authenticated. Only envelope-specific refusals are quarantined.
        if (response.status === 408 || response.status === 425 || response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) break;
        await quarantine(`http-${response.status}`); continue;
      }
      await fs.rm(file, { force: true }); delivered++;
    } catch { break; }
  }
  const queued = (await fs.readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json')).length;
  return { delivered, queued, rejected };
}
/** Persist first, then attempt delivery. Tokens are supplied at send time and never enter the spool. */
export async function queueRemoteCapture(options: { url: string; registrationId: string; token?: string; payload: Record<string, unknown>; directory?: string }): Promise<{ delivered: number; queued: number; rejected: number }> {
  const url = new URL(options.url);
  if (!remoteUrlAllowed(url)) throw new Error('Remote capture requires HTTPS except on localhost (or a tailnet host with MDB_TRANSPORT_TRUST=tailscale)');
  if (url.pathname.endsWith('/mcp')) url.pathname = `${url.pathname.slice(0, -4)}/capture`;
  else if (!url.pathname.endsWith('/capture')) url.pathname = `${url.pathname.replace(/\/$/, '')}/capture`;
  const directory = options.directory ?? defaultRemoteSpoolDirectory();
  if (!options.directory) await ensureStorageDirectory('remote-spool');
  await persist(directory, { url: url.toString(), registrationId: options.registrationId, payload: minimized(options.payload), queuedAt: new Date().toISOString() });
  return options.token ? drainRemoteCaptureSpool({ token: options.token, directory }) : { delivered: 0, queued: (await fs.readdir(directory)).filter(name => name.endsWith('.json')).length, rejected: 0 };
}
