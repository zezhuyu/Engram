import type { Engram } from '../sdk/index.js';
import { readStats } from '../intelligence/dream/lifecycle.js';
import { storageStatus } from '../core/storage-lifecycle.js';
import path from 'node:path';
import { PROVIDER_NAMES } from '../models/factory.js';

const sectionCache = new Map<string, Map<string, { at: number; value: unknown }>>();
const sectionFlights = new Map<string, Promise<unknown>>();
const SECTION_TTL_MS = 5_000, SECTION_BUDGET_MS = 250;
async function cached<T>(root: string, key: string, now: number, fn: () => Promise<T>): Promise<T | { state: 'unavailable'; reason: string }> {
  let entries = sectionCache.get(root); if (!entries) { entries = new Map(); sectionCache.set(root, entries); }
  const old = entries.get(key);
  if (old && now - old.at < SECTION_TTL_MS) return old.value as T;
  const id = `${root}\0${key}`;
  let flight = sectionFlights.get(id);
  if (!flight) {
    flight = fn().then(value => { entries!.set(key, { at: Date.now(), value }); return value; })
      .catch(error => { const value = { state: 'unavailable', reason: error instanceof Error ? error.name : 'Error' }; entries!.set(key, { at: Date.now(), value }); return value; })
      .finally(() => sectionFlights.delete(id));
    sectionFlights.set(id, flight);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T | { state: 'unavailable'; reason: string }>(resolve => { timer = setTimeout(() => resolve(old ? old.value as T : { state: 'unavailable', reason: 'refreshing' }), SECTION_BUDGET_MS); timer.unref(); });
  const value = await Promise.race([flight as Promise<T | { state: 'unavailable'; reason: string }>, timeout]);
  if (timer) clearTimeout(timer);
  return value;
}
function countStatuses(jobs: Array<{ status: string }>) {
  return Object.fromEntries(['pending', 'running', 'complete', 'blocked', 'dead_letter'].map(status => [status, jobs.filter(job => job.status === status).length]));
}
export function summarizeIndex(value: unknown): unknown {
  if (!value || typeof value !== 'object' || 'state' in value) return value;
  const index = value as Record<string, any>, rawDatabases = index.databases as Record<string, Record<string, any>> | undefined;
  const databases = rawDatabases && typeof rawDatabases === 'object'
    ? Object.fromEntries(Object.entries(rawDatabases).map(([name, state]) => [name, { ok: state?.ok === true, checkpoint: Number.isFinite(state?.checkpoint) ? state.checkpoint : null, lagObjects: Number.isFinite(state?.lagObjects) ? state.lagObjects : null }])) : undefined;
  const vector = index.vector && typeof index.vector === 'object' ? { ready: index.vector.ready === true, enabled: index.vector.enabled === true, lagObjects: Number.isFinite(index.vector.lagObjects) ? index.vector.lagObjects : undefined } : undefined;
  return { backend: index.backend, available: index.available === true, derived: index.derived === true, journalSequence: index.journalSequence,
    manifest: index.manifest && typeof index.manifest === 'object' ? { entries: index.manifest.entries, journalSequence: index.manifest.journalSequence, persisted: index.manifest.persisted === true } : undefined,
    databases, vector, problem: index.available === false || Object.values(rawDatabases ?? {}).some(state => state?.ok === false) };
}
/** Content-free dashboard summaries, independently degraded when a subsystem is unavailable. */
export async function readDashboardStatus(engram: Engram, now = Date.now()): Promise<Record<string, unknown>> {
  const root = engram.vault.root;
  const storageEnv = { ...process.env, MDB_ROOT: root, ENGRAM_DATA_DIR: root,
    ENGRAM_USER_CONFIG: path.join(root, '.mdb/dashboard/config.json'), ENGRAM_STATE_DIR: path.join(root, '.mdb/dashboard/state'),
    ENGRAM_CACHE_DIR: path.join(root, '.mdb/dashboard/cache'), ENGRAM_OUTBOX: path.join(root, '.mdb/dashboard/outbox'),
    ENGRAM_REMOTE_SPOOL: path.join(root, '.mdb/dashboard/remote-spool'), ENGRAM_TEMP_DIR: path.join(root, '.mdb/dashboard/tmp'),
    ENGRAM_LOG_DIR: path.join(root, '.mdb/dashboard/logs'), ENGRAM_INDEX_SCRATCH_DIR: path.join(root, '.mdb/dashboard/index-scratch') };
  const [doctor, index, jobs, scheduler, proposals, spool, model, config, dream, wiki, storage, docs] = await Promise.all([
    cached(root, 'doctor', now, () => engram.doctor()), cached(root, 'index', now, () => engram.search.health()), cached(root, 'jobs', now, () => engram.jobs()),
    cached(root, 'scheduler', now, async () => ({ config: await engram.adaptive.store.config(), events: await engram.adaptive.store.events(50), cycles: await engram.adaptive.store.cycles() })),
    cached(root, 'proposals', now, () => engram.proposals()), cached(root, 'spool', now, async () => { const { spoolStats } = await import('../memory/capture.js'); return spoolStats(root); }),
    cached(root, 'model', now, async () => { const { showModel } = await import('../models/switch.js'); return showModel(await engram.config()); }), cached(root, 'config', now, () => engram.config()),
    cached(root, 'dream', now, async () => readStats(engram.vault)), cached(root, 'wiki', now, () => engram.wikiLint({ limit: 200 })), cached(root, 'storage', now, () => storageStatus(storageEnv)),
    cached(root, 'documents', now, async () => (await engram.listDocuments()).length),
  ]);
  const safeDoctor = doctor && 'state' in doctor ? doctor : { state: doctor?.ok === false ? 'attention' : 'ok', checks: doctor && typeof doctor === 'object' ? Object.keys(doctor) : [] };
  const jobCounts = Array.isArray(jobs) ? countStatuses(jobs) : jobs;
  const schedulerSummary = scheduler && 'config' in scheduler ? {
    enabled: scheduler.config.enabled, paused: scheduler.config.paused, mode: scheduler.config.mode,
    events: scheduler.events.length, cycles: scheduler.cycles.length,
    recentEvents: scheduler.events.slice(-50).map(event => ({ at: event.at, type: event.type, trigger: event.trigger })),
    recentCycles: scheduler.cycles.slice(-20).map((cycle: Record<string, any>) => ({ id: cycle.id, state: cycle.state, createdAt: cycle.createdAt, completedAt: cycle.completedAt, workspaceCount: cycle.workspaces && typeof cycle.workspaces === 'object' ? Object.keys(cycle.workspaces).length : 0, globalStatus: cycle.global?.status, dreamStatus: cycle.dream?.status })),
  } : scheduler;
  const providerName = model && 'provider' in model && typeof model.provider === 'string' && (PROVIDER_NAMES as readonly string[]).includes(model.provider) ? model.provider : null;
  const modelSummary = model && 'provider' in model ? { configured: Boolean(providerName), ready: model.available === true, provider: providerName, allowNetwork: model.allowNetwork === true } : model;
  const configSummary = config && 'schemaVersion' in config ? { schemaVersion: config.schemaVersion, sqlite: config.sqlite.enabled, dreamEnabled: config.dream.enabled, embeddingEnabled: Boolean(config.embedding?.provider) } : config;
  const dreamSummary = dream && typeof dream === 'object' ? { families: Object.keys(dream).length, outcomes: Object.values(dream).reduce((sum, entry) => sum + entry.validated + entry.rejected + entry.tested, 0) } : dream;
  const wikiSummary = wiki && 'summary' in wiki ? { checked: wiki.checked, bySeverity: wiki.summary.bySeverity, truncated: wiki.truncated } : wiki;
  const storageSummary = storage && 'logicalBytes' in storage ? (() => {
    const safeNumbers = (value: unknown) => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([, n]) => n === null || typeof n === 'number' && Number.isFinite(n))) : {};
    const quotaUsage = storage.quotaUsage && typeof storage.quotaUsage === 'object'
      ? Object.fromEntries(Object.entries(storage.quotaUsage).map(([key, value]) => {
        const item = value as Record<string, unknown>;
        return [key, { usedBytes: typeof item?.usedBytes === 'number' && Number.isFinite(item.usedBytes) ? item.usedBytes : null,
          limit: typeof item?.limit === 'number' && Number.isFinite(item.limit) ? item.limit : null,
          utilization: typeof item?.utilization === 'number' && Number.isFinite(item.utilization) ? item.utilization : null }];
      })) : {};
    const pressure = storage.pressure && typeof storage.pressure === 'object' ? storage.pressure as Record<string, unknown> : {};
    const state = ['NORMAL', 'WARNING', 'CRITICAL', 'READ_ONLY'].includes(String(pressure.state)) ? pressure.state : 'READ_ONLY';
    return { usageBytes: safeNumbers(storage.logicalBytes), quotas: safeNumbers(storage.quotas), quotaUsage,
      availableBytes: typeof pressure.availableBytes === 'number' ? pressure.availableBytes : null,
      pressureState: state, deferredOperations: typeof pressure.deferredOperations === 'number' ? pressure.deferredOperations : null,
      admissionRejections: pressure.admissionRejections && typeof pressure.admissionRejections === 'object'
        ? { deferred: (pressure.admissionRejections as Record<string, unknown>).deferred, rejected: (pressure.admissionRejections as Record<string, unknown>).rejected } : undefined };
  })() : storage;
  const safeJobItems = Array.isArray(jobs) ? jobs.slice(-50).map(job => ({ id: job.id, kind: job.kind, status: job.status, attempts: job.attempts, nextAt: Number.isFinite(job.nextAt) ? job.nextAt : null })) : undefined;
  return { generatedAt: new Date(now).toISOString(), vaultLabel: path.basename(root), doctor: safeDoctor, index: summarizeIndex(index), jobs: jobCounts, jobItems: safeJobItems, scheduler: schedulerSummary, dream: dreamSummary, wiki: wikiSummary, proposals: Array.isArray(proposals) ? { pending: proposals.filter(p => p.status === 'pending').length } : proposals, capture: spool, provider: modelSummary, storage: storageSummary, config: configSummary, documents: docs };
}
