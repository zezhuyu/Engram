import { MDBError, type EmbeddingConfig, type EmbeddingProvider } from '../core/types.js';
import { CancelledError, ProviderError } from '../models/errors.js';
import { isLoopbackHost } from '../models/openai.js';
import { readSecret } from '../core/secret-store.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { builtinModelStatus } from './builtin-model.js';

const MAX_RESPONSE_BYTES = 64_000_000, MAX_INPUT_CHARS = 8000;
export const EMBEDDING_DEFAULTS = { timeoutMs: 30_000, maxRetries: 2, batchSize: 32 };
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { if (signal?.aborted) return reject(new CancelledError()); const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(new CancelledError()); }, { once: true }); });

export interface HttpEmbedderOptions { id: string; baseUrl: string; model: string; apiKey?: string; dimensions?: number; locality: 'local' | 'remote'; timeoutMs: number; maxRetries: number; batchSize: number; fetch?: typeof fetch; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }
/** POST {baseUrl}/embeddings (OpenAI and OpenAI-compatible servers, including Ollama's /v1). Strict response validation, bounded retries, sanitized errors, no redirects. */
export class OpenAICompatibleEmbedder implements EmbeddingProvider {
  readonly modelId: string; dimensions = 0; readonly locality: 'local' | 'remote'; private readonly endpoint: string;
  constructor(private readonly o: HttpEmbedderOptions) {
    const url = new URL(o.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new MDBError('INVALID_INPUT', 'Embedding base URL must be http or https');
    if (url.username || url.password) throw new MDBError('INVALID_INPUT', 'Embedding base URL must not embed credentials');
    if (!isLoopbackHost(url.hostname) && url.protocol !== 'https:') throw new MDBError('INVALID_INPUT', 'Remote embedding endpoints must use https');
    this.modelId = o.id; this.locality = o.locality; this.dimensions = o.dimensions ?? 0; this.endpoint = `${o.baseUrl.replace(/\/+$/, '')}/embeddings`;
  }
  async embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.o.batchSize) out.push(...await this.batch(texts.slice(i, i + this.o.batchSize).map(t => t.slice(0, MAX_INPUT_CHARS)), options.signal));
    return out;
  }
  private async batch(input: string[], signal?: AbortSignal): Promise<number[][]> {
    let last: ProviderError | undefined; const wait = this.o.sleep ?? sleep;
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      if (attempt) await wait(Math.min(8000, 250 * 2 ** (attempt - 1)), signal);
      try { return await this.once(input, signal); } catch (e) { if (!(e instanceof ProviderError) || !e.retryable) throw e; last = e; }
    }
    throw new ProviderError(`${last?.message ?? 'Embedding provider failed'} (retries exhausted)`, false, last?.status);
  }
  private async once(input: string[], signal?: AbortSignal): Promise<number[][]> {
    if (signal?.aborted) throw new CancelledError();
    const controller = new AbortController(); let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.o.timeoutMs); const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try { res = await (this.o.fetch ?? fetch)(this.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) }, body: JSON.stringify({ model: this.o.model, input, encoding_format: 'float', ...(this.o.dimensions ? { dimensions: this.o.dimensions } : {}) }) }); }
      catch { if (signal?.aborted) throw new CancelledError(); throw new ProviderError(timedOut ? 'Embedding request timed out' : 'Embedding endpoint unreachable', true); }
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); const s = res.status; throw new ProviderError(s === 401 || s === 403 ? 'Embedding provider rejected the credentials' : s === 404 ? 'Embedding endpoint or model name not found' : s === 408 || s === 429 || s >= 500 ? `Embedding provider returned HTTP ${s}` : `Embedding provider rejected the request (HTTP ${s})`, s === 408 || s === 429 || s >= 500, s); }
      let text = ''; try { const reader = res.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0; for (;;) { const r = await reader!.read(); if (r.done) break; size += r.value.byteLength; if (size > MAX_RESPONSE_BYTES) { await reader!.cancel().catch(() => undefined); throw new ProviderError('Embedding response exceeded the size limit', false); } chunks.push(r.value); } text = Buffer.concat(chunks).toString('utf8'); }
      catch (e) { if (e instanceof ProviderError) throw e; if (signal?.aborted) throw new CancelledError(); throw new ProviderError(timedOut ? 'Embedding request timed out' : 'Embedding response interrupted', true); }
      let data: { data?: Array<{ embedding?: unknown; index?: unknown }> }; try { data = JSON.parse(text) as typeof data; } catch { throw new MDBError('INVALID_MODEL_OUTPUT', 'Embedding endpoint returned a non-JSON response'); }
      const rows = data.data; if (!Array.isArray(rows) || rows.length !== input.length) throw new MDBError('INVALID_MODEL_OUTPUT', 'Embedding response has the wrong number of vectors');
      const sorted = [...rows].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0)); const vectors: number[][] = [];
      for (const row of sorted) {
        const v = row.embedding; if (!Array.isArray(v) || !v.length || v.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new MDBError('INVALID_MODEL_OUTPUT', 'Embedding response contains an invalid vector');
        if (!this.dimensions) this.dimensions = v.length; else if (v.length !== this.dimensions) throw new MDBError('INVALID_MODEL_OUTPUT', `Embedding has ${v.length} dimensions, expected ${this.dimensions}`);
        vectors.push(v as number[]);
      }
      return vectors;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
}

