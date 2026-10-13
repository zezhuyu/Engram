import { MDBError, type Document, type ModelConfig, type ModelProvider, type VaultConfig } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { CLI_AGENTS, PROVIDER_NAMES, createProviderFromConfig, describeModel, effectiveProvider, isBuiltinProvider } from './factory.js';

/** Fields that only make sense for an OpenAI-compatible API, and fields that only make sense for a local agent CLI. Switching kind drops the other kind's fields so stale settings cannot leak. */
const API_ONLY = ['baseUrl', 'apiKeyEnv', 'maxOutputTokens'] as const;
const CLI_ONLY = ['command'] as const;
const FUNCTIONS = ['user insight and interest collection (profile)', 'dream', 'wiki / memory / reflect jobs', 'project insight relevance ranking'];

export interface ModelSetInput {
  provider?: string | null; localAgent?: 'claude' | 'codex' | 'auto'; api?: string; modelName?: string; baseUrl?: string; apiKeyEnv?: string; command?: string;
  allowNetwork?: boolean; allowPrivateContentToRemote?: boolean; timeoutMs?: number; maxOutputTokens?: number; maxInputTokens?: number; locality?: 'local' | 'remote'; check?: boolean;
}

export const providerKind = (name: string | null): 'none' | 'local agent CLI' | 'OpenAI-compatible API' | 'custom (SDK-supplied)' =>
  !name ? 'none' : (CLI_AGENTS as readonly string[]).includes(name) || name === 'auto' ? 'local agent CLI' : isBuiltinProvider(name) ? 'OpenAI-compatible API' : 'custom (SDK-supplied)';

/** Read-only, offline: never calls a model or the network and never discloses a key value (only the variable name and whether it is set). */
export function showModel(config: VaultConfig, env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const model = config.model, effective = effectiveProvider(model, env), overridden = !!env.ENGRAM_MODEL_PROVIDER?.trim() && env.ENGRAM_MODEL_PROVIDER.trim() !== model.provider;
  const state = describeModel(model, env);
  return {
    kind: providerKind(effective), provider: effective, configuredProvider: model.provider, overriddenByEnvironment: overridden, available: state.available, ...(state.locality ? { locality: state.locality } : {}), ...(state.reason ? { reason: state.reason } : {}),
    ...(model.modelName ? { modelName: model.modelName } : {}), ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}), ...(model.command ? { command: model.command } : {}),
    ...(model.apiKeyEnv ? { apiKeyEnv: model.apiKeyEnv, apiKeySet: !!env[model.apiKeyEnv] } : {}),
    allowNetwork: model.allowNetwork, allowPrivateContentToRemote: !!model.allowPrivateContentToRemote,
    privateContentGate: state.locality === 'remote' && !model.allowPrivateContentToRemote ? 'workspace content is NOT sent to this provider (jobs on private workspaces refuse; relevance ranking is skipped)' : 'open for this provider',
    usedFor: effective ? FUNCTIONS : [], providers: [...PROVIDER_NAMES, 'none']
  };
}

