import type { Engram } from '../sdk/index.js';
import { readSecret } from '../core/secret-store.js';
import { isRemoteProvider, modelConsent } from '../models/consent.js';
import { effectiveProvider, resolveApiKey } from '../models/factory.js';
import { isLoopbackHost } from '../models/openai.js';

export type ListedModel = { id: string; label: string; note?: string; embedding?: boolean };
export type ModelList = { provider: string | null; source: 'provider' | 'curated' | 'unavailable'; default: true; models: ListedModel[]; reason?: string };
const cache = new Map<string, { at: number; value: ModelList }>();
const curatedClaude = ['opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(id => ({ id, label: id }));
const curatedOpenAIEmbedding = ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'].map(id => ({ id, label: id }));
const isEmbedding = (id: string) => /embed|bge|e5|minilm|nomic|gte|arctic|snowflake/i.test(id);

function endpoint(base: string, suffix: string): URL {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (!isLoopbackHost(url.hostname) && url.protocol !== 'https:')) throw new Error('Provider URL is not safe for model discovery');
  url.pathname = url.pathname.replace(/\/+$/, '') + suffix;
  return url;
}
async function fetchModels(url: URL, apiKey?: string, fetchImpl: typeof fetch = fetch): Promise<ListedModel[]> {
  const response = await fetchImpl(url, { headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error('Provider model list request failed');
  const text = await response.text(); if (Buffer.byteLength(text) > 1_000_000) throw new Error('Provider model list was too large');
  const parsed = JSON.parse(text) as { data?: unknown[]; models?: unknown[] };
  const rows = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
  return rows.flatMap((entry: any) => {
    const id = typeof entry?.id === 'string' ? entry.id : typeof entry?.name === 'string' ? entry.name : '';
    return id && id.length <= 200 ? [{ id, label: id }] : [];
  }).slice(0, 500);
}
async function ollamaModels(base: string): Promise<ListedModel[]> {
  const baseUrl = new URL(base), url = new URL('/api/tags', baseUrl.origin);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('Provider URL is not safe for model discovery');
  if (!isLoopbackHost(url.hostname)) throw new Error('Ollama model listing is allowed only for loopback servers');
  const response = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error('Ollama model list request failed');
  const text = await response.text(); if (Buffer.byteLength(text) > 1_000_000) throw new Error('Ollama model list was too large');
  const data = JSON.parse(text) as { models?: Array<{ name?: unknown }> };
  return (Array.isArray(data.models) ? data.models : []).flatMap(item => typeof item.name === 'string' && item.name.length <= 200 ? [{ id: item.name, label: item.name, ...(isEmbedding(item.name) ? { embedding: true } : {}) }] : []).slice(0, 500);
}
function unavailable(provider: string | null, reason: string): ModelList { return { provider, source: 'unavailable', default: true, models: [], reason }; }

export async function listChatModels(engram: Engram, requested: string | null, refresh = false): Promise<ModelList> {
  const config = await engram.config(), provider = requested || effectiveProvider(config.model, engram.modelEnv), key = `chat:${provider}:${config.model.baseUrl ?? ''}`;
  if (!provider || provider === 'auto' || provider === 'none') return { provider, source: 'curated', default: true, models: [] };
  if (!refresh) { const old = cache.get(key); if (old && Date.now() - old.at < 30_000) return old.value; }
  try {
    let models: ListedModel[], source: ModelList['source'] = 'provider';
    if (provider === 'ollama') models = await ollamaModels(config.model.baseUrl ?? 'http://127.0.0.1:11434');
    else if (provider === 'claude-cli') {
      models = curatedClaude; source = 'curated';
      const apiKey = resolveApiKey(config.model, engram.modelEnv, false);
      if (refresh && apiKey && config.model.baseUrl) {
        try {
          const url = endpoint(config.model.baseUrl, '/v1/models');
          const response = await fetch(url, { headers: { accept: 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, redirect: 'error', signal: AbortSignal.timeout(2500) });
          if (!response.ok) throw new Error('Provider model list request failed');
          const body = await response.text(); if (Buffer.byteLength(body) > 1_000_000) throw new Error('Provider model list was too large');
          const parsed = JSON.parse(body) as { data?: unknown[] };
          const live = (Array.isArray(parsed.data) ? parsed.data : []).flatMap((entry: any) => typeof entry?.id === 'string' && entry.id.length <= 200 ? [{ id: entry.id, label: entry.id }] : []).slice(0, 500);
          if (live.length) { models = [...curatedClaude, ...live.filter(item => !curatedClaude.some(curated => curated.id === item.id))]; source = 'provider'; }
        } catch { /* Keep the curated aliases when an optional explicit live refresh fails. */ }
      }
    }
    else if (provider === 'codex-cli') { models = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-reserve', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map(id => ({ id, label: id })); source = 'curated'; }
    else if (provider === 'openai' || provider === 'openai-compatible') {
      const base = config.model.baseUrl ?? 'https://api.openai.com/v1';
      const remote = isRemoteProvider({ ...config.model, provider });
      if (remote && !modelConsent({ ...config.model, provider }, false).consentGiven) return unavailable(provider, 'Model-list requests to this remote provider require network and private-content consent in Settings.');
      models = await fetchModels(endpoint(base, '/models'), resolveApiKey(config.model, engram.modelEnv, provider === 'openai'));
    } else return unavailable(provider, 'Model listing is unavailable for this provider.');
    const value: ModelList = { provider, source, default: true, models }; cache.set(key, { at: Date.now(), value }); return value;
  } catch { return unavailable(provider, 'Could not retrieve the model list. Check the provider URL and connection, then refresh.'); }
}

export async function listEmbeddingModels(engram: Engram, requested: string | null, refresh = false): Promise<ModelList> {
  const config = await engram.config(), embedding = config.embedding ?? { provider: null }, provider = requested || embedding.provider, key = `embedding:${provider}:${embedding.baseUrl ?? ''}`;
  if (!provider) return { provider, source: 'curated', default: true, models: [] };
  if (!refresh) { const old = cache.get(key); if (old && Date.now() - old.at < 30_000) return old.value; }
  try {
    let models: ListedModel[], source: ModelList['source'] = 'provider';
    if (provider === 'builtin') { models = [{ id: 'bge-m3', label: 'bge-m3', embedding: true }]; source = 'curated'; }
    else if (provider === 'ollama') { models = await ollamaModels(embedding.baseUrl ?? 'http://127.0.0.1:11434'); models.sort((a, b) => Number(!!b.embedding) - Number(!!a.embedding) || a.id.localeCompare(b.id)); }
    else if (provider === 'openai') {
      const consent = modelConsent({ provider, baseUrl: embedding.baseUrl, allowNetwork: embedding.allowNetwork ?? false, allowPrivateContentToRemote: embedding.allowPrivateContentToRemote ?? false }, false);
      if (!consent.consentGiven) return { provider, source: 'curated', default: true, models: curatedOpenAIEmbedding, reason: 'Live model discovery requires network and private-content consent in Settings.' };
      const keyValue = (embedding.apiKeyRef && readSecret(embedding.apiKeyRef, { env: engram.modelEnv as NodeJS.ProcessEnv })) ?? (embedding.apiKeyEnv ? engram.modelEnv[embedding.apiKeyEnv] : engram.modelEnv.OPENAI_API_KEY);
      models = curatedOpenAIEmbedding;
      try { models = [...models, ...await fetchModels(endpoint(embedding.baseUrl ?? 'https://api.openai.com/v1', '/models'), keyValue)]; } catch { source = 'curated'; }
    } else if (provider === 'openai-compatible') {
      const remote = modelConsent({ provider, baseUrl: embedding.baseUrl, allowNetwork: embedding.allowNetwork ?? false, allowPrivateContentToRemote: embedding.allowPrivateContentToRemote ?? false }, false);
      if (!remote.consentGiven) return unavailable(provider, 'Model-list requests to this remote provider require network and private-content consent in Settings.');
      const keyValue = (embedding.apiKeyRef && readSecret(embedding.apiKeyRef, { env: engram.modelEnv as NodeJS.ProcessEnv })) ?? (embedding.apiKeyEnv ? engram.modelEnv[embedding.apiKeyEnv] : undefined);
      models = await fetchModels(endpoint(embedding.baseUrl ?? '', '/models'), keyValue);
    } else return unavailable(provider, 'Model listing is unavailable for this embedding provider.');
    const value: ModelList = { provider, source, default: true, models }; cache.set(key, { at: Date.now(), value }); return value;
  } catch { return unavailable(provider, 'Could not retrieve the embedding model list. Check the provider URL and connection, then refresh.'); }
}
