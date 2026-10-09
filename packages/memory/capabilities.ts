import type { Engram } from '../sdk/index.js';
import { describeModel } from '../models/factory.js';
import { listRegistrations, spoolStats } from './capture.js';
import { ripgrepAvailable } from '../search-files/retrieve.js';

/** Truthful capability discovery for hosts and users. Never runs a model and never makes a network call. */
export async function capabilities(client: Engram): Promise<Record<string, unknown>> {
  const config = await client.vault.config().catch(() => undefined);
  const owner = client.vault.actor.permissions.includes('*');
  const vector = await client.search.vectors.status().catch(e => ({ ready: false, reason: (e as Error).message }) as { ready: boolean; reason?: string; model?: string; backend?: string });
  return {
    identity: { actorId: client.vault.actor.actorId, owner },
    nativeMemory: 'The host harness keeps its own context and memory. MDB is a passive recorder and secondary, on-demand recall; it never injects history unprompted.',
    recall: { modes: { recent: true, timeline: true, time_range: true, grep: true, regex: true, keyword: true, links: true, auto: true, semantic: vector.ready ? { available: true, model: vector.model, backend: vector.backend } : { available: false, reason: vector.reason }, hybrid: { available: false, reason: 'Requires semantic search' } }, progressiveDisclosure: ['index', 'snippet', 'full'], requiresModel: false },
    search: { filesystem: true, ripgrep: ripgrepAvailable(), sqlite: { enabled: !!config?.sqlite.enabled }, vector: { available: vector.ready, ...(vector.ready ? { model: vector.model, backend: vector.backend } : { reason: vector.reason }) }, autoMode: vector.ready ? 'hybrid (keyword + semantic, reciprocal rank fusion)' : 'keyword' },
    capture: config ? { enabled: config.capture.enabled, allowedHosts: config.capture.allowedSources, ...(owner ? { registrations: (await listRegistrations(client.vault.root)).map(r => ({ id: r.id, host: r.host, workspaceId: r.workspaceId, collectionId: r.collectionId ?? null, types: r.capture })), spool: await spoolStats(client.vault.root) } : {}) } : undefined,
    hostAdapters: { supported: ['claude-code', 'codex'], coverage: { 'claude-code': 'session start, user prompt, tool result (allow-listed tools), assistant turn (opt-in), session end (best-effort)', codex: 'session start, user prompt, tool result (allow-listed tools), assistant turn (opt-in); no session end hook; payloads not live-verified' }, others: 'No automatic capture. Use the MCP tools, the CLI, or the SDK LifecycleAdapter.' },
    intelligence: config ? { model: describeModel(config.model), dream: { enabled: config.dream.enabled } } : undefined
  };
}
