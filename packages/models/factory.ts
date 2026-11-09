import { MDBError, type ModelConfig, type ModelProvider } from '../core/types.js';
import { isLoopbackHost, OpenAICompatibleProvider } from './openai.js';

import { CliAgentProvider, findExecutable, type CliKind } from './cli.js';
import { readSecret } from '../core/secret-store.js';

export const CLI_AGENTS = ['claude-cli', 'codex-cli'] as const;
export const PROVIDER_NAMES = ['auto', ...CLI_AGENTS, 'openai', 'ollama', 'openai-compatible'] as const;
export const MODEL_DEFAULTS = { timeoutMs: 60_000, maxRetries: 2, maxInputTokens: 12_000, maxOutputTokens: 4_000 };
const CLI_DEFAULTS = { timeoutMs: 180_000, maxRetries: 1 };
const CLI_COMMAND: Record<(typeof CLI_AGENTS)[number], CliKind> = { 'claude-cli': 'claude', 'codex-cli': 'codex' };

function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new MDBError('INVALID_INPUT', `model.${name} must be an integer in ${min}..${max}`);
  return value;
}
export const isBuiltinProvider = (name: string | null | undefined): boolean => !!name && (PROVIDER_NAMES as readonly string[]).includes(name);
/** The environment variable ENGRAM_MODEL_PROVIDER overrides mdb.yaml so a user can swap backends without editing the vault. */
export const effectiveProvider = (config: ModelConfig, env: Record<string, string | undefined> = process.env): string | null => (env.ENGRAM_MODEL_PROVIDER?.trim() || config.provider) ?? null;

function resolveAuto(env: Record<string, string | undefined>): (typeof CLI_AGENTS)[number] {
  for (const name of CLI_AGENTS) if (findExecutable(CLI_COMMAND[name], env)) return name;
  throw new MDBError('CAPABILITY_UNAVAILABLE', 'No local agent CLI (claude, codex) found on PATH; install one, or set model.provider to openai, ollama or openai-compatible');
}

/**
 * Builds the configured backend. Default `auto` prefers a local agent CLI (claude, then codex); `openai`, `ollama` and
 * `openai-compatible` use an OpenAI chat-completions HTTP API. Agent CLIs send prompts to their vendor and are always remote.
 * API keys resolve from the private secret store first, then the configured environment variable.
 */
