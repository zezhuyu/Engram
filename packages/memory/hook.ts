import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueueEvent, eventFromHostPayload, markDrainPending, readRegistration, spoolStats } from './capture.js';

/** Reads a hook payload from stdin with a size and time bound. */
export function readStdin(limit = 2_000_000, timeoutMs = 3000): Promise<string> {
  return new Promise(resolve => {
    let data = '', size = 0, done = false; const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(data); } };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= limit) data += chunk.toString('utf8'); else finish(); });
    process.stdin.on('end', finish); process.stdin.on('error', finish);
  });
}
/**
 * Fail-open recorder used as a host lifecycle hook. It never opens the vault, never calls a model, never writes to stdout
 * (some hosts add hook output to the model context), and never reports failure to the host: a problem simply means one event is not recorded.
 */
export async function captureFromHook(options: { root: string; host: string; registrationId: string }, stdin: string): Promise<{ status: 'queued' | 'dropped' | 'ignored' | 'error'; reason?: string }> {
  try {
    const registration = await readRegistration(options.root, options.registrationId);
    if (!registration || registration.host !== options.host) return { status: 'ignored', reason: 'no active registration' };
    let payload: unknown; try { payload = JSON.parse(stdin); } catch { return { status: 'ignored', reason: 'payload is not JSON' }; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { status: 'ignored', reason: 'payload is not an object' };
    const event = eventFromHostPayload(registration, payload as Record<string, unknown>);
    if (!event) return { status: 'ignored', reason: 'event not selected for capture' };
    const status = await enqueueEvent(options.root, { registrationId: registration.id, event });
    if (status === 'queued' && (event.type === 'session.end' || (await spoolStats(options.root)).queued >= 25)) {
      const mdb = fileURLToPath(new URL('../../../bin/mdb.js', import.meta.url));
      const child = spawn(process.execPath, [mdb, 'memory', 'drain', '--root', options.root], { detached: true, stdio: 'ignore' }); child.unref();
      await markDrainPending(options.root, child.pid).catch(() => undefined); // lets anything that removes or moves the vault wait for the background drain
    }
    return { status };
  } catch (error) { return { status: 'error', reason: (error as Error).name }; }
}
