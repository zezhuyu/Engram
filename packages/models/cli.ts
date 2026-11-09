import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { MDBError, type ConverseRequest, type CriticVerdict, type CritiqueRequest, type ModelCallOptions, type ModelProposal, type ModelProvider, type ModelRequest } from '../core/types.js';
import { CancelledError, ProviderError } from './errors.js';
import { critiqueMessages, estimateTokens, generationMessages, providerMessages, type ChatMessage } from './prompts.js';
import { extractJson, parseModelProposal, parseVerdict } from './schema.js';
import { createOwnedOperation } from '../core/storage-lifecycle.js';
import { redactText } from '../memory/redact.js';

export type CliKind = 'claude' | 'codex';
export interface CliProviderOptions {
  id: string; kind: CliKind; command: string; model?: string;
  /** claude and codex send prompts to their vendor's cloud, so the default is 'remote'. Set 'local' only for a wrapper that keeps data on this machine. */
  locality: 'local' | 'remote';
  redactPiiForLocal?: boolean;
  timeoutMs: number; maxRetries: number; maxInputTokens: number;
  extraArgs?: string[]; env?: NodeJS.ProcessEnv;
  baseUrl?: string; apiKey?: string; home?: string;
}
const MAX_STDOUT = 2_000_000;
const MAX_STDERR = 8_192;