export function createProviderFromConfig(config: ModelConfig, env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): ModelProvider {
  let name = effectiveProvider(config, env);
  if (!isBuiltinProvider(name)) throw new MDBError('CAPABILITY_UNAVAILABLE', 'No built-in model provider is configured (use auto, claude-cli, codex-cli, openai, ollama or openai-compatible, or supply a provider through the SDK)');
  if (name === 'auto') name = resolveAuto(env);
  if ((CLI_AGENTS as readonly string[]).includes(name!)) {
    const kind = CLI_COMMAND[name as (typeof CLI_AGENTS)[number]];
    const command = config.command ?? kind;
    const resolved = findExecutable(command, env);
    if (!resolved) throw new MDBError('CAPABILITY_UNAVAILABLE', `Agent CLI "${command}" was not found on PATH`);
    if (config.baseUrl) {
      let url: URL;
      try { url = new URL(config.baseUrl); } catch { throw new MDBError('INVALID_INPUT', 'model.baseUrl must be a valid endpoint URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (!isLoopbackHost(url.hostname) && url.protocol !== 'https:')) {
        throw new MDBError('INVALID_INPUT', 'model.baseUrl must be an http or https endpoint without credentials, query, or fragment');
      }
    }
    return new CliAgentProvider({
      id: `${name}${config.modelName ? ':' + config.modelName : ''}`, kind, command: resolved, ...(config.modelName ? { model: config.modelName } : {}), locality: 'remote',
      redactPiiForLocal: config.redactPiiForLocal,
      baseUrl: config.baseUrl, apiKey: resolveApiKey(config, env, false), home: env.HOME,
      timeoutMs: bounded(config.timeoutMs, CLI_DEFAULTS.timeoutMs, 100, 1_800_000, 'timeoutMs'), maxRetries: bounded(config.maxRetries, CLI_DEFAULTS.maxRetries, 0, 4, 'maxRetries'),
      maxInputTokens: bounded(config.maxInputTokens, MODEL_DEFAULTS.maxInputTokens, 500, 200_000, 'maxInputTokens'), env: env as NodeJS.ProcessEnv
    });
  }
  const baseUrl = config.baseUrl ?? (name === 'ollama' ? 'http://127.0.0.1:11434/v1' : name === 'openai' ? 'https://api.openai.com/v1' : undefined);
  if (!baseUrl) throw new MDBError('INVALID_INPUT', 'model.baseUrl is required for openai-compatible providers');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new MDBError('INVALID_INPUT', 'model.baseUrl is not a valid URL'); }
  const locality = isLoopbackHost(url.hostname) ? 'local' : 'remote';
  if (locality === 'remote' && !config.allowNetwork) throw new MDBError('CAPABILITY_UNAVAILABLE', 'Remote model endpoint requires model.allowNetwork: true');
  if (!config.modelName) throw new MDBError('INVALID_INPUT', 'model.modelName is required');
  const keyName = config.apiKeyEnv ?? (name === 'openai' ? 'OPENAI_API_KEY' : undefined);
  const apiKey = resolveApiKey(config, env, name === 'openai');
  if (name === 'openai' && !apiKey) throw new MDBError('CAPABILITY_UNAVAILABLE', `Environment variable ${keyName} is not set`);
  if (config.apiKeyEnv && !apiKey) throw new MDBError('CAPABILITY_UNAVAILABLE', `Environment variable ${config.apiKeyEnv} is not set`);
  return new OpenAICompatibleProvider({
    id: `${name}:${config.modelName}`, baseUrl, model: config.modelName, ...(apiKey ? { apiKey } : {}), locality, redactPiiForLocal: config.redactPiiForLocal,
    timeoutMs: bounded(config.timeoutMs, MODEL_DEFAULTS.timeoutMs, 100, 600_000, 'timeoutMs'),
    maxRetries: bounded(config.maxRetries, MODEL_DEFAULTS.maxRetries, 0, 6, 'maxRetries'),
    maxInputTokens: bounded(config.maxInputTokens, MODEL_DEFAULTS.maxInputTokens, 500, 200_000, 'maxInputTokens'),
    maxOutputTokens: bounded(config.maxOutputTokens, MODEL_DEFAULTS.maxOutputTokens, 50, 32_000, 'maxOutputTokens'),
    ...(fetchImpl ? { fetch: fetchImpl } : {})
  });
}

export function resolveApiKey(config: Pick<ModelConfig, 'apiKeyRef' | 'apiKeyEnv'>, env: Record<string, string | undefined> = process.env, required = false): string | undefined {
  const secret = config.apiKeyRef ? readSecret(config.apiKeyRef, { env: env as NodeJS.ProcessEnv }) : undefined;
  const key = secret ?? (config.apiKeyEnv ? env[config.apiKeyEnv] : required ? env.OPENAI_API_KEY : undefined);
  if (required && !key) throw new MDBError('CAPABILITY_UNAVAILABLE', `Environment variable ${config.apiKeyEnv ?? 'OPENAI_API_KEY'} is not set`);
  if (config.apiKeyEnv && !key) throw new MDBError('CAPABILITY_UNAVAILABLE', `Environment variable ${config.apiKeyEnv} is not set`);
  return key;
}

/** Describes provider readiness without running a model, making a network call, or disclosing credentials. */
export function describeModel(config: ModelConfig, env: Record<string, string | undefined> = process.env): { configured: boolean; available: boolean; provider?: string; locality?: 'local' | 'remote'; reason?: string } {
  const name = effectiveProvider(config, env);
  if (!name) return { configured: false, available: false, reason: 'No model provider configured; deterministic maintenance only' };
  if (!isBuiltinProvider(name)) return { configured: true, available: false, provider: name, reason: 'Not a built-in provider; the trusted host must supply it through the SDK' };
  try { const provider = createProviderFromConfig(config, env); return { configured: true, available: true, provider: provider.id, ...(provider.locality ? { locality: provider.locality } : {}), reason: name === 'auto' ? 'Auto-selected local agent CLI; it was found on PATH but not run' : 'Configured; reachability is not checked by doctor' }; }
  catch (error) { return { configured: true, available: false, provider: name, reason: (error as Error).message }; }
}
