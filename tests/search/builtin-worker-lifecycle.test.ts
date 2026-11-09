import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposableVault } from '../helpers/disposable-vault.js';
import { run } from '../helpers/host.js';
import { BuiltinBgeM3Embedder } from '../../packages/search-semantic/embedder.js';

const DIST_EMBEDDER = fileURLToPath(new URL('../../packages/search-semantic/embedder.js', import.meta.url));
const workerSource = `import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(process.argv[2], String(process.pid));
process.stdout.write(JSON.stringify({ ready: true, dimensions: 3 }) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  if (req.shutdown) { process.exit(0); }
  if (process.argv[1].endsWith('crash-worker.mjs')) process.exit(17);
  process.stdout.write(JSON.stringify({ id: req.id, vectors: req.texts.map(() => [1, 0, 0]) }) + '\\n');
});
`;

async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-worker-life-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worker = path.join(root, 'worker.mjs'), crashWorker = path.join(root, 'crash-worker.mjs');
  await fs.writeFile(worker, workerSource); await fs.writeFile(crashWorker, workerSource);
  return { root, worker, crashWorker };
}
function exited(child: ReturnType<typeof spawn>, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => { const timer = setTimeout(() => { child.removeListener('exit', done); resolve(false); }, ms); timer.unref(); const done = () => { clearTimeout(timer); resolve(true); }; child.once('exit', done); });
}
async function gone(pid: number, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { process.kill(pid, 0); } catch { return true; } await new Promise(resolve => setTimeout(resolve, 25)); }
  try { process.kill(pid, 0); return false; } catch { return true; }
}

test('builtin child is unreferenced and parent exit reaps it even when close is omitted', async t => {
  const f = await fixture(t), pidFile = path.join(f.root, 'worker.pid');
  const script = `import { BuiltinBgeM3Embedder } from ${JSON.stringify(DIST_EMBEDDER)}; const e=new BuiltinBgeM3Embedder(process.argv[1],{workerPath:process.argv[2],idleTimeoutMs:120000}); await e.embed(['hello']);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script, pidFile, f.worker], { stdio: 'ignore' });
  assert.equal(await exited(parent, 5_000), true, 'unclosed embedder must not keep its parent alive');
  const pid = Number(await fs.readFile(pidFile, 'utf8')); assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(await gone(pid), true, 'worker must not survive parent exit');
});

test('close requests graceful shutdown and resolves after the worker exits', async t => {
  const f = await fixture(t), pidFile = path.join(f.root, 'worker.pid');
  const embedder = new BuiltinBgeM3Embedder(pidFile, { workerPath: f.worker, idleTimeoutMs: 120000 });
  await embedder.embed(['hello']); const pid = Number(await fs.readFile(pidFile, 'utf8'));
  await embedder.close(); assert.equal(await gone(pid, 500), true);
});

test('worker crash during a request rejects promptly with a clear error', async t => {
  const f = await fixture(t), pidFile = path.join(f.root, 'worker.pid');
  const embedder = new BuiltinBgeM3Embedder(pidFile, { workerPath: f.crashWorker, idleTimeoutMs: 120000 });
  await assert.rejects(embedder.embed(['hello']), /worker (?:crashed|exited unexpectedly)/i);
  await embedder.close();
});

test('CLI embed sync and semantic search close the built-in worker promptly', async t => {
  const f = await fixture(t), pidFile = path.join(f.root, 'last-worker.pid');
  const { root, vault } = await disposableVault(t, { sqlite: true });
  await vault.createWorkspace('test-workspace', '', {});
  await vault.put({ scope: { type: 'workspace', workspaceId: 'test-workspace' }, kind: 'note', title: 'Car note', body: 'A blue car is parked.' });
  await vault.setConfig(config => { config.embedding = { provider: 'builtin', model: 'bge-m3', dimensions: 3 }; });
  assert.equal((await run(['index', 'rebuild', '--root', root, '--json'])).code, 0);
  const env = { NODE_ENV: 'test', ENGRAM_BUILTIN_WORKER_PATH: f.worker, ENGRAM_TEST_BUILTIN_MODEL_PATH: pidFile };
  for (const args of [['embed', 'sync'], ['search', 'blue car', '--mode', 'semantic']]) {
    const started = Date.now(), result = await run([...args, '--root', root, '--json'], { env });
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(Date.now() - started < 15_000, `${args.join(' ')} took ${Date.now() - started} ms`);
    const pid = Number(await fs.readFile(pidFile, 'utf8')); assert.equal(await gone(pid), true, 'CLI must close its worker before returning');
    if (args[0] === 'search') assert.equal(JSON.parse(result.stdout).hits[0].title, 'Car note');
  }
});
