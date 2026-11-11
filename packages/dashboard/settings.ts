import { createHash } from 'node:crypto';
import type { Engram } from '../sdk/index.js';
import { setModel, applyModelSet, type ModelSetInput } from '../models/switch.js';
import type { AdaptiveConfig } from '../adaptive/types.js';
import type { DreamConfig, EmbeddingConfig } from '../core/types.js';
import { appendAudit } from './audit.js';
import { createProviderFromConfig, effectiveProvider, PROVIDER_NAMES } from '../models/factory.js';
import { isValidTimeZone, parseHHMM } from '../adaptive/clock.js';
import { looksSecret } from '../memory/redact.js';
import { hasSecret, secretVersion } from '../core/secret-store.js';
import { isRemoteProvider, modelConsent } from '../models/consent.js';

const forbidden = /^(acl|credentials|trust|env|bind)(\.|$)/i;
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const nullableText = (v: unknown, max = 200): boolean => v === null || text(v, max);
function displayBaseUrl(value: string | undefined): string {
  if (!value) return '';
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString().replace(/\/$/, ''); }
  catch { return '[invalid URL]'; }
}
function safeProvider(value: string | null): string | null {
  return value === null ? null : (PROVIDER_NAMES as readonly string[]).includes(value) ? value : 'unrecognized override';
}
export interface SettingValue { key: string; value: unknown; risk: 'normal' | 'sensitive'; confirm?: string }

