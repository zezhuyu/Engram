import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from './disposable-vault.js';
import { ownChildProcess } from './owned-process.js';

/**
 * node:test runs `t.after` hooks in registration order and a hook that throws skips the rest. Tests register the vault first and the MCP server child second,
 * so the vault is removed while the server is still writing its indexes. This test uses only the public helpers and replays that registration order with a
 * writer that keeps re-creating `.mdb/indexes`: after all hooks ran the writer must be dead and the vault must stay removed.
 */
test('the real disposableVault + ownChildProcess hooks stop a live index writer before removing the vault', async () => {
  const hooks: Array<() => void | Promise<void>> = [];
  const t = { after: (hook: () => void | Promise<void>) => { hooks.push(hook); } };
  const { root } = await disposableVault(t);
  const indexes = path.join(root, '.mdb', 'indexes');
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');const p=${JSON.stringify(indexes)};setInterval(()=>{try{fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/'+process.hrtime.bigint()+'.tmp','x')}catch{}},2)`], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const pid = child.pid!;
  ownChildProcess(t, child);
  await new Promise(resolve => setTimeout(resolve, 60));
  let failure: unknown;
  for (const hook of hooks) { try { await hook(); } catch (error) { failure = error; break; } } // node:test semantics: the first throw aborts the remaining hooks
  const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
  if (alive) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await new Promise(resolve => setTimeout(resolve, 300));
  const rootExists = await fs.stat(root).then(() => true, () => false);
  if (rootExists) await fs.rm(root, { recursive: true, force: true });
  assert.equal(failure, undefined, `no cleanup hook may throw: ${String(failure)}`);
  assert.equal(alive, false, 'the owned writer must be stopped by the hooks, not left running');
  assert.equal(rootExists, false, 'the removed vault must not be recreated by a surviving writer');
});
