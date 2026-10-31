import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, safePath, withVaultLock } from '../storage-local/index.js';
import { assertDurableWriteCapacity } from '../core/storage-lifecycle.js';
import { systemTimeZone } from './clock.js';
import type { AdaptiveConfig, Cursors, Cycle, Lease, ScheduleEvent, Telemetry } from './types.js';

const DIR = '.mdb/adaptive';
export const defaultConfig = (): AdaptiveConfig => ({
  enabled: false, paused: false, timezone: systemTimeZone(), targetLocalTime: '03:00', quietStart: '00:00', quietEnd: '07:00', mode: 'adaptive',
  minHistoryDays: 14, historyWindowDays: 28, inactivityMinutes: 60, expectedDurationHours: 2, telemetryRetentionDays: 90, autoAccept: 'none',
  workspaces: { include: null, exclude: [] }, resources: { maxLoadAverage: Math.max(1, os.cpus().length * 0.75), maxRssMiB: 1536, activityPollMs: 500 },
  baselineMaxItems: 200, maxModelCallsPerCycle: 60, dreamMode: 'deep',
  micro: { enabled: false, debounceMinutes: 10, maxPerDay: 6, kinds: ['user_insight', 'insight', 'wiki_page', 'source'] }, deadLetterAfterAttempts: 5
});
const safeId = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, '_');

/** Durable scheduler/cycle state under .mdb/adaptive. Disposable derivatives never live here: cycle records are the audit trail of what each run sealed and produced. */
export class AdaptiveStore {
  constructor(public readonly root: string) {}
  private async read<T>(key: string): Promise<T | undefined> { try { return JSON.parse(await fs.readFile(await safePath(this.root, key), 'utf8')) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } }
  private async write(key: string, value: unknown): Promise<void> { const serialized = JSON.stringify(value, null, 2); await assertDurableWriteCapacity(this.root, Buffer.byteLength(serialized) + 4096); await atomicWrite(this.root, key, serialized); }
  /** Short critical sections only: file IO, never model work. */
  locked<T>(action: () => Promise<T>): Promise<T> { return withVaultLock(this.root, action); }

  async config(): Promise<AdaptiveConfig> { const stored = await this.read<Partial<AdaptiveConfig>>(`${DIR}/config.json`); const base = defaultConfig(); return { ...base, ...stored, resources: { ...base.resources, ...stored?.resources }, workspaces: { ...base.workspaces, ...stored?.workspaces }, micro: { ...base.micro, ...stored?.micro } }; }
  async setConfig(patch: Partial<AdaptiveConfig>): Promise<AdaptiveConfig> { return this.locked(async () => { const next = { ...(await this.config()), ...patch, resources: { ...(await this.config()).resources, ...patch.resources }, workspaces: { ...(await this.config()).workspaces, ...patch.workspaces }, micro: { ...(await this.config()).micro, ...patch.micro } }; await this.write(`${DIR}/config.json`, next); return next; }); }

  async cursors(): Promise<Cursors> { return (await this.read<Cursors>(`${DIR}/cursors.json`)) ?? { workspaces: {}, global: 0 }; }
  async advanceCursors(update: (c: Cursors) => void): Promise<Cursors> { return this.locked(async () => { const c = await this.cursors(); update(c); await this.write(`${DIR}/cursors.json`, c); return c; }); }

  /** Append-only operational log. Best effort: telemetry must never fail or reorder a cycle. */
  async appendEvent(event: Omit<ScheduleEvent, 'at'> & { at?: string }): Promise<void> {
    try { await this.locked(async () => { const file = await safePath(this.root, `${DIR}/events.jsonl`); const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'; await assertDurableWriteCapacity(this.root, Buffer.byteLength(line) + 4096); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.appendFile(file, line, { mode: 0o600 }); }); } catch { /* advisory */ }
  }
  async events(limit = 50): Promise<ScheduleEvent[]> {
    try { const lines = (await fs.readFile(await safePath(this.root, `${DIR}/events.jsonl`), 'utf8')).split('\n').filter(Boolean); return lines.slice(-limit).flatMap(line => { try { return [JSON.parse(line) as ScheduleEvent]; } catch { return []; } }); } catch { return []; }
  }

  async telemetry(): Promise<Telemetry> { return (await this.read<Telemetry>(`${DIR}/telemetry.json`)) ?? { days: {}, lastEventSequence: 0 }; }
  async saveTelemetry(t: Telemetry): Promise<void> { await this.locked(() => this.write(`${DIR}/telemetry.json`, t)); }

  async cycle(id: string): Promise<Cycle | undefined> { return this.read<Cycle>(`${DIR}/cycles/${safeId(id)}.json`); }
  async saveCycle(cycle: Cycle): Promise<void> { cycle.updatedAt = new Date().toISOString(); await this.locked(() => this.write(`${DIR}/cycles/${safeId(cycle.id)}.json`, cycle)); }
  async cycles(): Promise<Cycle[]> {
    let names: string[] = []; try { names = await fs.readdir(await safePath(this.root, `${DIR}/cycles`)); } catch { return []; }
    const out: Cycle[] = []; for (const n of names.filter(n => n.endsWith('.json'))) { const c = await this.read<Cycle>(`${DIR}/cycles/${n}`); if (c) out.push(c); }
    return out.sort((a, b) => a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
  }

  /** Single-flight lease: exactly one scheduler instance per vault may drive a cycle. A lease held by a dead process, or expired, can be taken over. */
  async acquireLease(cycleId: string, ttlMs: number, instance: string): Promise<boolean> {
    return this.locked(async () => {
      const current = await this.read<Lease>(`${DIR}/lease.json`); const now = Date.now();
      if (current && Date.parse(current.expiresAt) > now && current.owner !== instance) { let alive = true; if (current.pid !== process.pid) { try { process.kill(current.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; } } if (alive) return false; }
      await this.write(`${DIR}/lease.json`, { owner: instance, pid: process.pid, cycleId, expiresAt: new Date(now + ttlMs).toISOString() } satisfies Lease); return true;
    });
  }
  async renewLease(instance: string, cycleId: string, ttlMs: number): Promise<boolean> { return this.locked(async () => { const current = await this.read<Lease>(`${DIR}/lease.json`); if (!current || current.owner !== instance) return false; await this.write(`${DIR}/lease.json`, { ...current, cycleId, expiresAt: new Date(Date.now() + ttlMs).toISOString() }); return true; }); }
  async releaseLease(instance: string): Promise<void> { await this.locked(async () => { const current = await this.read<Lease>(`${DIR}/lease.json`); if (current?.owner === instance) await fs.rm(await safePath(this.root, `${DIR}/lease.json`), { force: true }); }); }
  async lease(): Promise<Lease | undefined> { return this.read<Lease>(`${DIR}/lease.json`); }
  newInstance(): string { return randomUUID(); }
}
