import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { userConfigPath } from '../memory/user-config.js';
import { findBinding, type ProjectBinding } from './project-binding.js';

/**
 * A project binding is only a request. `.engram/project.json` can arrive with a cloned repository, and it names a server and an environment variable that holds a credential, so
 * a hook that obeyed any binding it found would let a stranger's repo aim the user's credential at a server of their choosing. A binding is therefore honored only if THIS machine's
 * own `mdb init` recorded it: (real project root, fingerprint of everything the binding asks for). Change the server, the credential variable, the consent or the approved paths and the
 * fingerprint no longer matches, so the hooks go quiet until the owner runs init again. The registry lives with the user-level config, never in the repository.
 */
export interface TrustEntry { root: string; fingerprint: string; trustedAt: string }
export const trustFilePath = (env: NodeJS.ProcessEnv = process.env): string => env.ENGRAM_TRUST_FILE ?? path.join(path.dirname(userConfigPath(env)), 'trusted-projects.json');
/** Everything the binding asks the machine to do; `managed` (generation time, projection revision) is bookkeeping and excluded. */
export function bindingFingerprint(binding: ProjectBinding): string {
  const { managed: _managed, ...rest } = binding;
  const canonical = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
async function readRegistry(env: NodeJS.ProcessEnv): Promise<TrustEntry[]> {
  try { const parsed = JSON.parse(await fs.readFile(trustFilePath(env), 'utf8')) as { schemaVersion?: number; entries?: TrustEntry[] }; return parsed.schemaVersion === 1 && Array.isArray(parsed.entries) ? parsed.entries.filter(e => typeof e?.root === 'string' && typeof e.fingerprint === 'string') : []; }
  catch { return []; }
}
async function writeRegistry(entries: TrustEntry[], env: NodeJS.ProcessEnv): Promise<void> {
  const file = trustFilePath(env); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
}
export async function trustProject(projectDir: string, binding: ProjectBinding, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const root = await fs.realpath(projectDir); const entries = (await readRegistry(env)).filter(e => e.root !== root);
  entries.push({ root, fingerprint: bindingFingerprint(binding), trustedAt: new Date().toISOString() }); await writeRegistry(entries, env);
}
export async function untrustProject(projectDir: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const root = await fs.realpath(projectDir).catch(() => path.resolve(projectDir)); const entries = await readRegistry(env); const kept = entries.filter(e => e.root !== root);
  if (kept.length === entries.length) return false; await writeRegistry(kept, env); return true;
}
export async function isTrusted(projectDir: string, binding: ProjectBinding, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try { const root = await fs.realpath(projectDir); const fingerprint = bindingFingerprint(binding); return (await readRegistry(env)).some(e => e.root === root && e.fingerprint === fingerprint); } catch { return false; }
}
/** The binding that applies to `startDir` AND that this machine has agreed to. `untrusted` is returned (not hidden) so callers can say why nothing happened. */
export async function findTrustedBinding(startDir: string, env: NodeJS.ProcessEnv = process.env): Promise<{ root: string; binding: ProjectBinding; trusted: boolean } | undefined> {
  const found = await findBinding(startDir); if (!found) return undefined;
  return { ...found, trusted: await isTrusted(found.root, found.binding, env) };
}
