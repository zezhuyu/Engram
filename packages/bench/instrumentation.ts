import { performance } from 'node:perf_hooks';

export interface ProfileMetric { count: number; totalMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; bytes?: number }
const enabled = () => process.env.MDB_BENCH_PROFILE === '1';
const samples = new Map<string, number[]>();
const bytes = new Map<string, number>();
let context = '';

function add(name: string, ms: number): void {
  if (!enabled) return;
  const key = context ? `${context}.${name}` : name;
  const values = samples.get(key) ?? [];
  values.push(ms);
  samples.set(key, values);
}

export function profileSync<T>(name: string, action: () => T): T {
  if (!enabled()) return action();
  const start = performance.now();
  try { return action(); } finally { add(name, performance.now() - start); }
}

export async function profileAsync<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (!enabled()) return action();
  const start = performance.now();
  try { return await action(); } finally { add(name, performance.now() - start); }
}

export function profileBytes(name: string, value: number): void {
  if (!enabled() || !Number.isFinite(value) || value <= 0) return;
  const key = context ? `${context}.${name}` : name;
  bytes.set(key, (bytes.get(key) ?? 0) + value);
}

export function profileSample(name: string, milliseconds: number): void {
  if (!enabled() || !Number.isFinite(milliseconds) || milliseconds < 0) return;
  add(name, milliseconds);
}

export async function withProfileContext<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (!enabled()) return action();
  const previous = context; context = name;
  try { return await action(); } finally { context = previous; }
}

export function profileReport(): Record<string, ProfileMetric> {
  const result: Record<string, ProfileMetric> = {};
  for (const [name, raw] of samples) {
    const values = [...raw].sort((a, b) => a - b);
    const pct = (p: number) => values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
    result[name] = { count: values.length, totalMs: +values.reduce((sum, value) => sum + value, 0).toFixed(2), p50Ms: +pct(.5).toFixed(2), p95Ms: +pct(.95).toFixed(2), p99Ms: +pct(.99).toFixed(2), maxMs: +values.at(-1)!.toFixed(2), ...(bytes.has(name) ? { bytes: bytes.get(name) } : {}) };
  }
  for (const [name, value] of bytes) if (!result[name]) result[name] = { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, bytes: value };
  return result;
}

export function resetProfile(): void { samples.clear(); bytes.clear(); }
