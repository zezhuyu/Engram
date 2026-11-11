import { createHash, randomUUID } from 'node:crypto';
import type { Scope } from '../core/types.js';

export const MAX_REVISION_BYTES = 1024 * 1024;
export const MAX_BATCH_SIZE = 100;
export const REPLICA_KINDS = ['note', 'task', 'handoff', 'decision', 'observation', 'session', 'preference_statement'] as const;
export type ReplicaKind = typeof REPLICA_KINDS[number];
export interface ReplicaOperation {
  v: 1;
  opId: string;
  deviceId: string;
  localSeq: number;
  scope: Extract<Scope, { type: 'workspace' }>;
  kind: ReplicaKind;
  objectId: string;
  revisionId: string;
  previousRevisionId: string | null;
  baseRevisionId: string | null;
  revisionBytes: string;
  revisionSha256: string;
  /** Present only for the typed explicit preference operation. */
  statement?: { text: string; category: 'preference'|'goal'|'interest'|'capability'|'working_style'|'knowledge_gap'; preferenceKey: string; sensitive?: boolean };
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = new Set(['v','opId','deviceId','localSeq','scope','kind','objectId','revisionId','previousRevisionId','baseRevisionId','revisionBytes','revisionSha256','statement']);
export function sha256(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)]));
  return value;
}
export function canonicalOperation(op: ReplicaOperation): string { return JSON.stringify(canonical(op)); }
export function canonicalJson(value:unknown):string{return JSON.stringify(canonical(value));}
export function validateOperation(value: unknown): asserts value is ReplicaOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('operation must be an object');
  const op = value as Record<string, unknown>;
  if (Object.keys(op).some(k => !KEYS.has(k))) throw new Error('unknown operation field');
  for (const key of ['v','opId','deviceId','localSeq','scope','kind','objectId','revisionId','previousRevisionId','baseRevisionId','revisionBytes','revisionSha256']) if (!(key in op)) throw new Error(`missing ${key}`);
  if (op.v !== 1 || typeof op.opId !== 'string' || !UUID.test(op.opId) || typeof op.deviceId !== 'string' || !UUID.test(op.deviceId)) throw new Error('invalid operation or device id');
  if (!Number.isSafeInteger(op.localSeq) || (op.localSeq as number) < 1) throw new Error('invalid local sequence');
  if (!op.scope || typeof op.scope !== 'object' || (op.scope as Record<string,unknown>).type !== 'workspace' || typeof (op.scope as Record<string,unknown>).workspaceId !== 'string' || !ID.test(String((op.scope as Record<string,unknown>).workspaceId)) || Object.keys(op.scope).some(k => !['type','workspaceId'].includes(k))) throw new Error('invalid workspace scope');
  if (!(REPLICA_KINDS as readonly unknown[]).includes(op.kind)) throw new Error('invalid kind');
  for (const key of ['objectId','revisionId']) if (typeof op[key] !== 'string' || !ID.test(op[key] as string)) throw new Error(`invalid ${key}`);
  for (const key of ['previousRevisionId','baseRevisionId']) if (op[key] !== null && (typeof op[key] !== 'string' || !ID.test(op[key] as string))) throw new Error(`invalid ${key}`);
  if (typeof op.revisionBytes !== 'string' || Buffer.byteLength(op.revisionBytes) > MAX_REVISION_BYTES) throw new Error('revision exceeds size limit');
  if (typeof op.revisionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(op.revisionSha256) || sha256(op.revisionBytes) !== op.revisionSha256) throw new Error('revision hash mismatch');
  if (op.kind === 'preference_statement') {
    if (op.revisionBytes !== '' || !op.statement || typeof op.statement !== 'object' || Object.keys(op.statement as object).some(k => !['text','category','preferenceKey','sensitive'].includes(k))) throw new Error('invalid preference statement operation');
    const statement = op.statement as Record<string,unknown>;
    if (typeof statement.text !== 'string' || !statement.text.trim() || Buffer.byteLength(statement.text) > 4096 || typeof statement.preferenceKey !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(statement.preferenceKey) || !['preference','goal','interest','capability','working_style','knowledge_gap'].includes(String(statement.category)) || (statement.sensitive !== undefined && typeof statement.sensitive !== 'boolean')) throw new Error('invalid preference statement');
  } else if (op.statement !== undefined) throw new Error('statement is only valid for preference_statement');
}
export function createOperation(input: Omit<ReplicaOperation,'v'|'opId'|'revisionSha256'> & { opId?: string }): ReplicaOperation {
  const { opId = randomUUID(), ...rest } = input;
  const op = { v: 1 as const, opId, ...rest, revisionSha256: sha256(rest.revisionBytes) };
  validateOperation(op); return op;
}
