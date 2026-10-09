import { MDBError, type CriticVerdict, type CritiqueRequest, type ModelCallOptions, type ModelProposal, type ModelProvider, type ModelRequest } from '../core/types.js';
import { CancelledError, ProviderError } from './errors.js';
import { critiqueMessages, estimateTokens, generationMessages, type ChatMessage } from './prompts.js';
import { extractJson, parseModelProposal, parseVerdict } from './schema.js';

export interface HttpProviderOptions {
  id: string; baseUrl: string; model: string; apiKey?: string; locality: 'local' | 'remote';
  timeoutMs: number; maxRetries: number; maxInputTokens: number; maxOutputTokens: number;
  /** Ask for response_format json_object. Disable for servers that reject it. */
  jsonMode?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_RETRY_AFTER_MS = 30_000;

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new CancelledError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Chat-completions client for OpenAI and OpenAI-compatible servers (including Ollama's /v1 endpoint). */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly locality: 'local' | 'remote';
  private readonly endpoint: string;
  private jsonMode: boolean;
  constructor(private readonly options: HttpProviderOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new MDBError('INVALID_INPUT', 'Model base URL must be http or https');
    if (url.username || url.password) throw new MDBError('INVALID_INPUT', 'Model base URL must not embed credentials');
    if (!isLoopbackHost(url.hostname) && url.protocol !== 'https:') throw new MDBError('INVALID_INPUT', 'Remote model endpoints must use https');
    if (!options.model.trim()) throw new MDBError('INVALID_INPUT', 'A model name is required');
    this.id = options.id;
    this.locality = options.locality;
    this.jsonMode = options.jsonMode !== false;
    this.endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async generate(input: ModelRequest, options: ModelCallOptions = {}): Promise<ModelProposal> {
    return parseModelProposal(extractJson(await this.complete(generationMessages(input), options)));
  }
  async critique(input: CritiqueRequest, options: ModelCallOptions = {}): Promise<CriticVerdict> {
    return parseVerdict(extractJson(await this.complete(critiqueMessages(input), options)));
  }

  private async complete(messages: ChatMessage[], call: ModelCallOptions): Promise<string> {
    if (call.signal?.aborted) throw new CancelledError();
    if (estimateTokens(messages.map(m => m.content).join('\n')) > this.options.maxInputTokens) throw new MDBError('CAPABILITY_UNAVAILABLE', 'Input exceeds the configured model token budget');
    const maxTokens = Math.max(1, Math.min(call.maxOutputTokens ?? this.options.maxOutputTokens, this.options.maxOutputTokens));
    const body = (json: boolean) => JSON.stringify({ model: this.options.model, messages, temperature: 0.2, max_tokens: maxTokens, stream: false, ...(json ? { response_format: { type: 'json_object' } } : {}) });
    const sleep = this.options.sleep ?? abortableSleep;
    let last: ProviderError | undefined;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0) await sleep(this.delay(attempt, last), call.signal);
      try { return await this.once(body(this.jsonMode), call.signal); }
      catch (error) {
        // Some OpenAI-compatible servers reject response_format; remember that and retry once without it.
        if (error instanceof ProviderError && this.jsonMode && (error.status === 400 || error.status === 422)) { this.jsonMode = false; try { return await this.once(body(false), call.signal); } catch (second) { error = second as ProviderError; } }
        if (!(error instanceof ProviderError) || !error.retryable) throw error;
        last = error;
      }
    }
    throw new ProviderError(`${last?.message ?? 'Model provider failed'} (retries exhausted)`, false, last?.status);
  }

  private retryAfter = new WeakMap<ProviderError, number>();
  private delay(attempt: number, error?: ProviderError): number {
    const hinted = error ? this.retryAfter.get(error) : undefined;
    if (hinted !== undefined) return Math.min(hinted, MAX_RETRY_AFTER_MS);
    return Math.min(8000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
  }

  private async once(payload: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(this.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) }, body: payload });
      } catch {
        if (signal?.aborted) throw new CancelledError();
        throw new ProviderError(timedOut ? 'Model request timed out' : 'Model endpoint unreachable', true);
      }
      if (!response.ok) {
        const error = this.httpError(response.status);
        const hint = Number(response.headers.get('retry-after'));
        if (Number.isFinite(hint) && hint >= 0) this.retryAfter.set(error, hint * 1000);
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
      let text: string;
      try { text = await this.readBounded(response); }
      catch (error) { if (error instanceof ProviderError) throw error; if (signal?.aborted) throw new CancelledError(); throw new ProviderError(timedOut ? 'Model request timed out' : 'Model response interrupted', true); }
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new MDBError('INVALID_MODEL_OUTPUT', 'Model endpoint returned a non-JSON response'); }
      const choice = (data as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] })?.choices?.[0];
      const raw = choice?.message?.content;
      // Some servers return content as an array of {type:'text', text} parts.
      const content = typeof raw === 'string' ? raw : Array.isArray(raw) && raw.every(part => part && typeof (part as { text?: unknown }).text === 'string') ? raw.map(part => (part as { text: string }).text).join('') : undefined;
      if (!choice || content === undefined) throw new MDBError('INVALID_MODEL_OUTPUT', 'Model response had no message content');
      if (choice.finish_reason === 'length') throw new MDBError('INVALID_MODEL_OUTPUT', 'Model output was truncated by the token limit');
      return content;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }

  private httpError(status: number): ProviderError {
    if (status === 401 || status === 403) return new ProviderError('Model provider rejected the credentials', false, status);
    if (status === 404) return new ProviderError('Model endpoint or model name not found', false, status);
    if (status === 408 || status === 429 || status >= 500) return new ProviderError(`Model provider returned HTTP ${status}`, true, status);
    return new ProviderError(`Model provider rejected the request (HTTP ${status})`, false, status);
  }

  private async readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new ProviderError('Model response exceeded the size limit', false); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
