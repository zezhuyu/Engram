import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { BGE_M3, builtinModelStatus, previewBuiltinModel, removeBuiltinModel, startDownload, cancelDownload, type BuiltinManifest } from '../../packages/search-semantic/builtin-model.js';

test('bge-m3 manifest is pinned, complete and preview never performs network access', async () => {
  let requests = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-model-preview-'));
  try {
    const preview = await previewBuiltinModel({ env: { HOME: root, ENGRAM_MODEL_CACHE: path.join(root, 'explicit-cache') }, freeBytes: async () => 2_000_000_000, fetch: async () => { requests++; throw new Error('network must not be reached'); } });
    assert.equal(preview.id, 'bge-m3'); assert.equal(preview.repo, 'Xenova/bge-m3');
    assert.equal(preview.revision, '4de13258303883538bd53b696b452bf8099f0858'); assert.equal(preview.license, 'MIT');
    assert.equal(preview.destination, path.join(root, 'explicit-cache'));
    assert.equal(preview.totalBytes, 585_542_422); assert.equal(requests, 0);
    assert.ok(preview.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.deepEqual(preview.files, BGE_M3.files);
    assert.equal((await builtinModelStatus({ env: { HOME: root, ENGRAM_MODEL_CACHE: preview.destination } })).state, 'not_installed');
    await removeBuiltinModel({ env: { HOME: root, ENGRAM_MODEL_CACHE: preview.destination } });
    assert.equal(requests, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function tinyManifest(contents: Record<string, Buffer>): BuiltinManifest {
  return { id: 'fixture', repo: 'test/bge', revision: 'revision', license: 'MIT', dimensions: 2, maxTokens: 16, files: Object.entries(contents).map(([name, data]) => ({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })) };
}
async function fakeServer(handler: http.RequestListener) {
  const server = http.createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('fake Hugging Face download resumes, verifies hashes, installs private files and reports progress', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-model-download-')), data = { 'config.json': Buffer.from('{"ok":true}'), 'nested/tokenizer.json': Buffer.from('{"vocab":[]}') }, manifest = tinyManifest(data);
  const seen: Array<{ path: string; range: string | undefined }> = [];
  const fake = await fakeServer((req, res) => { const name = decodeURIComponent(req.url!.split('/').pop()!); const body = data[name === 'config.json' ? name : 'nested/tokenizer.json']!; const range = req.headers.range; seen.push({ path: req.url!, range }); if (range) { const offset = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? '0'); res.statusCode = 206; res.setHeader('content-range', `bytes ${offset}-${body.length - 1}/${body.length}`); res.end(body.subarray(offset)); } else res.end(body); });
  t.after(async () => { await fake.close(); await rm(root, { recursive: true, force: true }); });
  const destination = path.join(root, 'cache'), partial = path.join(destination, 'fixture/revision/config.json.part'); await import('node:fs/promises').then(fs => fs.mkdir(path.dirname(partial), { recursive: true, mode: 0o700 })); await import('node:fs/promises').then(fs => fs.writeFile(partial, data['config.json'].subarray(0, 3), { mode: 0o644 }));
  const progress: string[] = [], options = { env: { HOME: root, ENGRAM_MODEL_CACHE: path.join(destination, 'fixture/revision') }, manifest, downloadBaseUrl: fake.baseUrl, allowHosts: (host: string) => host === '127.0.0.1', freeBytes: async () => 100_000, onProgress: (event: { bytes: number; totalBytes: number; file: string }) => progress.push(event.file) };
  t.after(() => removeBuiltinModel(options));
  const installed = await startDownload(options);
  assert.equal(installed, options.env.ENGRAM_MODEL_CACHE); assert.equal(seen[0]!.range, 'bytes=3-'); assert.equal(seen.length, 2); assert.ok(progress.includes('nested/tokenizer.json'));
  assert.equal((await builtinModelStatus(options)).state, 'ready');
  const fs = await import('node:fs/promises');
  assert.equal((await fs.stat(installed)).mode & 0o777, 0o700); assert.equal((await fs.stat(path.join(installed, 'config.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readFile(path.join(installed, 'config.json')), data['config.json']);
});

test('fake Hugging Face refuses insufficient disk and disallowed redirects before writing model files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-model-refusal-')), contents = { 'weights.bin': Buffer.from('weights') }, manifest = tinyManifest(contents); let requests = 0;
  const fake = await fakeServer((_req, res) => { requests++; res.statusCode = 302; res.setHeader('location', 'https://evil.invalid/weights'); res.end(); });
  t.after(async () => { await fake.close(); await rm(root, { recursive: true, force: true }); });
  const options = { env: { HOME: root, ENGRAM_MODEL_CACHE: path.join(root, 'cache', 'fixture', 'revision') }, manifest, downloadBaseUrl: fake.baseUrl, allowHosts: (host: string) => host === '127.0.0.1', freeBytes: async () => 0 };
  t.after(() => removeBuiltinModel(options));
  await assert.rejects(startDownload(options), /free disk space/); assert.equal(requests, 0);
  await assert.rejects(startDownload({ ...options, freeBytes: async () => 100 }), /disallowed host/); assert.equal(requests, 1);
  assert.equal((await builtinModelStatus(options)).state, 'failed');
});

test('only one fake model download runs at a time and cancellation is reported', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-model-cancel-')), manifest = tinyManifest({ 'weights.bin': Buffer.alloc(1024, 7) }); let requested!: () => void; const requestedPromise = new Promise<void>(resolve => { requested = resolve; });
  const fake = await fakeServer((_req, res) => { requested(); res.write(Buffer.alloc(16)); });
  t.after(async () => { await fake.close(); await rm(root, { recursive: true, force: true }); });
  const options = { env: { HOME: root, ENGRAM_MODEL_CACHE: path.join(root, 'cache', 'fixture', 'revision') }, manifest, downloadBaseUrl: fake.baseUrl, allowHosts: (host: string) => host === '127.0.0.1', freeBytes: async () => 100_000 };
  t.after(() => removeBuiltinModel(options));
  const first = startDownload(options); await requestedPromise; await assert.rejects(startDownload(options), /already running/); assert.equal(cancelDownload(), true); await assert.rejects(first, /cancelled/i);
});

test('fake Hugging Face SHA mismatch deletes the partial file and leaves failed status', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-model-hash-')), contents = { 'weights.bin': Buffer.from('expected') }, manifest = tinyManifest(contents), fake = await fakeServer((_req, res) => res.end('tampered'));
  t.after(async () => { await fake.close(); await rm(root, { recursive: true, force: true }); });
  const options = { env: { HOME: root, ENGRAM_MODEL_CACHE: path.join(root, 'cache', 'fixture', 'revision') }, manifest, downloadBaseUrl: fake.baseUrl, allowHosts: (host: string) => host === '127.0.0.1', freeBytes: async () => 100_000 };
  t.after(() => removeBuiltinModel(options));
  await assert.rejects(startDownload(options), /SHA-256 verification failed/);
  await assert.rejects(import('node:fs/promises').then(fs => fs.access(path.join(options.env.ENGRAM_MODEL_CACHE, 'weights.bin.part'))), { code: 'ENOENT' });
  assert.equal((await builtinModelStatus(options)).state, 'failed');
});
