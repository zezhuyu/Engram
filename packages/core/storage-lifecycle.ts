import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureStorageDirectory, resolveRoot, resolveStoragePath, type StoragePathKind } from './root.js';
import { atomicWrite } from '../storage-local/index.js';

export type StorageQuotaKind = 'temporary' | 'cache' | 'index-scratch' | 'logs' | 'background-jobs';
export const DEFAULT_STORAGE_QUOTAS: Readonly<Record<StorageQuotaKind, number>> = Object.freeze({
  temporary: 512 * 1024 * 1024,
  cache: 2 * 1024 * 1024 * 1024,
  'index-scratch': 1024 * 1024 * 1024,
  logs: 256 * 1024 * 1024,
  'background-jobs': 2,
});
export const DEFAULT_STORAGE_MIN_FREE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_STORAGE_DURABLE_RESERVE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_STORAGE_OPERATION_QUOTA_BYTES = 256 * 1024 * 1024;
export type StoragePressureState = 'NORMAL' | 'WARNING' | 'CRITICAL' | 'READ_ONLY';
const pressureEvents = new Map<string, { deferred: number; rejected: number; lastReason?: string }>();
const envNames: Record<StorageQuotaKind, string> = {
  temporary: 'ENGRAM_STORAGE_TEMP_QUOTA_BYTES', cache: 'ENGRAM_STORAGE_CACHE_QUOTA_BYTES',
  'index-scratch': 'ENGRAM_STORAGE_INDEX_SCRATCH_QUOTA_BYTES', logs: 'ENGRAM_STORAGE_LOG_QUOTA_BYTES',
  'background-jobs': 'ENGRAM_STORAGE_BACKGROUND_JOB_LIMIT',
};
export function storageQuota(kind: StorageQuotaKind, env: Record<string, string | undefined> = process.env): number {
  const raw = env[envNames[kind]];
  if (raw === undefined || raw.trim() === '') return DEFAULT_STORAGE_QUOTAS[kind];
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${envNames[kind]} must be a positive integer`);
  return value;
}
export function storageMinimumFreeBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ENGRAM_STORAGE_MIN_FREE_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STORAGE_MIN_FREE_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('ENGRAM_STORAGE_MIN_FREE_BYTES must be a non-negative safe integer');
  return value;
}
export function storageDurableReserveBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ENGRAM_STORAGE_DURABLE_RESERVE_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STORAGE_DURABLE_RESERVE_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('ENGRAM_STORAGE_DURABLE_RESERVE_BYTES must be a positive integer');
  return value;
}

/** State is based on projected free bytes, so long operations must call the admission check again as they grow. */
export function classifyStoragePressure(availableBytes: number, estimatedGrowthBytes = 0, env: Record<string, string | undefined> = process.env): StoragePressureState {
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 || !Number.isSafeInteger(estimatedGrowthBytes) || estimatedGrowthBytes < 0) throw new StoragePressureError('Storage capacity or growth estimate is invalid; writes were deferred');
  const projected = Math.max(0, availableBytes - estimatedGrowthBytes);
  if (projected <= storageDurableReserveBytes(env)) return 'READ_ONLY';
  const reserve = Math.max(storageMinimumFreeBytes(env), storageDurableReserveBytes(env));
  if (projected <= reserve) return 'CRITICAL';
  if (projected <= reserve * 2) return 'WARNING';
  return 'NORMAL';
}

export function storageOperationQuotaBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ENGRAM_STORAGE_OPERATION_QUOTA_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STORAGE_OPERATION_QUOTA_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('ENGRAM_STORAGE_OPERATION_QUOTA_BYTES must be a positive integer');
  return value;
}
export function storageWarningAtBytes(env: Record<string, string | undefined> = process.env): number { return Math.max(storageMinimumFreeBytes(env), storageDurableReserveBytes(env)) * 2; }

function notePressure(directory: string, state: StoragePressureState, reason: string): void {
  const key = path.resolve(directory), event = pressureEvents.get(key) ?? { deferred: 0, rejected: 0 };
  if (state === 'CRITICAL') event.deferred++;
  if (state === 'READ_ONLY') event.rejected++;
  event.lastReason = reason; pressureEvents.set(key, event);
}
function pressureCounts(): { deferred: number; rejected: number; lastReason?: string; scope: 'current-process' } {
  const values = [...pressureEvents.values()];
  return { deferred: values.reduce((sum, value) => sum + value.deferred, 0), rejected: values.reduce((sum, value) => sum + value.rejected, 0), ...(values.at(-1)?.lastReason ? { lastReason: values.at(-1)!.lastReason } : {}), scope: 'current-process' };
}

async function nearestExistingDirectory(directory: string): Promise<string> {
  let candidate = path.resolve(directory);
  for (;;) {
    try { const info = await fs.stat(candidate); if (!info.isDirectory()) throw new Error(`Storage volume probe is not a directory: ${candidate}`); return candidate; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = path.dirname(candidate); if (parent === candidate) throw error; candidate = parent; }
  }
}

export async function availableStorageBytes(directory: string): Promise<number> {
  const probe = await nearestExistingDirectory(directory);
  const space = await fs.statfs(probe);
  const availableBytes = Number(space.bavail) * Number(space.bsize);
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) throw new StoragePressureError('Available storage could not be measured');
  return availableBytes;
}

/** Admission guard for optional work. This is not a quota or a guarantee against concurrent/external writes. */
export async function assertAvailableStorage(directory: string, env: Record<string, string | undefined> = process.env, additionalBytes = 0, availableBytesOverride?: number): Promise<{ availableBytes: number; requiredFreeBytes: number }> {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error('additionalBytes must be a non-negative safe integer');
  const availableBytes = availableBytesOverride ?? await availableStorageBytes(directory).catch(() => undefined);
  if (availableBytes === undefined || !Number.isSafeInteger(availableBytes)) throw new StoragePressureError('Available storage could not be measured; optional Engram work was deferred');
  const requiredFreeBytes = storageMinimumFreeBytes(env);
  const state = classifyStoragePressure(availableBytes, additionalBytes, env);
  if (state === 'CRITICAL' || state === 'READ_ONLY') { const reason = 'Engram deferred optional work because projected free storage is below ENGRAM_STORAGE_MIN_FREE_BYTES'; notePressure(directory, state, reason); throw new StoragePressureError(reason); }
  return { availableBytes, requiredFreeBytes };
}

/** Durable mutations retain a separate reserve for journal metadata and recovery; this check is repeated at each commit boundary. */
export async function assertDurableWriteCapacity(directory: string, estimatedGrowthBytes: number, env: Record<string, string | undefined> = process.env, availableBytesOverride?: number): Promise<{ availableBytes: number; projectedAvailableBytes: number; state: StoragePressureState }> {
  if (!Number.isSafeInteger(estimatedGrowthBytes) || estimatedGrowthBytes < 0) throw new StoragePressureError('Durable write estimate is invalid; mutation was rejected');
  const availableBytes = availableBytesOverride ?? await availableStorageBytes(directory).catch(() => undefined);
  if (availableBytes === undefined || !Number.isSafeInteger(availableBytes) || availableBytes < 0) throw new StoragePressureError('Available storage could not be measured; durable mutation was rejected');
  const state = classifyStoragePressure(availableBytes, estimatedGrowthBytes, env), projectedAvailableBytes = Math.max(0, availableBytes - estimatedGrowthBytes);
  if (state === 'READ_ONLY') { const reason = 'Engram is READ_ONLY: durable reserve would be consumed by this mutation'; notePressure(directory, state, reason); throw new StoragePressureError(reason); }
  return { availableBytes, projectedAvailableBytes, state };
}

export interface OperationMarker { schemaVersion: 1; id: string; category: string; pid: number; createdAt: string; state: 'active' | 'complete' | 'failed'; peakBytes?: number; scopeHash?: string }
export interface OwnedOperation { id: string; directory: string; marker: OperationMarker; checkQuota(): Promise<void>; cleanup(): Promise<void> }
export class StoragePressureError extends Error { constructor(message: string) { super(message); this.name = 'StoragePressureError'; } }

async function walkBytes(directory: string): Promise<number> {
  const rootInfo = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (!rootInfo) return 0;
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Refusing to traverse ambiguous storage path: ${directory}`);
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    const file = path.join(directory, entry.name);
    // Directory entries can disappear between readdir and lstat/stat (for example,
    // another operation atomically replacing its marker). Ignore only that race;
    // every other inspection error remains fail-closed for quota accounting.
    const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error(`Refusing to follow a symlink while accounting Engram storage: ${file}`);
    if (info.isDirectory()) bytes += await walkBytes(file);
    else if (info.isFile()) bytes += info.size;
  }
  return bytes;
}

