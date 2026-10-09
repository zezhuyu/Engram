import { MDBError } from '../core/types.js';

/** Standard passive-capture envelope (RFC §2). Everything in it is a CLAIM from the host side until checked against a registration. */
export const EVENT_TYPES = ['session.start', 'user.message', 'assistant.message', 'tool.result', 'note.created', 'decision', 'finding', 'task.completed', 'session.end'] as const;
export type MemoryEventType = (typeof EVENT_TYPES)[number];
export const CLASSIFICATIONS = ['public', 'shared', 'workspace_private', 'user_private'] as const;
export interface MemoryEvent {
  eventId: string; timestamp: string; host: string; agentId?: string; sessionId: string; workspaceId: string; collectionId?: string; principalId: string;
  type: MemoryEventType; sourceRef?: string; payloadRef?: string; contentHash?: string;
  classification: (typeof CLASSIFICATIONS)[number]; consentPolicyId: string; schemaVersion: 1;
  /** Already-redacted text. Never hidden reasoning. */
  content?: string; title?: string; metadata?: Record<string, string | number | boolean>;
}
/** Written by the trusted owner at install time; it, not the event, decides identity, workspace and what may be recorded. */
export interface Registration {
  id: string; host: string; principalId: string; workspaceId: string; collectionId?: string;
  capture: MemoryEventType[]; toolAllowlist: string[]; excludePatterns: string[]; consentPolicyId: string; createdAt: string; revoked?: boolean;
  settingsPath?: string; createdSettingsFile?: boolean; permissions: string[];
}
export const DEFAULT_CAPTURE: MemoryEventType[] = ['session.start', 'user.message', 'tool.result', 'session.end', 'task.completed'];
export const DEFAULT_TOOL_ALLOWLIST = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'shell', 'exec_command', 'local_shell'];
const bad = (field: string): never => { throw new MDBError('INVALID_INPUT', `Invalid memory event: ${field}`); };
const text = (v: unknown, field: string, max: number, min = 1): string => { if (typeof v !== 'string' || v.length < min || v.length > max) bad(field); return v as string; };
export function parseMemoryEvent(raw: unknown): MemoryEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('shape');
  const v = raw as Record<string, unknown>;
  const allowed = new Set(['eventId', 'timestamp', 'host', 'agentId', 'sessionId', 'workspaceId', 'collectionId', 'principalId', 'type', 'sourceRef', 'payloadRef', 'contentHash', 'classification', 'consentPolicyId', 'schemaVersion', 'content', 'title', 'metadata']);
  for (const key of Object.keys(v)) if (!allowed.has(key)) bad(`unknown field ${key.slice(0, 30)}`);
  if (v.schemaVersion !== 1) bad('schemaVersion');
  if (!EVENT_TYPES.includes(v.type as MemoryEventType)) bad('type');
  if (!CLASSIFICATIONS.includes(v.classification as never)) bad('classification');
  const timestamp = text(v.timestamp, 'timestamp', 40); if (!Number.isFinite(Date.parse(timestamp)) || !/(Z|[+-]\d\d:?\d\d)$/.test(timestamp)) bad('timestamp (ISO 8601 with offset required)');
  const id = (field: string, max = 128) => { const value = text(v[field], field, max); if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) bad(field); return value; };
  const event: MemoryEvent = { eventId: id('eventId'), timestamp: new Date(timestamp).toISOString(), host: id('host', 40), sessionId: id('sessionId'), workspaceId: id('workspaceId'), principalId: id('principalId'), type: v.type as MemoryEventType, classification: v.classification as MemoryEvent['classification'], consentPolicyId: id('consentPolicyId'), schemaVersion: 1 };
  if (v.agentId !== undefined) event.agentId = id('agentId'); if (v.collectionId !== undefined) event.collectionId = id('collectionId');
  if (v.sourceRef !== undefined) event.sourceRef = text(v.sourceRef, 'sourceRef', 500); if (v.payloadRef !== undefined) event.payloadRef = text(v.payloadRef, 'payloadRef', 500); if (v.contentHash !== undefined) event.contentHash = text(v.contentHash, 'contentHash', 128);
  if (v.content !== undefined) event.content = text(v.content, 'content', 100_000, 0); if (v.title !== undefined) event.title = text(v.title, 'title', 200);
  if (v.metadata !== undefined) { const m = v.metadata; if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).length > 20 || Object.values(m).some(x => !['string', 'number', 'boolean'].includes(typeof x) || (typeof x === 'string' && x.length > 500))) bad('metadata'); event.metadata = m as MemoryEvent['metadata']; }
  return event;
}