export function createEmbedder(config: EmbeddingConfig | undefined, env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): EmbeddingProvider {
  if (!config?.provider) throw new MDBError('CAPABILITY_UNAVAILABLE', 'No embedding provider is configured (embedding.provider in mdb.yaml)');
  const name = config.provider;
  if (name === 'builtin') throw new MDBError('CAPABILITY_UNAVAILABLE', 'Built-in bge-m3 inference requires the dedicated model worker; use createBuiltinEmbedder after the model is installed');
  const baseUrl = config.baseUrl ?? (name === 'ollama' ? 'http://127.0.0.1:11434/v1' : name === 'openai' ? 'https://api.openai.com/v1' : undefined);
  if (!baseUrl) throw new MDBError('INVALID_INPUT', 'embedding.baseUrl is required for openai-compatible providers');
  let url: URL; try { url = new URL(baseUrl); } catch { throw new MDBError('INVALID_INPUT', 'embedding.baseUrl is not a valid URL'); }
  const locality = config.locality ?? (isLoopbackHost(url.hostname) ? 'local' : 'remote');
  if (!isLoopbackHost(url.hostname) && !config.allowNetwork) throw new MDBError('CAPABILITY_UNAVAILABLE', 'Remote embedding endpoint requires embedding.allowNetwork: true');
  if (!config.model) throw new MDBError('INVALID_INPUT', 'embedding.model is required');
  const keyName = config.apiKeyEnv ?? (name === 'openai' ? 'OPENAI_API_KEY' : undefined); const apiKey = (config.apiKeyRef ? readSecret(config.apiKeyRef, { env: env as NodeJS.ProcessEnv }) : undefined) ?? (keyName ? env[keyName] : undefined);
  if ((name === 'openai' || config.apiKeyEnv) && !apiKey) throw new MDBError('CAPABILITY_UNAVAILABLE', `Environment variable ${keyName} is not set`);
  const bounded = (v: number | undefined, d: number, min: number, max: number, n: string) => { if (v === undefined) return d; if (!Number.isInteger(v) || v < min || v > max) throw new MDBError('INVALID_INPUT', `embedding.${n} must be an integer in ${min}..${max}`); return v; };
  return new OpenAICompatibleEmbedder({ id: `${name}:${config.model}`, baseUrl, model: config.model, ...(apiKey ? { apiKey } : {}), ...(config.dimensions ? { dimensions: bounded(config.dimensions, 0, 8, 8192, 'dimensions') } : {}), locality,
    timeoutMs: bounded(config.timeoutMs, EMBEDDING_DEFAULTS.timeoutMs, 100, 300_000, 'timeoutMs'), maxRetries: bounded(config.maxRetries, EMBEDDING_DEFAULTS.maxRetries, 0, 6, 'maxRetries'), batchSize: bounded(config.batchSize, EMBEDDING_DEFAULTS.batchSize, 1, 256, 'batchSize'), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
type WorkerMessage = { ready?: boolean; dimensions?: number; error?: string; id?: number; vectors?: number[][] };
/** ONNX inference runs in a short-lived child process so model RSS never accumulates in the server. */
export class BuiltinBgeM3Embedder implements EmbeddingProvider {
  readonly modelId = 'builtin:bge-m3@4de13258303883538bd53b696b452bf8099f0858'; readonly dimensions = 1024; readonly locality = 'local' as const;
  private child?: ReturnType<typeof spawn>; private lines?: ReturnType<typeof createInterface>; private ready?: Promise<void>; private nextId = 1; private closing = false; private pending = new Map<number, { resolve(v: number[][]): void; reject(e: Error): void }>();
  constructor(private readonly modelPath: string, private readonly options: { idleTimeoutMs?: number; batchSize?: number; maxTokens?: number; workerPath?: string } = {}) {}
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const entry = this.options.workerPath ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), 'builtin-worker.js');
      const child = spawn(process.execPath, [entry, this.modelPath], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ENGRAM_EMBED_IDLE_MS: String(this.options.idleTimeoutMs ?? 120_000) } }); this.child = child; this.setPipeReferences(true);
      // The active request keeps the child referenced; setPipeReferences(false) applies the idle policy after it settles.
      const cleanup = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.ref();
        child.kill('SIGKILL');
      };
      process.once('beforeExit', cleanup);
      process.once('exit', cleanup);
      child.once('exit', () => { process.removeListener('beforeExit', cleanup); process.removeListener('exit', cleanup); });
      this.lines = createInterface({ input: child.stdout });
      let initialized = false;
      this.lines.on('line', line => { let message: WorkerMessage; try { message = JSON.parse(line) as WorkerMessage; } catch { return; } if (!initialized) { initialized = true; if (message.ready) resolve(); else reject(new Error(message.error ?? 'Built-in model worker failed to load')); return; } if (message.id !== undefined) { const item = this.pending.get(message.id); if (item) { this.pending.delete(message.id); message.error ? item.reject(new Error(message.error)) : item.resolve(message.vectors ?? []); } } else if (message.error) this.fail(message.error); });
      child.once('error', error => { if (!initialized) reject(new Error(`Built-in model worker could not start: ${error.message}`)); this.fail('Built-in model worker crashed'); });
      child.once('exit', () => { this.child = undefined; this.lines?.close(); this.lines = undefined; this.ready = undefined; if (!initialized) reject(new Error('Built-in model worker exited before loading the model')); this.fail('Built-in model worker exited unexpectedly'); });
      child.once('close', () => { this.child = undefined; this.lines?.close(); this.lines = undefined; this.ready = undefined; if (!initialized) reject(new Error('Built-in model worker closed before loading the model')); this.fail('Built-in model worker exited unexpectedly'); });
    });
    this.ready.catch(() => { this.ready = undefined; }); return this.ready;
  }
  private fail(message: string) { for (const p of this.pending.values()) p.reject(new Error(message)); this.pending.clear(); }
  private setPipeReferences(referenced: boolean): void {
    if (referenced) this.child?.ref(); else this.child?.unref();
    const change = (stream: unknown) => { const handle = (stream as { _handle?: { ref?: () => void; unref?: () => void } } | null)?._handle; if (referenced) handle?.ref?.(); else handle?.unref?.(); };
    change(this.child?.stdin); change(this.child?.stdout); change(this.child?.stderr);
  }
  async close(): Promise<void> {
    const child = this.child; if (!child) return;
    if (this.closing) { await this.waitForExit(child); return; }
    this.closing = true; this.setPipeReferences(true);
    try {
      if (child.exitCode === null && child.signalCode === null && child.stdin?.writable) child.stdin.write(JSON.stringify({ shutdown: true }) + '\n');
      if (!await this.waitForExit(child, 2_000)) {
        child.kill('SIGTERM');
        if (!await this.waitForExit(child, 2_000)) { child.kill('SIGKILL'); await this.waitForExit(child, 1_000); }
      }
    } finally {
      if (this.child === child) this.child = undefined;
      this.ready = undefined; this.lines?.close(); this.lines = undefined; this.closing = false; this.setPipeReferences(false);
      this.fail('Built-in model worker closed');
    }
  }
  private waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 0): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (exited: boolean) => { if (timer) clearTimeout(timer); child.removeListener('exit', onExit); resolve(exited); };
      const onExit = () => finish(true);
      child.once('exit', onExit);
      if (timeoutMs) timer = setTimeout(() => finish(false), timeoutMs);
    });
  }
  async warmUp(): Promise<void> { await this.embed(['Engram local embedding worker readiness check.']); }
  async embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    if (!texts.length) return [];
    if (this.closing) throw new Error('Built-in model worker is closing');
    this.setPipeReferences(true);
    try {
      await this.start(); const out: number[][] = []; const batchSize = Math.max(1, Math.min(256, this.options.batchSize ?? 32));
      for (let i = 0; i < texts.length; i += batchSize) {
        if (options.signal?.aborted) throw new CancelledError();
        const id = this.nextId++, batch = texts.slice(i, i + batchSize).map(t => t.slice(0, MAX_INPUT_CHARS));
        const result = await new Promise<number[][]>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
          const timer = setTimeout(() => { cleanup(); this.pending.delete(id); reject(new Error('Built-in model worker timed out')); this.child?.kill(); }, 300_000); timer.unref();
          const abort = () => { cleanup(); this.pending.delete(id); reject(new CancelledError()); this.child?.kill(); };
          this.pending.set(id, { resolve: v => { cleanup(); resolve(v); }, reject: e => { cleanup(); reject(e); } });
          this.child!.stdin!.write(JSON.stringify({ id, texts: batch, maxTokens: this.options.maxTokens ?? 512 }) + '\n', error => { if (error) { cleanup(); this.pending.delete(id); reject(new Error('Built-in model worker input failed')); } });
          options.signal?.addEventListener('abort', abort, { once: true });
        }); out.push(...result);
      }
      return out;
    } finally { this.setPipeReferences(false); }
  }
}
export async function createBuiltinEmbedder(config: EmbeddingConfig, options: { env?: NodeJS.ProcessEnv; batchSize?: number; workerPath?: string; idleTimeoutMs?: number } = {}): Promise<BuiltinBgeM3Embedder> {
  const testWorker = process.env.NODE_ENV === 'test' ? process.env.ENGRAM_BUILTIN_WORKER_PATH : undefined;
  const workerPath = options.workerPath ?? testWorker;
  const status = workerPath && process.env.NODE_ENV === 'test' ? undefined : await builtinModelStatus({ env: options.env });
  if (status && status.state !== 'ready') throw new MDBError('CAPABILITY_UNAVAILABLE', 'Built-in bge-m3 is not installed; explicitly download it in Settings or with mdb embed model download');
  const modelPath = status?.destination ?? process.env.ENGRAM_TEST_BUILTIN_MODEL_PATH ?? '.';
  return new BuiltinBgeM3Embedder(modelPath, { batchSize: config.batchSize, maxTokens: config.maxTokens, ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}), ...(workerPath ? { workerPath } : {}) });
}
export async function testEmbedding(config: EmbeddingConfig, options: { env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}): Promise<{ dimensions: number; latencyMs: number; locality: 'local' | 'remote'; provider: string; model: string }> {
  const started = performance.now();
  const embedder = config.provider === 'builtin' ? await createBuiltinEmbedder(config) : createEmbedder(config, options.env ?? process.env, options.fetch);
  try { const vectors = await embedder.embed(['Synthetic embedding provider check.']); const vector = vectors[0]; if (!vector?.length) throw new MDBError('INVALID_MODEL_OUTPUT', 'Embedding provider returned no vector'); return { dimensions: vector.length, latencyMs: Math.round(performance.now() - started), locality: embedder.locality ?? 'local', provider: config.provider!, model: config.model ?? 'bge-m3' }; } finally { if (embedder instanceof BuiltinBgeM3Embedder) await embedder.close(); }
}
export function describeEmbedding(config: EmbeddingConfig | undefined, env: Record<string, string | undefined> = process.env): { configured: boolean; available: boolean; model?: string; locality?: 'local' | 'remote'; reason?: string } {
  if (!config?.provider) return { configured: false, available: false, reason: 'No embedding provider configured; semantic and hybrid search are disabled (keyword, grep and regex are unaffected)' };
  try { const e = createEmbedder(config, env); return { configured: true, available: true, model: e.modelId, locality: e.locality ?? 'local' }; } catch (e) { return { configured: true, available: false, reason: (e as Error).message }; }
}
