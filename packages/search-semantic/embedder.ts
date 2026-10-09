import { MDBError, type EmbeddingConfig, type EmbeddingProvider } from '../core/types.js';
import { CancelledError, ProviderError } from '../models/errors.js';
import { isLoopbackHost } from '../models/openai.js';

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
  const baseUrl = config.baseUrl ?? (name === 'ollama' ? 'http://127.0.0.1:11434/v1' : name === 'openai' ? 'https://api.openai.com/v1' : undefined);
  if (!baseUrl) throw new MDBError('INVALID_INPUT', 'embedding.baseUrl is required for openai-compatible providers');
  let url: URL; try { url = new URL(baseUrl); } catch { throw new MDBError('INVALID_INPUT', 'embedding.baseUrl is not a valid URL'); }
  const locality = config.locality ?? (isLoopbackHost(url.hostname) ? 'local' : 'remote');
  if (!isLoopbackHost(url.hostname) && !config.allowNetwork) throw new MDBError('CAPABILITY_UNAVAILABLE', 'Remote embedding endpoint requires embedding.allowNetwork: true');
  if (!config.model) throw new MDBError('INVALID_INPUT', 'embedding.model is required');
  const keyName = config.apiKeyEnv ?? (name === 'openai' ? 'OPENAI_API_KEY' : undefined); const apiKey = keyName ? env[keyName] : undefined;
  if ((name === 'openai' || config.apiKeyEnv) && !apiKey) throw new MDBError('CAPABILITY_UNAVAILABLE', `Environment variable ${keyName} is not set`);
  const bounded = (v: number | undefined, d: number, min: number, max: number, n: string) => { if (v === undefined) return d; if (!Number.isInteger(v) || v < min || v > max) throw new MDBError('INVALID_INPUT', `embedding.${n} must be an integer in ${min}..${max}`); return v; };
  return new OpenAICompatibleEmbedder({ id: `${name}:${config.model}`, baseUrl, model: config.model, ...(apiKey ? { apiKey } : {}), ...(config.dimensions ? { dimensions: bounded(config.dimensions, 0, 8, 8192, 'dimensions') } : {}), locality,
    timeoutMs: bounded(config.timeoutMs, EMBEDDING_DEFAULTS.timeoutMs, 100, 300_000, 'timeoutMs'), maxRetries: bounded(config.maxRetries, EMBEDDING_DEFAULTS.maxRetries, 0, 6, 'maxRetries'), batchSize: bounded(config.batchSize, EMBEDDING_DEFAULTS.batchSize, 1, 256, 'batchSize'), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
export function describeEmbedding(config: EmbeddingConfig | undefined, env: Record<string, string | undefined> = process.env): { configured: boolean; available: boolean; model?: string; locality?: 'local' | 'remote'; reason?: string } {
  if (!config?.provider) return { configured: false, available: false, reason: 'No embedding provider configured; semantic and hybrid search are disabled (keyword, grep and regex are unaffected)' };
  try { const e = createEmbedder(config, env); return { configured: true, available: true, model: e.modelId, locality: e.locality ?? 'local' }; } catch (e) { return { configured: true, available: false, reason: (e as Error).message }; }
}