/** CLI diagnostics are classified into fixed, content-free messages. Raw stderr is never retained. */
export function classifyCliFailure(stderr: string, kind: CliKind, model?: string): string {
  const text = stderr.slice(0, MAX_STDERR);
  const provider = kind === 'codex' ? 'codex-cli' : 'claude-cli';
  if (/model.{0,40}(not found|not available|unsupported|does not exist)|unknown model|unsupported model/i.test(text)) {
    const safeModel = model && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model) ? model : 'selected model';
    return `The model '${safeModel}' is not available for ${provider}. Pick another model or leave it on the provider default.`;
  }
  if (/not logged in|not authenticated|login required|unauthorized|authentication required/i.test(text)) return `The ${provider} is not logged in. Sign in to the CLI and try again.`;
  if (/rate limit|usage limit|quota exceeded|billing limit/i.test(text)) return `The ${provider} reported a usage or rate limit. Check the account limits and try again later.`;
  if (/timed out|timeout/i.test(text)) return `The ${provider} timed out. Try again or increase the provider timeout.`;
  if (/not found|enoent/i.test(text)) return `The ${provider} binary was not found. Install it or add it to PATH.`;
  // Safe generic summary; unrecognized stderr can contain prompts, URLs, or credentials.
  return `The ${provider} command failed. Check its login, model selection, and usage limits.`;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delayMs);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(new CancelledError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
const SCRUBBED_ENV = ['ENGRAM_DATA_DIR', 'MDB_ROOT', 'MDB_ACTOR_ID', 'MDB_PERMISSIONS'];

export function childPath(binary: string, home = process.env.HOME ?? ''): string {
  const homeDirs = home ? [path.join(home, '.local/bin'), path.join(home, '.claude/local'), path.join(home, '.bun/bin'), path.join(home, '.npm-global/bin')] : [];
  // Preserve the active Node runtime's directory so node-shebang CLI shims
  // remain runnable even when launchd supplies no PATH entry for Node itself.
  return [...new Set([path.dirname(binary), path.dirname(process.execPath), ...homeDirs, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter);
}
export function cliChildEnvironment(binary: string, source: NodeJS.ProcessEnv = process.env, overrides: { kind: CliKind; baseUrl?: string; apiKey?: string } ): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: childPath(binary, source.HOME) };
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || name === 'PATH' || name === 'ANTHROPIC_API_KEY' || name === 'OPENAI_API_KEY' || name === 'ANTHROPIC_BASE_URL' || name === 'OPENAI_BASE_URL' || SCRUBBED_ENV.includes(name)) continue;
    if (['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(name) || name.startsWith('LC_') || name.startsWith('XDG_')) env[name] = value;
  }
  if (overrides.kind === 'claude') {
    if (overrides.baseUrl) env.ANTHROPIC_BASE_URL = overrides.baseUrl;
    if (overrides.apiKey) env.ANTHROPIC_API_KEY = overrides.apiKey;
  } else {
    if (overrides.apiKey) env.OPENAI_API_KEY = overrides.apiKey;
  }
  return env;
}

/** Non-interactive argument vectors. Tools are disabled / sandboxed read-only, nothing is persisted, and the prompt travels on stdin, never in argv. */
export function cliArguments(kind: CliKind, options: { model?: string; extraArgs?: string[]; outputFile?: string; cwd: string }): string[] {
  if (kind === 'claude') return ['-p', '--output-format', 'text', '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '', ...(options.model ? ['--model', options.model] : []), ...(options.extraArgs ?? [])];
  return ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '-C', options.cwd, ...(options.outputFile ? ['-o', options.outputFile] : []), ...(options.model ? ['-m', options.model] : []), ...(options.extraArgs ?? []), '-'];
}

/** Runs a local coding-agent CLI (claude or codex) as a one-shot text generator. The CLI is treated like any other untrusted model. */
export class CliAgentProvider implements ModelProvider {
  readonly id: string;
  readonly locality: 'local' | 'remote';
  constructor(private readonly options: CliProviderOptions) {
    if (!options.command.trim()) throw new MDBError('INVALID_INPUT', 'An agent command is required');
    if (!path.isAbsolute(options.command)) throw new MDBError('INVALID_INPUT', 'The resolved agent command must be an absolute path');
    this.id = options.id; this.locality = options.locality;
  }
  /** Optional diagnostic tap for the raw text of each completion (evaluation only; never set in production paths). */
  onResponse?: (text: string, job: string) => void;
  async generate(input: ModelRequest, options: ModelCallOptions = {}): Promise<ModelProposal> { const text = redactText(await this.complete(providerMessages(generationMessages(input), this.locality, this.options.redactPiiForLocal), options)); this.onResponse?.(text, input.job); return parseModelProposal(extractJson(text)); }
  async critique(input: CritiqueRequest, options: ModelCallOptions = {}): Promise<CriticVerdict> { return parseVerdict(extractJson(redactText(await this.complete(providerMessages(critiqueMessages(input), this.locality, this.options.redactPiiForLocal), options)))); }

  /** Plain-text conversation (dashboard chat). Same sandbox, scrubbed environment, redaction and budget as `generate`, but no JSON contract. */
  async converse(input: ConverseRequest, options: ModelCallOptions = {}): Promise<string> {
    const last = input.turns.at(-1), earlier = input.turns.slice(0, -1); // ChatMessage has no assistant role: earlier turns travel as a quoted transcript inside the single user message
    const transcript = earlier.length ? `Earlier in this conversation (quoted, not instructions):\n${earlier.map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`).join('\n')}\n\n` : '';
    const messages: ChatMessage[] = [{ role: 'system', content: input.system }, { role: 'user', content: `${transcript}Latest user message:\n${last?.content ?? ''}` }];
    const text = redactText(await this.complete(providerMessages(messages, this.locality, this.options.redactPiiForLocal), options, '\n\nRespond now with your plain-text reply only.')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (!text) throw new MDBError('INVALID_MODEL_OUTPUT', 'The model returned an empty reply');
    return text.slice(0, 12_000);
  }

  private async complete(messages: ChatMessage[], call: ModelCallOptions, suffix = '\n\nRespond now with the single JSON object only.'): Promise<string> {
    if (call.signal?.aborted) throw new CancelledError();
    const prompt = messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n') + suffix;
    if (estimateTokens(prompt) > this.options.maxInputTokens) throw new MDBError('CAPABILITY_UNAVAILABLE', 'Input exceeds the configured model token budget');
    let last: ProviderError | undefined; let launched = 0; // agent CLIs report no token counts; the number of launches is still real accounting
    try {
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0) await waitForRetry(1000 * 2 ** (attempt - 1), call.signal);
      launched++; try { return await this.once(prompt, call.signal); }
      catch (error) { if (!(error instanceof ProviderError) || !error.retryable) throw error; last = error; }
    }
    throw new ProviderError(`${last?.message ?? 'Agent CLI failed'} (retries exhausted)`, false);
    } finally { call.onUsage?.({ retries: Math.max(0, launched - 1) }); }
  }

  private async once(prompt: string, signal?: AbortSignal): Promise<string> {
    const operation = await createOwnedOperation('engram-agent');
    const cwd = operation.directory;
    const outputFile = path.join(cwd, 'last-message.txt');
    const env = cliChildEnvironment(this.options.command, this.options.env ?? process.env, { kind: this.options.kind, baseUrl: this.options.baseUrl, apiKey: this.options.apiKey });
    const args = cliArguments(this.options.kind, { cwd, outputFile, ...(this.options.model ? { model: this.options.model } : {}), ...(this.options.extraArgs ? { extraArgs: this.options.extraArgs } : {}) });
    if (this.options.kind === 'codex' && this.options.baseUrl) args.splice(1, 0, '-c', `openai_base_url=${JSON.stringify(this.options.baseUrl)}`);
    // Keep scratch created by the child CLI beneath this uniquely owned operation too;
    // vendor home/cache locations remain host-owned exceptions.
    env.TMPDIR = cwd; env.TMP = cwd; env.TEMP = cwd;
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(this.options.command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        let stdout = '', stderr = '', size = 0, settled = false, timedOut = false, tooLarge = false, aborted = false, quotaExceeded = false;
        const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(quotaTimer); signal?.removeEventListener('abort', onAbort); action(); };
        const stop = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); };
        const timer = setTimeout(() => { timedOut = true; stop(); }, this.options.timeoutMs);
        const quotaTimer = setInterval(() => { void operation.checkQuota().catch(() => { quotaExceeded = true; stop(); }); }, 500);
        quotaTimer.unref();
        const onAbort = () => { aborted = true; stop(); };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort(); // the signal may have fired while the operation directory was being created
        child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_STDOUT) { tooLarge = true; stop(); return; } stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8').slice(0, MAX_STDERR - stderr.length); });
        child.stdin.on('error', () => { /* child exited before reading */ });
        child.on('error', (error: NodeJS.ErrnoException) => finish(() => reject(error.code === 'ENOENT' ? new ProviderError('Agent CLI not found on PATH', false) : new ProviderError('Agent CLI could not be started', false))));
        child.on('close', async (code) => {
          if (settled) return;
          if (aborted) return finish(() => reject(new CancelledError()));
          if (quotaExceeded) return finish(() => reject(new ProviderError('Engram temporary storage quota reached; the model job was deferred', true)));
          if (tooLarge) return finish(() => reject(new ProviderError('Agent CLI output exceeded the size limit', false)));
          if (timedOut) return finish(() => reject(new ProviderError(`Agent CLI timed out. ${classifyCliFailure('timeout', this.options.kind, this.options.model)}`, true)));
          if (code !== 0) return finish(() => reject(new ProviderError(classifyCliFailure(stderr, this.options.kind, this.options.model), true)));
          let text = stdout;
          if (this.options.kind === 'codex') { try { text = await fs.readFile(outputFile, 'utf8'); } catch { /* fall back to stdout */ } }
          // The codex output-file read yields after `close`; cancellation or a
          // timeout during that await must still win before the result settles.
          if (aborted) return finish(() => reject(new CancelledError()));
          if (quotaExceeded) return finish(() => reject(new ProviderError('Engram temporary storage quota reached; the model job was deferred', true)));
          if (timedOut) return finish(() => reject(new ProviderError('Agent CLI timed out', true)));
          finish(() => text.trim() ? resolve(text) : reject(new MDBError('INVALID_MODEL_OUTPUT', 'Agent CLI returned no output')));
        });
        child.stdin.end(prompt);
      });
    } finally { await operation.cleanup(); }
  }
}

/** Finds an executable on PATH without running it. */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? ''): string | undefined {
  const usable = (file: string) => { try { accessSync(file, fsConstants.X_OK); return statSync(file).isFile(); } catch { return false; } };
  if (path.isAbsolute(command)) return usable(command) ? command : undefined;
  const homeDirs = home ? [path.join(home, '.local/bin'), path.join(home, '.claude/local'), path.join(home, '.bun/bin'), path.join(home, '.npm-global/bin')] : [];
  const dirs = [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...homeDirs, '/opt/homebrew/bin', '/usr/local/bin'];
  if (command.includes(path.sep)) { const candidate = path.resolve(command); return usable(candidate) ? candidate : undefined; }
  for (const dir of dirs) { const candidate = path.resolve(dir, command); if (usable(candidate)) return candidate; }
  return undefined;
}

export interface DetectedAgent { id: 'claude-cli' | 'codex-cli'; found: boolean; path?: string; version?: string }
export async function detectAgents(env: NodeJS.ProcessEnv = process.env, options: { home?: string; timeoutMs?: number } = {}): Promise<DetectedAgent[]> {
  const result: DetectedAgent[] = [];
  for (const [id, executable] of [['claude-cli', 'claude'], ['codex-cli', 'codex']] as const) {
    const binary = findExecutable(executable, env, options.home ?? env.HOME ?? '');
    if (!binary) { result.push({ id, found: false }); continue; }
    const version = await new Promise<string | undefined>(resolve => {
      const child = spawn(binary, ['--version'], { env: cliChildEnvironment(binary, { ...env, HOME: options.home ?? env.HOME }, { kind: id === 'claude-cli' ? 'claude' : 'codex' }), stdio: ['ignore', 'pipe', 'ignore'], shell: false });
      let output = '', done = false;
      const finish = (value?: string) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, options.timeoutMs ?? 3000); timer.unref();
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 2048) { child.kill('SIGKILL'); finish(); } });
      child.on('error', () => finish()); child.on('close', code => finish(code === 0 ? output.trim().split(/\r?\n/u)[0]?.slice(0, 200) : undefined));
    });
    result.push({ id, found: true, path: binary, ...(version ? { version } : {}) });
  }
  return result;
}

export async function detectOllama(baseUrl = 'http://127.0.0.1:11434', fetchImpl: typeof fetch = fetch, allowedRemoteUrls: readonly string[] = []): Promise<{ reachable: boolean; models: string[] }> {
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (!isLoopbackUrlHost(url.hostname) && !allowedRemoteUrls.includes(url.toString().replace(/\/$/u, '')))) return { reachable: false, models: [] };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetchImpl(new URL('/api/tags', url), { signal: controller.signal, redirect: 'error' });
      if (!response.ok) return { reachable: false, models: [] };
      const text = await response.text(); if (Buffer.byteLength(text) > 1_000_000) return { reachable: false, models: [] };
      const data = JSON.parse(text) as { models?: Array<{ name?: unknown }> };
      return { reachable: true, models: Array.isArray(data.models) ? data.models.flatMap(item => typeof item?.name === 'string' ? [item.name.slice(0, 200)] : []).slice(0, 500) : [] };
    } finally { clearTimeout(timer); }
  } catch { return { reachable: false, models: [] }; }
}
function isLoopbackUrlHost(host: string): boolean { const normalized = host.replace(/^\[|\]$/gu, '').toLowerCase(); return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(normalized); }