/** Pure config transformation (no I/O) so it is testable and shared by the CLI, SDK and doctor. */
export function applyModelSet(current: ModelConfig, input: ModelSetInput): ModelConfig {
  const next: ModelConfig = { ...current };
  let provider = input.provider;
  if (input.localAgent !== undefined && input.api !== undefined) throw new MDBError('INVALID_INPUT', '--local-agent and --api are mutually exclusive');
  if (input.localAgent !== undefined) { if (!['claude', 'codex', 'auto'].includes(input.localAgent)) throw new MDBError('INVALID_INPUT', '--local-agent must be claude, codex or auto'); provider = input.localAgent === 'auto' ? 'auto' : `${input.localAgent}-cli`; }
  if (input.api !== undefined) { provider ??= /api\.openai\.com/.test(input.api) ? 'openai' : /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):11434/.test(input.api) ? 'ollama' : 'openai-compatible'; next.baseUrl = input.api; }
  if (provider !== undefined) {
    if (provider === 'none' || provider === null) next.provider = null;
    else if (!(PROVIDER_NAMES as readonly string[]).includes(provider)) throw new MDBError('INVALID_INPUT', `Unknown provider "${provider}"; use ${[...PROVIDER_NAMES, 'none'].join(', ')}`);
    else next.provider = provider;
    const kind = providerKind(next.provider), previous = providerKind(current.provider);
    if (kind !== previous && kind !== 'none') for (const key of kind === 'local agent CLI' ? API_ONLY : CLI_ONLY) delete next[key];
    if (kind !== previous || next.provider !== current.provider) { delete next.modelName; if (kind === 'local agent CLI') { next.allowNetwork = false; delete next.locality; } }
  }
  if (input.modelName !== undefined) next.modelName = input.modelName;
  if (input.baseUrl !== undefined) next.baseUrl = input.baseUrl;
  if (input.apiKeyEnv !== undefined) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.apiKeyEnv)) throw new MDBError('INVALID_INPUT', '--api-key-env must be an environment variable NAME (keys are never stored in the vault)'); next.apiKeyEnv = input.apiKeyEnv; }
  if (input.command !== undefined) next.command = input.command;
  if (input.allowNetwork !== undefined) next.allowNetwork = input.allowNetwork;
  if (input.allowPrivateContentToRemote !== undefined) next.allowPrivateContentToRemote = input.allowPrivateContentToRemote;
  if (input.timeoutMs !== undefined) next.timeoutMs = input.timeoutMs;
  if (input.maxOutputTokens !== undefined) next.maxOutputTokens = input.maxOutputTokens;
  if (input.maxInputTokens !== undefined) next.maxInputTokens = input.maxInputTokens;
  if (input.locality !== undefined) next.locality = input.locality;
  if (providerKind(next.provider) === 'local agent CLI') for (const key of API_ONLY) if (next[key] !== undefined) throw new MDBError('INVALID_INPUT', `--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())} applies to an OpenAI-compatible API, not a local agent CLI`);
  if (providerKind(next.provider) === 'OpenAI-compatible API') for (const key of CLI_ONLY) if (next[key] !== undefined) throw new MDBError('INVALID_INPUT', `--${key} applies to a local agent CLI, not an API`);
  return next;
}

/** Validates (builds the provider without calling it) and writes through the vault's owner-only, locked setConfig. */
export async function setModel(vault: Vault, input: ModelSetInput, env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown>> {
  const before = (await vault.config()).model, next = applyModelSet(before, input);
  if (input.check !== false && next.provider) {
    try { createProviderFromConfig(next, { ...env, ENGRAM_MODEL_PROVIDER: '' }); }
    catch (error) { throw new MDBError(error instanceof MDBError ? error.code : 'INVALID_INPUT', `Model config not saved: ${(error as Error).message} (use --no-check to save anyway)`); }
  }
  const saved = await vault.setConfig(config => { config.model = next; });
  return showModel(saved, env);
}

/** Synthetic evidence: the check needs something citable, and it must never be vault content. */
const TEST_DOCUMENT: Document = { id: 'obj_model_test', revisionId: 'rev_model_test', revisionNumber: 1, scope: { type: 'global', area: 'wiki' }, kind: 'source', title: 'Connectivity check', body: 'This is a synthetic connectivity check. The word to report is: ok.', tags: [], links: [], evidence: [], status: 'candidate', createdAt: '', updatedAt: '', createdBy: 'owner', metadata: {}, path: 'model-test', uri: 'mdb://wiki/objects/obj_model_test' };
const TEST_INSTRUCTION = 'Connectivity check. Reply with exactly one proposal of kind "note" titled "ok" whose body is the single word ok, citing the provided document as evidence. Use no outside information.';

/** Explicit, owner-invoked only. Sends one synthetic prompt containing no vault content. */
export async function testModel(provider: ModelProvider | undefined, config: VaultConfig, env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown>> {
  if (!provider) throw new MDBError('CAPABILITY_UNAVAILABLE', `No usable model provider (${describeModel(config.model, env).reason ?? 'unconfigured'})`);
  const started = Date.now();
  try {
    const result = await provider.generate({ job: 'model-test', documents: [TEST_DOCUMENT], goals: 'connectivity check', instruction: TEST_INSTRUCTION }, { maxOutputTokens: 200 });
    return { ok: true, provider: provider.id, locality: provider.locality ?? 'local', latencyMs: Date.now() - started, replyKind: result.kind, sentVaultContent: false };
  } catch (error) { return { ok: false, provider: provider.id, locality: provider.locality ?? 'local', latencyMs: Date.now() - started, error: (error as Error).message, sentVaultContent: false }; }
}
