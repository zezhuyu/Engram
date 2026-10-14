import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../../packages/core/vault.js';
import { waitForDrainIdle } from '../../packages/memory/capture.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
/** Destructive tests only ever touch directories created here under the OS temp dir. */
export async function disposableVault(t: Cleanup, options: { sqlite?: boolean; prefix?: string; /** injected clock for the vault's timestamps */ now?: () => Date } = {}): Promise<{ root: string; vault: Vault }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix ?? 'engram-acid-'));
  // a hook may have started a detached drain that is still writing: removing the vault under it is the race this wait closes
  t.after(async () => { assertDisposable(root); await waitForDrainIdle(root); await fs.rm(root, { recursive: true, force: true }); });
  const vault = options.now ? new Vault(root, undefined, { now: options.now }) : new Vault(root); await vault.init({ sqlite: options.sqlite ?? false });
  return { root, vault };
}
export function assertDisposable(root: string): void {
  const resolved = path.resolve(root), temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep) || !path.basename(resolved).startsWith('engram-')) throw new Error(`Refusing destructive operation outside a disposable vault: ${root}`);
}
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