async function currentState(engram: Engram) {
  const [config, adaptive] = await Promise.all([engram.config(), engram.adaptive.store.config()]);
  return { config, adaptive };
}
export async function settingsEtag(engram: Engram): Promise<string> {
  const state = await currentState(engram);
  const modelSecret = secretVersion(state.config.model.apiKeyRef);
  const embeddingSecret = secretVersion(state.config.embedding?.apiKeyRef);
  return createHash('sha256').update(JSON.stringify({ ...state, modelSecret, embeddingSecret })).digest('hex');
}
export async function readSettings(engram: Engram) {
  const { config, adaptive } = await currentState(engram);
  const env = process.env;
  const modelOverride = env.ENGRAM_MODEL_PROVIDER?.trim();
  const privacy = modelConsent({ ...config.model, provider: effectiveProvider(config.model, env) });
  const settings = {
    'scheduler.enabled': adaptive.enabled, 'scheduler.paused': adaptive.paused, 'scheduler.mode': adaptive.mode,
    'scheduler.timezone': adaptive.timezone, 'scheduler.targetLocalTime': adaptive.targetLocalTime,
    'scheduler.quietStart': adaptive.quietStart, 'scheduler.quietEnd': adaptive.quietEnd, 'scheduler.micro.enabled': adaptive.micro.enabled,
    'dream.enabled': config.dream.enabled, 'dream.eventDriven': config.dream.eventDriven ?? true, 'dream.autoAccept': config.dream.autoAccept ?? false,
    'adaptive.autoAccept': adaptive.autoAccept, 'adaptive.workspaces.include': adaptive.workspaces.include, 'adaptive.workspaces.exclude': adaptive.workspaces.exclude,
    'model.provider': safeProvider(effectiveProvider(config.model, env)), 'model.modelName': config.model.modelName ?? '', 'model.baseUrl': displayBaseUrl(config.model.baseUrl), 'model.apiKeyEnv': config.model.apiKeyEnv ?? '', 'model.apiKeyRef': config.model.apiKeyRef ?? '',
    'model.apiKeySet': !!(config.model.apiKeyRef && hasSecret(config.model.apiKeyRef) || config.model.apiKeyEnv && env[config.model.apiKeyEnv] || !config.model.apiKeyEnv && effectiveProvider(config.model, env) === 'openai' && env.OPENAI_API_KEY),
    'model.apiKeySource': config.model.apiKeyRef && hasSecret(config.model.apiKeyRef) ? 'secret' : config.model.apiKeyEnv && env[config.model.apiKeyEnv] || effectiveProvider(config.model, env) === 'openai' && env.OPENAI_API_KEY ? 'env' : 'none',
    'model.allowNetwork': config.model.allowNetwork, 'model.allowPrivateContentToRemote': !!config.model.allowPrivateContentToRemote,
    'model.remote': privacy.remote, 'model.consentGiven': privacy.consentGiven,
    'embedding.provider': config.embedding?.provider ?? null, 'embedding.model': config.embedding?.model ?? '', 'embedding.baseUrl': displayBaseUrl(config.embedding?.baseUrl), 'embedding.apiKeyRef': config.embedding?.apiKeyRef ?? '', 'embedding.apiKeyEnv': config.embedding?.apiKeyEnv ?? '', 'embedding.apiKeySet': !!(config.embedding?.apiKeyRef && hasSecret(config.embedding.apiKeyRef) || config.embedding?.apiKeyEnv && env[config.embedding.apiKeyEnv]), 'embedding.apiKeySource': config.embedding?.apiKeyRef && hasSecret(config.embedding.apiKeyRef) ? 'secret' : config.embedding?.apiKeyEnv && env[config.embedding.apiKeyEnv] ? 'env' : 'none', 'embedding.allowNetwork': config.embedding?.allowNetwork ?? false, 'embedding.allowPrivateContentToRemote': !!config.embedding?.allowPrivateContentToRemote, 'embedding.dimensions': config.embedding?.dimensions ?? null, 'embedding.batchSize': config.embedding?.batchSize ?? 32,
  };
  return {
    etag: await settingsEtag(engram),
    settings,
    sources: Object.fromEntries(Object.keys(settings).map(key => [key, key === 'model.provider' && modelOverride ? 'env' : 'file'])),
    locks: { 'model.provider': modelOverride ? 'ENGRAM_MODEL_PROVIDER' : null },
    auditIsOnlyHistory: true,
  };
}
function validate(key: string, value: unknown): { value: unknown; risk: SettingValue['risk']; confirm?: string } {
  if (forbidden.test(key)) throw new Error('Setting is not editable');
  const sensitive = new Set(['adaptive.autoAccept', 'adaptive.workspaces.include', 'adaptive.workspaces.exclude', 'dream.autoAccept', 'model.provider', 'model.modelName', 'model.baseUrl', 'model.apiKeyEnv', 'model.apiKeyRef', 'model.allowNetwork', 'model.allowPrivateContentToRemote', 'embedding.provider', 'embedding.model', 'embedding.baseUrl', 'embedding.apiKeyEnv', 'embedding.apiKeyRef', 'embedding.allowNetwork', 'embedding.allowPrivateContentToRemote', 'embedding.dimensions', 'embedding.batchSize']);
  const schedulerBool = ['scheduler.enabled', 'scheduler.paused', 'scheduler.micro.enabled'];
  if (schedulerBool.includes(key) || ['dream.enabled', 'dream.eventDriven', 'dream.autoAccept'].includes(key)) { if (!bool(value)) throw new Error('Expected boolean'); }
  else if (key === 'scheduler.mode') { if (value !== 'adaptive' && value !== 'fixed') throw new Error('Invalid scheduler mode'); }
  else if (key === 'scheduler.timezone') { if (!text(value, 100) || !isValidTimeZone(value)) throw new Error('Expected a valid IANA time zone'); }
  else if (['scheduler.targetLocalTime', 'scheduler.quietStart', 'scheduler.quietEnd'].includes(key)) { if (!text(value, 5)) throw new Error('Expected HH:MM'); try { parseHHMM(value); } catch { throw new Error('Expected HH:MM'); } }
  else if (key === 'adaptive.autoAccept') { if (value !== 'none' && value !== 'low-risk') throw new Error('Invalid auto-accept mode'); }
  else if (key === 'adaptive.workspaces.include') { if (value !== null && (!Array.isArray(value) || value.some(v => !text(v, 100) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)))) throw new Error('Expected null or workspace id list'); }
  else if (key === 'adaptive.workspaces.exclude') { if (!Array.isArray(value) || value.some(v => !text(v, 100) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v))) throw new Error('Expected workspace id list'); }
  else if (key === 'model.provider') { if (!nullableText(value, 50) || (value !== null && (typeof value !== 'string' || !['none', 'openai', 'ollama', 'openai-compatible', 'claude-cli', 'codex-cli', 'auto'].includes(value)))) throw new Error('Unsupported model provider'); }
  else if (key === 'model.modelName') { if (value !== '' && (!text(value, 200) || looksSecret(value))) throw new Error('Invalid model name'); }
  else if (key === 'model.baseUrl') {
    if (value === '' || value === null) value = null;
    else { if (!text(value, 2048) || looksSecret(value)) throw new Error('Invalid base URL'); try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); } catch { throw new Error('Invalid base URL'); } }
  }
  else if (key === 'model.apiKeyEnv') { if (!text(value, 128) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Expected environment variable name, never a key value'); }
  else if (key === 'model.apiKeyRef' || key === 'embedding.apiKeyRef') { if (!text(value, 64) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error('Expected a secret reference name'); }
  else if (key === 'model.allowNetwork' || key === 'embedding.allowNetwork' || key === 'model.allowPrivateContentToRemote' || key === 'embedding.allowPrivateContentToRemote') { if (!bool(value)) throw new Error('Expected boolean'); }
  else if (key === 'embedding.baseUrl') { if (!text(value, 2048) || looksSecret(value)) throw new Error('Invalid base URL'); try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname))) throw new Error(); } catch { throw new Error('Invalid base URL'); } }
  else if (key === 'embedding.provider') { if (value !== null && !['openai', 'ollama', 'openai-compatible', 'builtin'].includes(String(value))) throw new Error('Unsupported embedding provider'); if (value === 'builtin') throw new Error('Select the built-in provider through the verified download and activation flow'); }
  else if (key === 'embedding.model') { if (value !== '' && (!text(value, 200) || looksSecret(value))) throw new Error('Invalid embedding model'); }
  else if (key === 'embedding.apiKeyEnv') { if (!text(value, 128) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Expected environment variable name, never a key value'); }
  else if (key === 'embedding.dimensions') { if (value !== null && (!Number.isInteger(value) || Number(value) < 8 || Number(value) > 8192)) throw new Error('Embedding dimensions must be an integer in 8..8192'); }
  else if (key === 'embedding.batchSize') { if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 256) throw new Error('Embedding batch size must be an integer in 1..256'); }
  else throw new Error('Setting is not editable');
  if (key.startsWith('model.') && (key === 'model.allowNetwork' || key === 'model.allowPrivateContentToRemote') && value === true) throw new Error('Remote model consent can only be granted through typed provider confirmation');
  if (sensitive.has(key) && ((key.endsWith('allowNetwork') || key === 'model.allowPrivateContentToRemote') ? value === true : true)) return { value, risk: 'sensitive', confirm: key.startsWith('adaptive.') || key === 'dream.autoAccept' ? 'accept semantic writes' : 'confirm sensitive setting' };
  return { value, risk: 'normal' };
}
async function write(engram: Engram, key: string, value: unknown, checkModel = true, modelName?: string): Promise<void> {
  if (key.startsWith('scheduler.') || key.startsWith('adaptive.')) {
    const patch: Partial<AdaptiveConfig> = {};
    if (key === 'scheduler.enabled') patch.enabled = value as boolean;
    else if (key === 'scheduler.paused') patch.paused = value as boolean;
    else if (key === 'scheduler.mode') patch.mode = value as AdaptiveConfig['mode'];
    else if (key === 'scheduler.timezone') patch.timezone = value as string;
    else if (key === 'scheduler.targetLocalTime') patch.targetLocalTime = value as string;
    else if (key === 'scheduler.quietStart') patch.quietStart = value as string;
    else if (key === 'scheduler.quietEnd') patch.quietEnd = value as string;
    else if (key === 'scheduler.micro.enabled') patch.micro = { ...(await engram.adaptive.store.config()).micro, enabled: value as boolean };
    else if (key === 'adaptive.autoAccept') patch.autoAccept = value as AdaptiveConfig['autoAccept'];
    else if (key === 'adaptive.workspaces.include') patch.workspaces = { ...(await engram.adaptive.store.config()).workspaces, include: value as string[] | null };
    else if (key === 'adaptive.workspaces.exclude') patch.workspaces = { ...(await engram.adaptive.store.config()).workspaces, exclude: value as string[] };
    await engram.adaptive.configure(patch); return;
  }
  if (key.startsWith('model.')) {
    const modelKey = key.slice(6); const input: ModelSetInput = {};
    if (modelKey === 'provider') { input.provider = value as string | null; if (modelName !== undefined) input.modelName = modelName; }
    else if (modelKey === 'modelName') input.modelName = value as string;
    else if (modelKey === 'baseUrl') input.baseUrl = value as string | null;
    else if (modelKey === 'apiKeyEnv') input.apiKeyEnv = value as string;
    else if (modelKey === 'apiKeyRef') input.apiKeyRef = value as string;
    else if (modelKey === 'allowNetwork') input.allowNetwork = value as boolean;
    else if (modelKey === 'allowPrivateContentToRemote') input.allowPrivateContentToRemote = value as boolean;
    if (modelKey === 'modelName' && value === '') await engram.vault.setConfig(config => { delete config.model.modelName; });
    else await setModel(engram.vault, { ...input, check: checkModel }); return;
  }
  if (key.startsWith('dream.')) {
    await engram.vault.setConfig(config => { const field = key.slice(6) as keyof DreamConfig; (config.dream as unknown as Record<string, unknown>)[field] = value; }); return;
  }
  if (key.startsWith('embedding.')) {
    const field = key.slice(10) as keyof EmbeddingConfig;
    await engram.vault.setConfig(config => { config.embedding ??= { provider: null }; if (field === 'provider' && config.embedding.provider !== value) { config.embedding.provider = value as EmbeddingConfig['provider']; delete config.embedding.model; } else if (field === 'model' && value === '') delete config.embedding.model; else (config.embedding as EmbeddingConfig)[field] = value as never; });
  }
}
async function validateModelChange(engram: Engram, key: string, value: unknown, modelName?: string): Promise<boolean> {
  if (!key.startsWith('model.')) return true;
  const input: ModelSetInput = {}, field = key.slice(6);
  if (field === 'provider') { input.provider = value as string | null; if (modelName !== undefined) input.modelName = modelName; }
  else if (field === 'modelName') input.modelName = value as string;
  else if (field === 'baseUrl') input.baseUrl = value as string | null;
  else if (field === 'apiKeyEnv') input.apiKeyEnv = value as string;
  else if (field === 'apiKeyRef') input.apiKeyRef = value as string;
  else if (field === 'allowNetwork') input.allowNetwork = value as boolean;
  else if (field === 'allowPrivateContentToRemote') input.allowPrivateContentToRemote = value as boolean;
  const next = applyModelSet((await engram.config()).model, input);
  if (next.provider === 'openai-compatible' && !next.baseUrl) throw new Error('OpenAI-compatible provider requires model.baseUrl');
  if (!next.provider) return true;
  try { createProviderFromConfig(next); return true; }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/model\.(?:baseUrl|modelName) is required|model\.baseUrl is required|model\.modelName is required|requires model\.allowNetwork|(?:was not found|No local agent CLI .* found) on PATH|Environment variable .* is not set/u.test(message)) return false;
    throw error;
  }
}
export async function previewSetting(engram: Engram, input: { key: string; value: unknown; etag: string; modelName?: string }) {
  const current = await readSettings(engram);
  if (current.locks[input.key as keyof typeof current.locks]) throw new Error(`Setting is locked by ${current.locks[input.key as keyof typeof current.locks]}`);
  const checked = validate(input.key, input.value);
  const requestedModelName = input.modelName === undefined ? undefined : validate('model.modelName', input.modelName).value as string;
  await validateModelChange(engram, input.key, checked.value, requestedModelName);
  if (input.key.startsWith('model.') && input.key !== 'model.allowNetwork' && input.key !== 'model.allowPrivateContentToRemote') {
    const current = (await engram.config()).model, candidate = applyModelSet(current, { [input.key.slice(6)]: checked.value, ...(input.key === 'model.provider' && requestedModelName !== undefined ? { modelName: requestedModelName } : {}) } as ModelSetInput);
    if (candidate.provider === 'openai-compatible' && !candidate.baseUrl) throw new Error('OpenAI-compatible provider requires model.baseUrl');
    if (isRemoteProvider(candidate) && !(candidate.allowNetwork && candidate.allowPrivateContentToRemote)) checked.confirm = 'allow remote model content';
    else checked.confirm = undefined;
  }
  const state = await readSettings(engram);
  if (input.etag !== state.etag) return { conflict: true, etag: state.etag };
  const candidate = input.key.startsWith('model.') && input.key !== 'model.allowNetwork' && input.key !== 'model.allowPrivateContentToRemote'
    ? applyModelSet((await engram.config()).model, { [input.key.slice(6)]: checked.value, ...(input.key === 'model.provider' && requestedModelName !== undefined ? { modelName: requestedModelName } : {}) } as ModelSetInput) : undefined;
  const remote = candidate ? isRemoteProvider(candidate) : state.settings['model.remote'] === true;
  const consentGiven = candidate ? modelConsent(candidate).consentGiven : state.settings['model.consentGiven'] === true;
  const resetModelName = input.key === 'model.provider' && requestedModelName !== undefined ? requestedModelName === '' && !!state.settings['model.modelName'] : input.key === 'model.provider' && !!state.settings['model.modelName'];
  return { key: input.key, oldValue: state.settings[input.key as keyof typeof state.settings], value: checked.value, diff: `${input.key}: ${JSON.stringify(state.settings[input.key as keyof typeof state.settings])} → ${JSON.stringify(checked.value)}${input.key === 'model.provider' && requestedModelName !== undefined ? `; model.modelName → ${JSON.stringify(requestedModelName || '(provider default)')}` : resetModelName ? '; model.modelName will reset to provider default' : ''}`, ...(resetModelName ? { resetsModelName: true } : {}), risk: checked.risk, ...(checked.confirm ? { confirm: checked.confirm } : {}), ...(input.key.startsWith('model.') ? { remote, consentGiven } : {}), etag: state.etag };
}
export async function applySetting(engram: Engram, input: { key: string; value: unknown; etag: string; confirm?: string; modelName?: string }, audit: typeof appendAudit = appendAudit) {
  const current = await readSettings(engram);
  if (current.locks[input.key as keyof typeof current.locks]) throw new Error(`Setting is locked by ${current.locks[input.key as keyof typeof current.locks]}`);
  const checked = validate(input.key, input.value), requestedModelName = input.modelName === undefined ? undefined : validate('model.modelName', input.modelName).value as string, modelReady = await validateModelChange(engram, input.key, checked.value, requestedModelName), before = await readSettings(engram);
  let grantRemoteConsent = false, revokeLocalConsent = false;
  if (input.key.startsWith('model.') && input.key !== 'model.allowNetwork' && input.key !== 'model.allowPrivateContentToRemote') {
    const current = (await engram.config()).model, candidate = applyModelSet(current, { [input.key.slice(6)]: checked.value, ...(input.key === 'model.provider' && requestedModelName !== undefined ? { modelName: requestedModelName } : {}) } as ModelSetInput);
    if (candidate.provider === 'openai-compatible' && !candidate.baseUrl) throw new Error('OpenAI-compatible provider requires model.baseUrl');
    if (isRemoteProvider(candidate) && !(candidate.allowNetwork && candidate.allowPrivateContentToRemote)) { checked.confirm = 'allow remote model content'; grantRemoteConsent = input.confirm === checked.confirm; }
    else { checked.confirm = undefined; revokeLocalConsent = !isRemoteProvider(candidate) && (candidate.allowNetwork === true || candidate.allowPrivateContentToRemote === true); }
  }
  if (input.etag !== before.etag) return { conflict: true, etag: before.etag };
  if (checked.confirm && input.confirm !== checked.confirm) throw new Error(`Typed confirmation required: ${checked.confirm}`);
  if (input.key === 'model.apiKeyEnv' && typeof input.value !== 'string') throw new Error('Key values are never accepted');
  const oldValue = before.settings[input.key as keyof typeof before.settings];
  // Audit durability is a precondition for mutation: if this append fails the setter is never called.
  try {
    await audit(engram.vault.root, { at: new Date().toISOString(), key: input.key, oldValue, newValue: checked.value, result: 'attempt' });
  } catch {
    throw Object.assign(new Error('Could not record the setting attempt; no change was applied'), { status: 503, code: 'AUDIT_UNAVAILABLE' });
  }
  try {
    if (grantRemoteConsent || revokeLocalConsent) {
      const consent = grantRemoteConsent;
      await setModel(engram.vault, { [input.key.slice(6)]: checked.value, ...(input.key === 'model.provider' && requestedModelName !== undefined ? { modelName: requestedModelName } : {}), allowNetwork: consent, allowPrivateContentToRemote: consent, check: modelReady } as ModelSetInput);
    } else await write(engram, input.key, checked.value, modelReady, requestedModelName);
  } catch (error) {
    try { await audit(engram.vault.root, { at: new Date().toISOString(), key: input.key, oldValue, newValue: checked.value, result: 'failed' }); } catch { /* preserve the setting failure; the durable attempt remains */ }
    throw error;
  }
  const after = await readSettings(engram);
  await audit(engram.vault.root, { at: new Date().toISOString(), key: input.key, oldValue, newValue: after.settings[input.key as keyof typeof after.settings], result: 'applied' });
  return { settings: after.settings, etag: after.etag };
}