/** Creates a uniquely identified, marker-owned scratch directory beneath the resolved Engram temp root. */
export async function createOwnedOperation(category: string, options: { env?: Record<string, string | undefined>; quotaKind?: StorageQuotaKind; scope?: string; fault?: (stage: string) => void } = {}): Promise<OwnedOperation> {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(category)) throw new Error('Invalid storage operation category');
  const env = options.env ?? process.env;
  await assertAvailableStorage(resolveStoragePath('tmp', env), env);
  await ensureStorageDirectory('tmp', env);
  const tempRoot = path.join(resolveStoragePath('tmp', env), 'operations');
  const tempParent = await fs.realpath(path.dirname(tempRoot));
  try { await fs.mkdir(tempRoot, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const tempInfo = await fs.lstat(tempRoot);
  if (tempInfo.isSymbolicLink() || !tempInfo.isDirectory() || path.dirname(await fs.realpath(tempRoot)) !== tempParent) throw new Error('Refusing an unsafe Engram operation directory');
  const quotaKind = options.quotaKind ?? 'temporary';
  const scopeHash = options.scope ? createHash('sha256').update(path.resolve(options.scope)).digest('hex').slice(0, 24) : undefined;
  const estimatedMarkerBytes = 512;
  const temporaryUsed = await walkBytes(tempRoot);
  if (temporaryUsed + estimatedMarkerBytes > storageQuota('temporary', env)) { notePressure(tempRoot, 'CRITICAL', 'Engram temporary storage quota reached'); throw new StoragePressureError('Engram temporary storage quota reached; nonessential work was deferred'); }
  if (quotaKind === 'background-jobs') {
    const running = await inspectOwnedOperations(tempRoot, { onlyActive: true });
    const activeJobs = running.reports.filter(item => item.category === 'intelligence-job' && item.ownerAlive && item.scopeHash === scopeHash);
    if (activeJobs.length >= storageQuota(quotaKind, env)) { notePressure(tempRoot, 'CRITICAL', 'Engram background job limit reached'); throw new StoragePressureError('Engram background job limit reached; work remains queued for a later run'); }
  } else {
    const root = quotaKind === 'temporary'
      ? path.join(resolveStoragePath('tmp', env), 'operations')
      : resolveStoragePath(storageKindForQuota(quotaKind), env);
    const used = await walkBytes(root);
    if (used + estimatedMarkerBytes > storageQuota(quotaKind, env)) { notePressure(root, 'CRITICAL', `${quotaKind} quota reached`); throw new StoragePressureError(`Engram ${quotaKind} quota reached; nonessential work was deferred`); }
  }
  const id = randomUUID(); const directory = path.join(tempRoot, `${category}-${id}`);
  await fs.mkdir(directory, { mode: 0o700 });
  const marker: OperationMarker = { schemaVersion: 1, id, category, pid: process.pid, createdAt: new Date().toISOString(), state: 'active', peakBytes: 0, ...(scopeHash ? { scopeHash } : {}) };
  try { options.fault?.('operation.marker_create'); await fs.writeFile(path.join(directory, '.engram-operation.json'), `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error) { await fs.rmdir(directory).catch(() => undefined); throw error; }
  let cleanupPromise: Promise<void> | undefined;
  let persistedPeak = 0;
  return { id, directory, marker,
    checkQuota: async () => {
      await assertAvailableStorage(tempRoot, env);
      const bytes = await walkBytes(directory), aggregate = await walkBytes(tempRoot);
      if (bytes - persistedPeak >= 1024 * 1024 || bytes > 0 && persistedPeak === 0) {
        persistedPeak = bytes; marker.peakBytes = bytes;
        await atomicWrite(directory, '.engram-operation.json', `${JSON.stringify(marker)}\n`);
      }
      if (bytes > storageOperationQuotaBytes(env)) { notePressure(tempRoot, 'CRITICAL', 'Engram per-operation scratch quota reached'); throw new StoragePressureError('Engram per-operation scratch quota reached; optional work was stopped'); }
      if (aggregate > storageQuota('temporary', env)) { notePressure(tempRoot, 'CRITICAL', 'Engram aggregate temporary quota reached'); throw new StoragePressureError('Engram temporary storage quota reached during operation'); }
    },
    cleanup: () => {
      if (!cleanupPromise) cleanupPromise = cleanupOwnedOperation(tempRoot, directory, id, 'complete', options.fault).catch(error => { cleanupPromise = undefined; throw error; });
      return cleanupPromise;
    } };
}

export async function assertStorageQuota(kind: Exclude<StorageQuotaKind, 'background-jobs'>, directory: string, additionalBytes = 0, env: Record<string, string | undefined> = process.env): Promise<void> {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error('additionalBytes must be a non-negative safe integer');
  const used = await walkBytes(directory);
  if (used + additionalBytes > storageQuota(kind, env)) { notePressure(directory, 'CRITICAL', `${kind} quota reached`); throw new StoragePressureError(`Engram ${kind} quota reached; nonessential storage work was deferred`); }
}

function storageKindForQuota(kind: Exclude<StorageQuotaKind, 'background-jobs'>): StoragePathKind {
  if (kind === 'temporary') return 'tmp';
  if (kind === 'cache') return 'cache';
  if (kind === 'logs') return 'logs';
  return 'index-scratch';
}

async function cleanupOwnedOperation(tempRoot: string, directory: string, id: string, state: 'complete' | 'failed', fault?: (stage: string) => void): Promise<void> {
  const expectedRoot = await fs.realpath(tempRoot);
  const actualDirectory = await fs.realpath(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (!actualDirectory) return;
  if (path.dirname(actualDirectory) !== expectedRoot) throw new Error('Refusing to clean an operation outside the Engram temp root');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing to clean an ambiguous operation path');
  const markerFile = path.join(directory, '.engram-operation.json');
  const markerStat = await fs.lstat(markerFile);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('Refusing to clean an operation without an owned marker');
  const marker = JSON.parse(await fs.readFile(markerFile, 'utf8')) as OperationMarker;
  if (marker.schemaVersion !== 1 || marker.id !== id || marker.pid !== process.pid || !['active', 'complete', 'failed'].includes(marker.state)) throw new Error('Refusing to clean an operation with mismatched ownership');
  if (marker.state === 'active') {
    fault?.('operation.marker_complete');
    await atomicWrite(directory, '.engram-operation.json', `${JSON.stringify({ ...marker, state, finishedAt: new Date().toISOString() })}\n`);
  }
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
}

export interface OperationReport { directory: string; id: string; category: string; pid: number; createdAt: string; state: string; bytes: number; peakBytes?: number; ownerAlive: boolean; scopeHash?: string }
interface OperationInspection { reports: OperationReport[]; complete: boolean; uninspectedEntries: number }
async function inspectOwnedOperations(tempRoot: string, options: { onlyActive?: boolean } = {}): Promise<OperationInspection> {
  const root = await fs.realpath(tempRoot).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (!root) return { reports: [], complete: true, uninspectedEntries: 0 };
  const reports: OperationReport[] = []; let uninspectedEntries = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) { uninspectedEntries++; continue; }
    const directory = path.join(root, entry.name); const markerPath = path.join(directory, '.engram-operation.json');
    try {
      const info = await fs.lstat(markerPath); if (!info.isFile() || info.isSymbolicLink()) continue;
      const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as OperationMarker;
      if (marker.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(marker.id) || !Number.isInteger(marker.pid) || !['active', 'complete', 'failed'].includes(marker.state)) continue;
      if (options.onlyActive && marker.state !== 'active') continue;
      let ownerAlive = false; try { process.kill(marker.pid, 0); ownerAlive = true; } catch (error) { ownerAlive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
      reports.push({ directory, id: marker.id, category: marker.category, pid: marker.pid, createdAt: marker.createdAt, state: marker.state, bytes: await walkBytes(directory), ...(Number.isSafeInteger(marker.peakBytes) ? { peakBytes: marker.peakBytes } : {}), ownerAlive, ...(typeof marker.scopeHash === 'string' ? { scopeHash: marker.scopeHash } : {}) });
    } catch { uninspectedEntries++; /* ambiguous/unreadable directories are deliberately not claimed or cleaned */ }
  }
  return { reports, complete: uninspectedEntries === 0, uninspectedEntries };
}

async function inspectIndexBuildScratch(directory: string): Promise<{ reports: Array<{ directory: string; id: string; pid: number; createdAt: string; bytes: number; ownerAlive: boolean }>; complete: boolean; uninspectedEntries: number }> {
  const root = await fs.realpath(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (!root) return { reports: [], complete: true, uninspectedEntries: 0 };
  const reports: Array<{ directory: string; id: string; pid: number; createdAt: string; bytes: number; ownerAlive: boolean }> = []; let uninspectedEntries = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !/^fs-trigram-[0-9a-f-]{36}\.tmp$/i.test(entry.name)) { uninspectedEntries++; continue; }
    const child = path.join(root, entry.name);
    try {
      const markerPath = path.join(child, '.engram-index-build.json'), markerStat = await fs.lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('unsafe marker');
      const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as { schemaVersion?: number; id?: string; pid?: number; createdAt?: string };
      if (marker.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(marker.id ?? '') || !Number.isInteger(marker.pid) || typeof marker.createdAt !== 'string') throw new Error('invalid marker');
      let ownerAlive = false; try { process.kill(marker.pid!, 0); ownerAlive = true; } catch (error) { ownerAlive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
      reports.push({ directory: child, id: marker.id!, pid: marker.pid!, createdAt: marker.createdAt, bytes: await walkBytes(child), ownerAlive });
    } catch { uninspectedEntries++; }
  }
  return { reports, complete: uninspectedEntries === 0, uninspectedEntries };
}

export async function storageStatus(env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown>> {
  const roots = ['vault', 'config', 'state', 'cache', 'outbox', 'remote-spool', 'tmp', 'logs', 'index-scratch'] as const;
  const locations = Object.fromEntries(roots.map(kind => [kind, kind === 'vault' ? resolveRoot(undefined, env) : resolveStoragePath(kind, env)]));
  const operationInspection = await inspectOwnedOperations(path.join(resolveStoragePath('tmp', env), 'operations'));
  const indexBuildInspection = await inspectIndexBuildScratch(path.join(resolveRoot(undefined, env), '.mdb/indexes/.engram-builds'));
  const usage: Record<string, number | null> = {};
  for (const kind of roots) {
    const target = locations[kind];
    if (!target) { usage[kind] = null; continue; }
    if (kind === 'tmp' && !env.ENGRAM_DATA_DIR?.trim() && !env.ENGRAM_TEMP_DIR?.trim()) { usage[kind] = null; continue; }
    usage[kind] = await walkBytes(kind === 'tmp' ? path.join(target, 'operations') : target).catch(() => null);
  }
  const availableBytes = await availableStorageBytes(resolveRoot(undefined, env)).catch(() => undefined);
  const pressureState: StoragePressureState = availableBytes === undefined ? 'READ_ONLY' : classifyStoragePressure(availableBytes, 0, env);
  const deferredFromQueues = await (async () => {
    let count = 0;
    for (const entry of await fs.readdir(path.join(resolveRoot(undefined, env), '.mdb/intelligence')).catch(() => [] as string[])) {
      if (!/^[a-f0-9]+\.json$/.test(entry)) continue;
      try { const state = JSON.parse(await fs.readFile(path.join(resolveRoot(undefined, env), '.mdb/intelligence', entry), 'utf8')) as { jobs?: Array<{ status?: string }> }; count += state.jobs?.filter(job => job.status === 'pending' || job.status === 'blocked').length ?? 0; } catch { /* incomplete telemetry never exposes file content */ }
    }
    return count;
  })();
  const durableBytes = await Promise.all(['.mdb/objects', '.mdb/events', '.mdb/recovery'].map(key => walkBytes(path.join(resolveRoot(undefined, env), key)).catch(() => 0))).then(values => values.reduce((sum, value) => sum + value, 0));
  const recoverableDisposableBytes = operationInspection.reports.filter(item => !item.ownerAlive).reduce((sum, item) => sum + item.bytes, 0) + indexBuildInspection.reports.filter(item => !item.ownerAlive).reduce((sum, item) => sum + item.bytes, 0);
  const quotaUsage: Record<string, { usedBytes: number | null; limit: number; utilization: number | null }> = {};
  for (const kind of Object.keys(envNames) as StorageQuotaKind[]) {
    if (kind === 'background-jobs') quotaUsage[kind] = { usedBytes: operationInspection.reports.filter(item => item.category === 'intelligence-job' && item.state === 'active' && item.ownerAlive).length, limit: storageQuota(kind, env), utilization: null };
    else {
      const location = locations[storageKindForQuota(kind) === 'tmp' ? 'tmp' : storageKindForQuota(kind)];
      const target = kind === 'index-scratch' ? path.join(resolveRoot(undefined, env), '.mdb/indexes/.engram-builds') : location ? kind === 'temporary' ? path.join(location, 'operations') : location : undefined;
      if (!target) { quotaUsage[kind] = { usedBytes: null, limit: storageQuota(kind, env), utilization: null }; continue; }
      let usedBytes: number | null;
      try { usedBytes = await walkBytes(target); } catch { usedBytes = null; }
      const limit = storageQuota(kind, env);
      quotaUsage[kind] = { usedBytes, limit, utilization: usedBytes === null ? null : usedBytes / limit };
    }
  }
  return { dataDirConfigured: !!env.ENGRAM_DATA_DIR?.trim(), locations, logicalBytes: usage,
    quotas: { ...Object.fromEntries((Object.keys(envNames) as StorageQuotaKind[]).map(kind => [kind, storageQuota(kind, env)])), operationScratchBytes: storageOperationQuotaBytes(env) },
    quotaUsage,
    indexBuildScratch: indexBuildInspection,
    pressure: { state: pressureState, availableBytes: availableBytes ?? null, minimumFreeReserveBytes: storageMinimumFreeBytes(env), durableReserveBytes: storageDurableReserveBytes(env), warningAtBytes: storageWarningAtBytes(env), hardQuota: false, deferredOperations: deferredFromQueues, admissionRejections: pressureCounts(), countsScope: 'current-process admission counters; deferred queue count is persisted job state', protectedDurableBytes: durableBytes, recoverableDisposableBytes },
    filesystem: availableBytes !== undefined ? { availableBytes, admissionMinimumFreeBytes: storageMinimumFreeBytes(env), durableReserveBytes: storageDurableReserveBytes(env), hardQuota: false } : { availableBytes: null, admissionMinimumFreeBytes: storageMinimumFreeBytes(env), durableReserveBytes: storageDurableReserveBytes(env), hardQuota: false },
    accounting: { unit: 'logical bytes', allocatedBlocksMeasured: false, vaultIncludesNestedRuntime: !!env.ENGRAM_DATA_DIR?.trim(), totalsAreNotAdditive: true },
    ownedOperations: operationInspection.reports,
    ownedOperationInspection: { complete: operationInspection.complete, uninspectedEntries: operationInspection.uninspectedEntries } };
}

/** A report-only inventory. Orphans are identified but never removed by this API. */
export async function cleanupPreview(env: Record<string, string | undefined> = process.env): Promise<{ candidates: OperationReport[]; deleted: 0; complete: boolean; uninspectedEntries: number; note: string }> {
  const inspection = await inspectOwnedOperations(path.join(resolveStoragePath('tmp', env), 'operations'));
  const candidates = inspection.reports.filter(item => item.state === 'active' && !item.ownerAlive);
  return { candidates, deleted: 0, complete: inspection.complete, uninspectedEntries: inspection.uninspectedEntries, note: 'Dry run only: orphan markers are advisory; cleanup is never automatic for artifacts left by an interrupted process.' };
}
