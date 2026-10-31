import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { MDBError, type CriticVerdict, type CritiqueRequest, type ModelCallOptions, type ModelProposal, type ModelProvider, type ModelRequest } from '../core/types.js';
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
}
const MAX_STDOUT = 2_000_000;
const SCRUBBED_ENV = ['ENGRAM_DATA_DIR', 'MDB_ROOT', 'MDB_ACTOR_ID', 'MDB_PERMISSIONS'];

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
    this.id = options.id; this.locality = options.locality;
  }
  /** Optional diagnostic tap for the raw text of each completion (evaluation only; never set in production paths). */
  onResponse?: (text: string, job: string) => void;
  async generate(input: ModelRequest, options: ModelCallOptions = {}): Promise<ModelProposal> { const text = redactText(await this.complete(providerMessages(generationMessages(input), this.locality, this.options.redactPiiForLocal), options)); this.onResponse?.(text, input.job); return parseModelProposal(extractJson(text)); }
  async critique(input: CritiqueRequest, options: ModelCallOptions = {}): Promise<CriticVerdict> { return parseVerdict(extractJson(redactText(await this.complete(providerMessages(critiqueMessages(input), this.locality, this.options.redactPiiForLocal), options)))); }

  private async complete(messages: ChatMessage[], call: ModelCallOptions): Promise<string> {
    if (call.signal?.aborted) throw new CancelledError();
    const prompt = messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n') + '\n\nRespond now with the single JSON object only.';
    if (estimateTokens(prompt) > this.options.maxInputTokens) throw new MDBError('CAPABILITY_UNAVAILABLE', 'Input exceeds the configured model token budget');
    let last: ProviderError | undefined; let launched = 0; // agent CLIs report no token counts; the number of launches is still real accounting
    try {
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 1000 * 2 ** (attempt - 1)); call.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new CancelledError()); }, { once: true }); });
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
    const env = { ...(this.options.env ?? process.env) }; for (const name of SCRUBBED_ENV) delete env[name];
    // Keep scratch created by the child CLI beneath this uniquely owned operation too;
    // vendor home/cache locations remain host-owned exceptions.
    env.TMPDIR = cwd; env.TMP = cwd; env.TEMP = cwd;
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(this.options.command, cliArguments(this.options.kind, { cwd, outputFile, ...(this.options.model ? { model: this.options.model } : {}), ...(this.options.extraArgs ? { extraArgs: this.options.extraArgs } : {}) }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        let stdout = '', size = 0, settled = false, timedOut = false, tooLarge = false, aborted = false, quotaExceeded = false;
        const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(quotaTimer); signal?.removeEventListener('abort', onAbort); action(); };
        const stop = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); };
        const timer = setTimeout(() => { timedOut = true; stop(); }, this.options.timeoutMs);
        const quotaTimer = setInterval(() => { void operation.checkQuota().catch(() => { quotaExceeded = true; stop(); }); }, 500);
        quotaTimer.unref();
        const onAbort = () => { aborted = true; stop(); };
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_STDOUT) { tooLarge = true; stop(); return; } stdout += chunk.toString('utf8'); });
        child.stderr.on('data', () => { /* never stored or surfaced: it may echo prompts */ });
        child.stdin.on('error', () => { /* child exited before reading */ });
        child.on('error', (error: NodeJS.ErrnoException) => finish(() => reject(error.code === 'ENOENT' ? new ProviderError('Agent CLI not found on PATH', false) : new ProviderError('Agent CLI could not be started', false))));
        child.on('close', async (code) => {
          if (settled) return;
          if (aborted) return finish(() => reject(new CancelledError()));
          if (quotaExceeded) return finish(() => reject(new ProviderError('Engram temporary storage quota reached; the model job was deferred', true)));
          if (tooLarge) return finish(() => reject(new ProviderError('Agent CLI output exceeded the size limit', false)));
          if (timedOut) return finish(() => reject(new ProviderError('Agent CLI timed out', true)));
          if (code !== 0) return finish(() => reject(new ProviderError(`Agent CLI exited with status ${code}`, true)));
          let text = stdout;
          if (this.options.kind === 'codex') { try { text = await fs.readFile(outputFile, 'utf8'); } catch { /* fall back to stdout */ } }
          finish(() => text.trim() ? resolve(text) : reject(new MDBError('INVALID_MODEL_OUTPUT', 'Agent CLI returned no output')));
        });
        child.stdin.end(prompt);
      });
    } finally { await operation.cleanup(); }
  }
}

/** Finds an executable on PATH without running it. */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const usable = (file: string) => { try { accessSync(file, fsConstants.X_OK); return statSync(file).isFile(); } catch { return false; } };
  if (command.includes(path.sep)) return usable(command) ? command : undefined;
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) { const candidate = path.join(dir, command); if (usable(candidate)) return candidate; }
  return undefined;
}
