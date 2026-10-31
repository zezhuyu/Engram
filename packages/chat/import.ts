import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { MDBError, type Document, type Scope } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { ChatProjectRegistry, type ChatProvider, type ProjectMembership } from './projects.js';
import { accountSearchTag } from './conversations.js';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool' | 'other';
export interface ChatContentPart { kind: 'text' | 'attachment' | 'reference' | 'structured'; value: string; contentType?: string }
export interface NormalizedChatEvent {
  schemaVersion: 1;
  provider: ChatProvider;
  externalConversationId: string;
  externalMessageId: string;
  externalProjectId?: string;
  role: ChatRole;
  contentParts: ChatContentPart[];
  timestamp?: string;
  parentMessageId?: string;
  branchId?: string;
  sourceRevision?: string;
  sourceFormatVersion?: string;
  importBatchId?: string;
  conversationTitle?: string;
  /** Provider marks this message as hidden from its ordinary conversation view. */
  hidden?: boolean;
  warnings?: string[];
}

export interface ImportWarning { code: string; record: number; message: string }
export interface ImportResult {
  mode: 'preview' | 'run';
  batchId: string;
  processed: number;
  imported: number;
  duplicates: number;
  pending: number;
  rejected: number;
  nextOffset: number;
  complete: boolean;
  warnings: ImportWarning[];
}

const MAX_TEXT = 100_000;
const MAX_PARTS = 100;
const MAX_CONVERSATION = 100_000;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const ROLES = new Set<ChatRole>(['user', 'assistant', 'system', 'tool', 'other']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const obj = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
function isSafeAttachmentReference(value: string): boolean {
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  let decoded: string;
  try {
    decoded = value;
    for (let depth = 0; depth < 4; depth++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
      if (depth === 3 && /%[0-9a-f]{2}/iu.test(decoded)) return false;
    }
  } catch { return false; }
  if (/[\u0000-\u001f\u007f]/u.test(decoded)) return false;
  if (/^file:/iu.test(decoded) || /^javascript:/iu.test(decoded) || /^data:/iu.test(decoded)) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(decoded) && !/^https?:\/\//iu.test(decoded)) return false;
  if (/^https?:\/\//iu.test(decoded)) {
    try {
      // Check the decoded source path before URL canonicalization removes dot segments.
      // These URLs remain inert (never fetched), but traversal-shaped references are
      // rejected consistently with local attachment paths.
      const rawPath = decoded.match(/^https?:\/\/[^/?#]*(\/[^?#]*)?/iu)?.[1] ?? '';
      if (rawPath.split('/').includes('..')) return false;
      const url = new URL(decoded);
      if (url.username || url.password) return false;
      // External URLs are inert references only; Engram never fetches them.
      return Boolean(url.hostname) && !/[\u0000-\u001f\u007f]/u.test(url.href);
    } catch { return false; }
  }
  if (decoded.startsWith('/') || decoded.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(decoded)) return false;
  return !decoded.split(/[\\/]/u).includes('..');
}
const safeId = (value: unknown, label: string, max = 512): string => {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new MDBError('INVALID_INPUT', `Invalid chat ${label}`);
  return value;
};
function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Millisecond Unix timestamps are at least 100 billion; using 10 billion
    // misclassified valid second timestamps in the late 2280s and beyond.
    const ms = value >= 100_000_000_000 ? value : value * 1000;
    const date = new Date(ms); return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}
function normalizeParts(value: unknown): { parts: ChatContentPart[]; warnings: string[] } {
  const warnings: string[] = [], parts: ChatContentPart[] = [];
  const addText = (v: string) => { if (v.length > MAX_TEXT) { parts.push({ kind: 'text', value: v.slice(0, MAX_TEXT) }); warnings.push('message_text_truncated'); } else if (v) parts.push({ kind: 'text', value: v }); };
  const addAttachment = (raw: unknown, kind: 'attachment' | 'reference' = 'attachment') => {
    const value = typeof raw === 'string' ? raw : text(obj(raw)?.value) ?? text(obj(raw)?.url) ?? text(obj(raw)?.name) ?? text(obj(raw)?.path);
    if (!value) { warnings.push('attachment_without_safe_reference'); return; }
    if (!isSafeAttachmentReference(value)) { warnings.push('unsafe_attachment_reference'); return; }
    parts.push({ kind, value });
  };
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  for (const item of values.slice(0, MAX_PARTS)) {
    if (typeof item === 'string') addText(item);
    else {
      const record = obj(item);
      if (!record) { warnings.push('unsupported_content_part'); continue; }
      const kind = text(record.kind) ?? text(record.type) ?? text(record.content_type) ?? '';
      // Claude tool/thinking blocks are structured provider data even when a
      // field such as `content` is present. Keep their type and bounded payload
      // instead of flattening tool output into ordinary transcript text.
      if (/thinking|tool_use|tool_result|server_tool|redacted_thinking/i.test(kind)) {
        const serialized = JSON.stringify(record);
        if (serialized.length <= MAX_TEXT) parts.push({ kind: 'structured', contentType: kind, value: serialized });
        else warnings.push('structured_content_too_large');
        continue;
      }
      const body = text(record.text) ?? text(record.content);
      if (body) addText(body);
      else if (/image_asset_pointer/i.test(kind)) {
        const pointer = text(record.asset_pointer) ?? text(record.assetPointer);
        if (pointer && pointer.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(pointer)) parts.push({ kind: 'structured', contentType: kind, value: pointer });
        else warnings.push('image_asset_pointer_unavailable');
      }
      else if (/attach|image|file|audio|video/i.test(kind)) addAttachment(record, 'attachment');
      else if (/reference|link/i.test(kind)) addAttachment(record, 'reference');
      else if (text(record.url) || text(record.path)) addAttachment(record, 'reference');
      else warnings.push('unsupported_content_part');
    }
  }
  if (values.length > MAX_PARTS) warnings.push('content_parts_truncated');
  return { parts, warnings };
}
function role(value: unknown): ChatRole {
  const raw = String(value ?? '').toLowerCase();
  if (['user', 'human'].includes(raw)) return 'user';
  if (['assistant', 'ai', 'model'].includes(raw)) return 'assistant';
  if (['system', 'tool', 'function'].includes(raw)) return raw === 'function' ? 'tool' : raw as ChatRole;
  return 'other';
}
function event(input: Record<string, unknown>): NormalizedChatEvent {
  const provider = input.provider;
  if (!['chatgpt', 'claude', 'gemini', 'generic'].includes(String(provider))) throw new MDBError('INVALID_INPUT', 'Unsupported chat provider');
  const content = normalizeParts(input.contentParts ?? input.content ?? input.text ?? input.parts);
  const warnings = [...(Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string').slice(0, 20) : []), ...content.warnings];
  const timestamp = normalizeTimestamp(input.timestamp ?? input.createdAt ?? input.create_time ?? input.created_at);
  if ((input.timestamp ?? input.createdAt ?? input.create_time ?? input.created_at) !== undefined && !timestamp) warnings.push('invalid_timestamp');
  return {
    schemaVersion: 1,
    provider: provider as ChatProvider,
    externalConversationId: safeId(input.externalConversationId ?? input.conversationId ?? input.conversation_id ?? input.chat_id, 'conversation id'),
    externalMessageId: safeId(input.externalMessageId ?? input.messageId ?? input.message_id ?? input.id, 'message id'),
    ...(input.externalProjectId ?? input.projectId ?? input.project_id ? { externalProjectId: safeId(input.externalProjectId ?? input.projectId ?? input.project_id, 'project id') } : {}),
    role: role(input.role ?? input.sender ?? input.authorRole),
    contentParts: content.parts,
    ...(timestamp ? { timestamp } : {}),
    ...(text(input.parentMessageId ?? input.parent_id ?? input.parentMessageUuid) ? { parentMessageId: text(input.parentMessageId ?? input.parent_id ?? input.parentMessageUuid)!.slice(0, 512) } : {}),
    ...(text(input.branchId ?? input.branch_id) ? { branchId: text(input.branchId ?? input.branch_id)!.slice(0, 512) } : {}),
    ...(text(input.sourceRevision) ? { sourceRevision: text(input.sourceRevision)!.slice(0, 128) } : {}),
    ...(text(input.sourceFormatVersion) ? { sourceFormatVersion: text(input.sourceFormatVersion)!.slice(0, 128) } : {}),
    ...(text(input.importBatchId) ? { importBatchId: text(input.importBatchId)!.slice(0, 128) } : {}),
    ...(text(input.conversationTitle ?? input.title) ? { conversationTitle: text(input.conversationTitle ?? input.title)!.slice(0, 500) } : {}),
    ...(input.hidden === true ? { hidden: true } : {}),
    ...(warnings.length ? { warnings: [...new Set(warnings)] } : {})
  };
}

/** Generic portable schema: {schemaVersion:1, conversations:[{id,title,projectId,messages:[...]}]}. */
export function parseGenericJson(raw: string | unknown): NormalizedChatEvent[] {
  let value = raw;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > MAX_JSON_BYTES) throw new MDBError('INVALID_INPUT', 'Generic JSON export exceeds the 64 MiB in-memory parser bound; use JSONL');
    try { value = JSON.parse(raw) as unknown; } catch { throw new MDBError('INVALID_INPUT', 'Invalid generic chat JSON'); }
  }
  const root = obj(value), conversations = Array.isArray(value) ? value : root?.schemaVersion === 1 && Array.isArray(root.conversations) ? root.conversations : undefined;
  if (!conversations || conversations.length > MAX_CONVERSATION) throw new MDBError('INVALID_INPUT', 'Expected a bounded array or schemaVersion 1 conversations export');
  const out: NormalizedChatEvent[] = [];
  for (const item of conversations) {
    const conversation = obj(item); if (!conversation) throw new MDBError('INVALID_INPUT', 'Conversation must be an object');
    const conversationId = safeId(conversation.id ?? conversation.conversationId, 'conversation id');
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (messages.length > MAX_CONVERSATION) throw new MDBError('INVALID_INPUT', 'Conversation exceeds message limit');
    for (const message of messages) {
      const m = obj(message); if (!m) throw new MDBError('INVALID_INPUT', 'Message must be an object');
      out.push(event({ ...m, provider: 'generic', externalConversationId: conversationId, conversationTitle: conversation.title, externalProjectId: conversation.projectId, sourceFormatVersion: 'engram-generic-v1' }));
    }
  }
  return out;
}

/** Bounded JSONL parser. Each line is one generic message and carries conversationId. */
export async function* parseGenericJsonl(chunks: AsyncIterable<string | Uint8Array>): AsyncGenerator<NormalizedChatEvent> {
  const decoder = new TextDecoder(); let pending = '', lineNumber = 0;
  for await (const chunk of chunks) {
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pending) > MAX_LINE_BYTES && !pending.includes('\n')) throw new MDBError('INVALID_INPUT', 'JSONL line exceeds the 2 MiB parser bound');
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/u, ''); pending = pending.slice(newline + 1); lineNumber++;
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new MDBError('INVALID_INPUT', `JSONL line ${lineNumber} exceeds the 2 MiB parser bound`);
      let record: unknown; try { record = JSON.parse(line) as unknown; } catch { throw new MDBError('INVALID_INPUT', `Invalid JSONL record at line ${lineNumber}`); }
      const r = obj(record); if (!r) throw new MDBError('INVALID_INPUT', `JSONL record ${lineNumber} must be an object`);
      yield event({ ...r, provider: 'generic' });
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    lineNumber++;
    if (Buffer.byteLength(pending) > MAX_LINE_BYTES) throw new MDBError('INVALID_INPUT', `JSONL line ${lineNumber} exceeds the 2 MiB parser bound`);
    let record: unknown; try { record = JSON.parse(pending) as unknown; } catch { throw new MDBError('INVALID_INPUT', `Invalid JSONL record at line ${lineNumber}`); }
    const r = obj(record); if (!r) throw new MDBError('INVALID_INPUT', `JSONL record ${lineNumber} must be an object`);
    yield event({ ...r, provider: 'generic' });
  }
}

/** ChatGPT conversations.json variant using the mapping tree; sibling branches remain addressable via parent/branch metadata. */
export function parseChatGptExport(raw: string | unknown): NormalizedChatEvent[] {
  const value = parseJsonValue(raw), conversations = Array.isArray(value) ? value : undefined;
  if (!conversations || conversations.length > MAX_CONVERSATION) throw new MDBError('INVALID_INPUT', 'Expected ChatGPT conversations.json array');
  const out: NormalizedChatEvent[] = [];
  for (const item of conversations) {
    const c = obj(item); if (!c) throw new MDBError('INVALID_INPUT', 'Invalid ChatGPT conversation record');
    const conversationId = safeId(c.id ?? c.conversation_id, 'conversation id'), mapping = obj(c.mapping);
    if (!mapping) throw new MDBError('INVALID_INPUT', 'ChatGPT conversation mapping is missing');
    const nodes = Object.entries(mapping).map(([nodeId, rawNode]) => ({ nodeId, node: obj(rawNode) })).filter((x): x is { nodeId: string; node: Record<string, unknown> } => Boolean(x.node));
    if (nodes.length > MAX_CONVERSATION) throw new MDBError('INVALID_INPUT', 'ChatGPT conversation exceeds message limit');
    const nonNull = nodes.filter(item => obj(item.node.message));
    for (const { nodeId, node } of nonNull) {
      const message = obj(node.message)!; const author = obj(message.author) ?? {};
      const content = obj(message.content) ?? {};
      const refs = Array.isArray(content.parts) ? content.parts : content.text ? [content.text] : [];
      const children = Array.isArray(node.children) ? node.children.filter((id): id is string => typeof id === 'string') : [];
      const metadata = obj(message.metadata) ?? {};
      out.push(event({ provider: 'chatgpt', externalConversationId: conversationId, externalMessageId: safeId(message.id ?? nodeId, 'message id'), role: role(author.role), contentParts: refs, timestamp: message.create_time ?? message.created_at, parentMessageId: text(node.parent), branchId: children.length > 1 ? nodeId : undefined, externalProjectId: c.project_id, conversationTitle: c.title, hidden: metadata.is_visually_hidden_from_conversation === true, sourceFormatVersion: 'chatgpt-conversations-mapping-v1' }));
    }
  }
  return out;
}

/** Claude export variant using conversation UUID and human/assistant chat_messages. */
export function parseClaudeExport(raw: string | unknown): NormalizedChatEvent[] {
  const value = parseJsonValue(raw), root = obj(value), conversations = Array.isArray(value) ? value : Array.isArray(root?.conversations) ? root.conversations : undefined;
  if (!conversations || conversations.length > MAX_CONVERSATION) throw new MDBError('INVALID_INPUT', 'Expected Claude conversations export');
  const out: NormalizedChatEvent[] = [];
  for (const item of conversations) {
    const c = obj(item); if (!c) throw new MDBError('INVALID_INPUT', 'Invalid Claude conversation');
    const conversationId = safeId(c.uuid ?? c.id ?? c.conversation_id, 'conversation id');
    const messages = Array.isArray(c.chat_messages) ? c.chat_messages : Array.isArray(c.messages) ? c.messages : undefined;
    if (!messages || messages.length > MAX_CONVERSATION) throw new MDBError('INVALID_INPUT', 'Claude conversation messages are missing or over limit');
    for (const rawMessage of messages) {
      const m = obj(rawMessage); if (!m) throw new MDBError('INVALID_INPUT', 'Invalid Claude message');
      const sender = m.sender ?? obj(m.author)?.role;
      const content = Array.isArray(m.content) ? m.content : m.text;
      const additional = [...(Array.isArray(m.attachments) ? m.attachments : []), ...(Array.isArray(m.files) ? m.files : [])].map(part => ({ type: 'file_attachment', ...obj(part) }));
      out.push(event({ provider: 'claude', externalConversationId: conversationId, externalMessageId: m.uuid ?? m.id ?? m.message_id, role: role(sender), contentParts: [...(Array.isArray(content) ? content : [content]), ...additional], timestamp: m.created_at ?? m.createdAt, parentMessageId: m.parent_message_uuid ?? m.parent_id, branchId: m.branch_id, externalProjectId: c.project_id, conversationTitle: c.name ?? c.title, sourceFormatVersion: 'claude-chat-messages-v1' }));
    }
  }
  return out;
}

/** Gemini Apps Takeout My Activity JSON. Activity rows yield user prompts when present; no assistant answer is invented. */
export function parseGeminiTakeoutActivity(raw: string | unknown): NormalizedChatEvent[] {
  const value = parseJsonValue(raw), rows = Array.isArray(value) ? value : Array.isArray(obj(value)?.activities) ? obj(value)!.activities as unknown[] : undefined;
  if (!rows || rows.length > MAX_CONVERSATION) throw new MDBError('INVALID_INPUT', 'Expected a bounded Gemini Apps My Activity JSON array');
  const out: NormalizedChatEvent[] = [];
  const fallbackOccurrences = new Map<string, number>();
  rows.forEach(item => {
    const row = obj(item); if (!row) return;
    const products = Array.isArray(row.products) ? row.products.map(String) : [];
    const heading = text(row.title) ?? '';
    if (!products.some(p => /gemini/i.test(p)) && !/gemini/i.test(heading)) return;
    const details = Array.isArray(row.details) ? row.details.map(obj).filter((v): v is Record<string, unknown> => Boolean(v)) : [];
    const named = (pattern: RegExp) => { const detail = details.find(item => pattern.test(String(item.name ?? ''))); return text(detail?.string_value) ?? text(detail?.value); };
    const promptValue = named(/prompt|user/i);
    const prompt = text(promptValue) ?? (/^prompted gemini\s*:/i.test(heading) ? heading.replace(/^prompted gemini\s*:/i, '').trim() : undefined);
    if (!prompt) return;
    const activityId = text(row.id) ?? text(row.activityId) ?? (() => {
      const fingerprint = hash(`${text(row.time) ?? 'unknown'}\0${heading.normalize('NFC')}\0${prompt.normalize('NFC')}`);
      const occurrence = fallbackOccurrences.get(fingerprint) ?? 0; fallbackOccurrences.set(fingerprint, occurrence + 1);
      return `derived-${fingerprint.slice(0, 32)}-${occurrence}`;
    })();
    const timestamp = text(row.time);
    out.push(event({ provider: 'gemini', externalConversationId: `activity-${activityId}`, externalMessageId: `prompt-${activityId}`, role: 'user', contentParts: [prompt], timestamp, conversationTitle: heading.slice(0, 500), sourceFormatVersion: 'google-takeout-my-activity-gemini-v1', warnings: ['takeout_activity_prompt_only'] }));
    const response = text(named(/response|answer/i));
    if (response) out.push(event({ provider: 'gemini', externalConversationId: `activity-${activityId}`, externalMessageId: `response-${activityId}`, role: 'assistant', contentParts: [response], timestamp, parentMessageId: `prompt-${activityId}`, conversationTitle: heading.slice(0, 500), sourceFormatVersion: 'google-takeout-my-activity-gemini-v1' }));
  });
  return out;
}

/** Reads bounded ChatGPT conversation JSON members without extracting them to disk. */
export function parseChatGptZip(archive: Uint8Array): NormalizedChatEvent[] {
  // OpenAI exports may split large histories into numbered JSON files. Sort by
  // numeric suffix rather than trusting archive member order so resumes produce
  // a stable source sequence. Keep the aggregate decoded size bounded too.
  const members = readZipMembers(archive, name => /^conversations(?:-\d+)?\.json$/iu.test(name.split('/').at(-1) ?? ''));
  members.sort((a, b) => {
    const suffix = (name: string) => Number(name.split('/').at(-1)?.match(/^conversations-(\d+)\.json$/iu)?.[1] ?? 0);
    return suffix(a.name) - suffix(b.name) || a.name.localeCompare(b.name);
  });
  const events: NormalizedChatEvent[] = [];
  for (const member of members) {
    const parsed = parseChatGptExport(member.content.toString('utf8'));
    if (events.length + parsed.length > MAX_CONVERSATION) throw new MDBError('INVALID_INPUT', 'ChatGPT export exceeds the 100000-message aggregate limit');
    events.push(...parsed);
  }
  return events;
}

/** Bounded Claude export archive adapter; the nested JSON variant still requires fixture verification. */
export function parseClaudeZip(archive: Uint8Array): NormalizedChatEvent[] {
  return parseClaudeExport(readZipMember(archive, name => name === 'conversations.json').toString('utf8'));
}

/** Google Takeout archive path adapter; direct format support remains provisional until an authorized real fixture is tested. */
export function parseGeminiTakeoutZip(archive: Uint8Array): NormalizedChatEvent[] {
  return parseGeminiTakeoutActivity(readZipMember(archive, name => /(?:^|\/)My Activity\/Gemini Apps\/MyActivity\.json$/iu.test(name)).toString('utf8'));
}

function readZipMember(archive: Uint8Array, wanted: (name: string) => boolean): Buffer {
  const members = readZipMembers(archive, wanted);
  if (members.length !== 1) throw new MDBError('INVALID_INPUT', 'ZIP must contain exactly one expected provider export member');
  return members[0]!.content;
}

function readZipMembers(archive: Uint8Array, wanted: (name: string) => boolean): Array<{ name: string; content: Buffer }> {
  const bytes = Buffer.from(archive);
  if (bytes.length > 256 * 1024 * 1024) throw new MDBError('INVALID_INPUT', 'ChatGPT ZIP exceeds the 256 MiB archive bound');
  const start = Math.max(0, bytes.length - 65_557); let eocd = -1;
  for (let at = bytes.length - 22; at >= start; at--) if (bytes.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  if (eocd < 0 || eocd + 22 > bytes.length) throw new MDBError('INVALID_INPUT', 'Invalid ZIP end record');
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8), entries = bytes.readUInt16LE(eocd + 10), cdSize = bytes.readUInt32LE(eocd + 12), cdOffset = bytes.readUInt32LE(eocd + 16);
  if (entriesOnDisk !== entries || entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || entries > 10_000 || cdOffset + cdSize !== eocd) throw new MDBError('INVALID_INPUT', 'ZIP directory is invalid, multi-disk, ZIP64, or exceeds limits');
  let offset = cdOffset, selectedBytes = 0;
  const found: Array<{ name: string; content: Buffer }> = [];
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new MDBError('INVALID_INPUT', 'Invalid ZIP central directory');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16), compressedSize = bytes.readUInt32LE(offset + 20), uncompressedSize = bytes.readUInt32LE(offset + 24), nameLen = bytes.readUInt16LE(offset + 28), extraLen = bytes.readUInt16LE(offset + 30), commentLen = bytes.readUInt16LE(offset + 32), localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new MDBError('INVALID_INPUT', 'ZIP contains an unsafe member path');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new MDBError('INVALID_INPUT', 'ZIP64 members are unsupported');
    if (wanted(name)) {
      if (found.some(member => member.name === name)) throw new MDBError('INVALID_INPUT', 'ZIP contains duplicate provider export member names');
      if (flags & 0x41) throw new MDBError('INVALID_INPUT', 'Encrypted ZIP members are unsupported');
      selectedBytes += uncompressedSize;
      if (selectedBytes > MAX_JSON_BYTES || compressedSize > bytes.length) throw new MDBError('INVALID_INPUT', 'Selected provider export members exceed the 64 MiB aggregate limit');
      if (localOffset + 30 > cdOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new MDBError('INVALID_INPUT', 'Invalid ZIP local header');
      const localFlags = bytes.readUInt16LE(localOffset + 6), localMethod = bytes.readUInt16LE(localOffset + 8), localNameLen = bytes.readUInt16LE(localOffset + 26), localExtraLen = bytes.readUInt16LE(localOffset + 28);
      const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8');
      if (localName !== name || localFlags !== flags || localMethod !== method) throw new MDBError('INVALID_INPUT', 'ZIP local and central member headers disagree');
      if (!(flags & 8) && (bytes.readUInt32LE(localOffset + 14) !== crc || bytes.readUInt32LE(localOffset + 18) !== compressedSize || bytes.readUInt32LE(localOffset + 22) !== uncompressedSize)) throw new MDBError('INVALID_INPUT', 'ZIP local and central member lengths/checksum disagree');
      const dataStart = localOffset + 30 + localNameLen + localExtraLen, dataEnd = dataStart + compressedSize;
      if (dataEnd > cdOffset) throw new MDBError('INVALID_INPUT', 'Truncated ZIP member');
      const compressed = bytes.subarray(dataStart, dataEnd);
      let content: Buffer;
      try { content = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_JSON_BYTES }) : (() => { throw new Error('unsupported compression'); })(); }
      catch { throw new MDBError('INVALID_INPUT', 'Unsupported or invalid ZIP compression'); }
      if (content.length !== uncompressedSize || crc32(content) !== crc) throw new MDBError('INVALID_INPUT', 'ZIP member checksum mismatch');
      found.push({ name, content });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  if (found.length === 0) throw new MDBError('INVALID_INPUT', 'ZIP does not contain the expected bounded provider export member');
  return found;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseJsonValue(raw: string | unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (Buffer.byteLength(raw) > MAX_JSON_BYTES) throw new MDBError('INVALID_INPUT', 'Provider JSON exceeds the 64 MiB parser bound; convert to bounded JSONL');
  try { return JSON.parse(raw) as unknown; } catch { throw new MDBError('INVALID_INPUT', 'Invalid provider export JSON'); }
}

export interface ChatImportOptions {
  provider: ChatProvider;
  /** This identity comes from the local account registration, never from import content. */
  sourceAccountId: string;
  batchId: string;
  sourceSha256: string;
  membershipForProject?: (externalProjectId: string | undefined) => ProjectMembership;
  maxRecords?: number;
  startOffset?: number;
  preview?: boolean;
}

function normalizeMessageBody(parts: ChatContentPart[]): string {
  return parts.map(part => part.kind === 'text' ? part.value : `[${part.kind}${part.contentType ? `:${part.contentType}` : ''}: ${part.value}]`).join('\n').slice(0, MAX_TEXT + MAX_PARTS * 2048);
}
function scopeOf(workspaceId: string): Scope { return { type: 'workspace', workspaceId }; }
function messageKey(provider: ChatProvider, account: string, conversation: string, message: string, workspace: string): string { return hash([provider, account, conversation, message, workspace].join('\0')); }
const SOURCE_PROVENANCE_FIELDS = ['provider', 'sourceAccountId', 'externalConversationId', 'externalMessageId', 'externalProjectId', 'projectMembership', 'routingReason', 'bindingVersion', 'role', 'speaker', 'hidden', 'sourceTimestamp', 'parentMessageId', 'branchId', 'sourceRevision', 'sourceFormatVersion', 'conversationTitle'] as const;
function sourceProvenanceHash(metadata: Record<string, unknown>): string {
  const provenance = Object.fromEntries(SOURCE_PROVENANCE_FIELDS.map(key => [key, metadata[key] ?? null]));
  return hash(JSON.stringify(provenance));
}

/** Durable, replay-safe batch importer. Each message commit is acknowledged before its checkpoint advances. */
export async function importChatEvents(vault: Vault, registry: ChatProjectRegistry, events: AsyncIterable<NormalizedChatEvent> | Iterable<NormalizedChatEvent>, options: ChatImportOptions): Promise<ImportResult> {
  if (!/^[a-f0-9]{64}$/i.test(options.sourceSha256)) throw new MDBError('INVALID_INPUT', 'sourceSha256 must be a SHA-256 digest');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.batchId)) throw new MDBError('INVALID_INPUT', 'Invalid import batch id');
  if (!Number.isInteger(options.maxRecords ?? 500) || (options.maxRecords ?? 500) < 1 || (options.maxRecords ?? 500) > 10_000) throw new MDBError('INVALID_INPUT', 'maxRecords must be 1-10000');
  if (!Number.isInteger(options.startOffset ?? 0) || (options.startOffset ?? 0) < 0) throw new MDBError('INVALID_INPUT', 'startOffset must be nonnegative');
  const personal = scopeOf('personal');
  if (!(await vault.canAccess(personal, options.preview ? 'read' : 'write'))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Personal workspace access is required for chat imports');
  const batchId = options.batchId, checkpointDocs = await vault.listDocuments({ scopes: [personal] });
  let checkpoint = checkpointDocs.find(doc => doc.kind === 'chat_import_run' && doc.metadata.batchId === batchId);
  if (checkpoint) {
    const saved = JSON.parse(checkpoint.body) as { provider: ChatProvider; sourceAccountId: string; sourceSha256: string; nextOffset: number; status: string };
    if (saved.provider !== options.provider || saved.sourceAccountId !== options.sourceAccountId || saved.sourceSha256 !== options.sourceSha256) throw new MDBError('CONFLICT', 'Import batch identity or source hash changed');
    if (options.startOffset !== undefined && options.startOffset !== saved.nextOffset) throw new MDBError('CONFLICT', 'Import resume offset does not match durable checkpoint');
  } else if (!options.preview && (options.startOffset ?? 0) !== 0) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Import batch checkpoint not found');
  let offset = checkpoint ? Number((JSON.parse(checkpoint.body) as { nextOffset: number }).nextOffset) : options.startOffset ?? 0;
  const result: ImportResult = { mode: options.preview ? 'preview' : 'run', batchId, processed: 0, imported: 0, duplicates: 0, pending: 0, rejected: 0, nextOffset: offset, complete: false, warnings: [] };
  let checkpointOffset = offset;
  const maybeCheckpoint = async () => {
    if (!options.preview && offset - checkpointOffset >= 100) {
      checkpoint = await saveCheckpoint(vault, personal, checkpoint, options, offset, 'running');
      checkpointOffset = offset;
    }
  };
  if (!options.preview) {
    for (const warning of checkpointDocs.filter(doc => doc.kind === 'chat_import_warning' && doc.metadata.batchId === batchId)) {
      try {
        const saved = JSON.parse(warning.body) as ImportWarning;
        if (Number.isSafeInteger(saved.record) && typeof saved.code === 'string' && typeof saved.message === 'string') result.warnings.push(saved);
      } catch { /* A malformed diagnostic record must not block transcript recovery. */ }
    }
  }
  const docIndex = new Map<string, Document>();
  if (!options.preview) for (const doc of await vault.listDocuments()) if (doc.kind === 'chat_message') {
    const key = messageKey(String(doc.metadata.provider) as ChatProvider, String(doc.metadata.sourceAccountId), String(doc.metadata.externalConversationId), String(doc.metadata.externalMessageId), doc.scope.type === 'workspace' ? doc.scope.workspaceId : '');
    docIndex.set(key, doc);
  }
  const iterator = Symbol.asyncIterator in Object(events) ? (events as AsyncIterable<NormalizedChatEvent>)[Symbol.asyncIterator]() : (async function* () { yield* events as Iterable<NormalizedChatEvent>; })()[Symbol.asyncIterator]();
  let skipped = 0, unresolved = false, ended = false;
  try {
  while (result.processed < (options.maxRecords ?? 500)) {
    const item = await iterator.next(); if (item.done) { ended = true; break; }
    if (skipped++ < offset) continue;
    const current = item.value;
    try {
      if (current.schemaVersion !== 1 || current.provider !== options.provider) throw new MDBError('INVALID_INPUT', 'Normalized event provider/schema mismatch');
      const conversation = safeId(current.externalConversationId, 'conversation id'), message = safeId(current.externalMessageId, 'message id');
      if (current.externalProjectId !== undefined) safeId(current.externalProjectId, 'project id');
      if (current.parentMessageId !== undefined) safeId(current.parentMessageId, 'parent message id');
      if (current.branchId !== undefined) safeId(current.branchId, 'branch id');
      for (const [label, value, max] of [['source revision', current.sourceRevision, 256], ['source format version', current.sourceFormatVersion, 128], ['source batch id', current.importBatchId, 128], ['conversation title', current.conversationTitle, 500]] as const) {
        if (value !== undefined && (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))) throw new MDBError('INVALID_INPUT', `Invalid normalized ${label}`);
      }
      if (!ROLES.has(current.role)) throw new MDBError('INVALID_INPUT', 'Invalid normalized message role');
      if (!Array.isArray(current.contentParts) || current.contentParts.length > MAX_PARTS || current.contentParts.some(part => !part || !['text', 'attachment', 'reference', 'structured'].includes(part.kind) || typeof part.value !== 'string' || part.value.length > MAX_TEXT || part.contentType !== undefined && (typeof part.contentType !== 'string' || part.contentType.length > 100 || !/^[a-z0-9_.:-]+$/iu.test(part.contentType)))) throw new MDBError('INVALID_INPUT', 'Invalid normalized content parts');
      if (current.contentParts.some(part => part.kind === 'attachment' || part.kind === 'reference' ? !isSafeAttachmentReference(part.value) : false)) throw new MDBError('INVALID_INPUT', 'Invalid normalized attachment reference');
      if (current.timestamp !== undefined && !normalizeTimestamp(current.timestamp)) throw new MDBError('INVALID_INPUT', 'Invalid normalized message timestamp');
      if (current.warnings !== undefined && (!Array.isArray(current.warnings) || current.warnings.length > 20 || current.warnings.some(warning => typeof warning !== 'string' || !/^[a-z0-9_:-]{1,100}$/iu.test(warning)))) throw new MDBError('INVALID_INPUT', 'Invalid normalization warnings');
      const membership = options.membershipForProject?.(current.externalProjectId) ?? 'unknown';
      const route = await registry.resolveProject({ provider: options.provider, sourceAccountId: options.sourceAccountId, ...(current.externalProjectId ? { externalProjectId: current.externalProjectId } : {}), membership, access: options.preview ? 'read' : 'write' });
      if (route.status !== 'routed') {
        result.pending++; unresolved = true;
        result.warnings.push({ code: route.status === 'pending' ? 'project_unmapped' : 'membership_review_required', record: offset + result.processed, message: route.reason });
        if (!options.preview) await savePending(vault, personal, options, current, route.reason);
        break; // Do not checkpoint beyond the first unresolved source record.
      }
      const scope = scopeOf(route.workspaceId);
      if (!(await vault.canAccess(scope, options.preview ? 'read' : 'write'))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Destination workspace is not authorized');
      const body = normalizeMessageBody(current.contentParts), bodyHash = hash(body), stable = messageKey(options.provider, options.sourceAccountId, conversation, message, route.workspaceId);
      const mapKey = stable, previous = docIndex.get(mapKey);
      const metadata = {
        chatSchema: 1, provider: options.provider, sourceAccountId: options.sourceAccountId,
        externalConversationId: conversation, externalMessageId: message, externalProjectId: current.externalProjectId ?? null,
        projectMembership: membership, routingReason: route.reason, bindingVersion: route.bindingVersion ?? null,
        // The shared evidence classifier consumes speaker, while conversation
        // search consumes role. Persist both so imported user text is never
        // reclassified as an unattributed agent observation by Profile.
        role: current.role, speaker: current.role, hidden: current.hidden === true, sourceTimestamp: current.timestamp ?? null, parentMessageId: current.parentMessageId ?? null, branchId: current.branchId ?? null,
        sourceRevision: current.sourceRevision ?? null, sourceFormatVersion: current.sourceFormatVersion ?? null, conversationTitle: current.conversationTitle ?? null,
        ...(current.importBatchId ? { sourceImportBatchId: current.importBatchId } : {}),
        contentSha256: bodyHash, sourceSha256: options.sourceSha256, importBatchId: batchId, ...(current.warnings?.length ? { normalizationWarnings: current.warnings.slice(0, 20) } : {})
      };
      const provenanceSha256 = sourceProvenanceHash(metadata);
      Object.assign(metadata, { sourceProvenanceSha256: provenanceSha256 });
      if (previous && previous.metadata.contentSha256 === bodyHash && sourceProvenanceHash(previous.metadata) === provenanceSha256) {
        result.duplicates++; result.processed++; offset++; result.nextOffset = offset;
        await maybeCheckpoint();
        continue;
      }
      if (!options.preview) {
        if (previous) {
          const revisionKey = `chat-import:${stable}:${previous.revisionId}:${bodyHash}:${provenanceSha256}`;
          const saved = await vault.patch({ objectId: previous.id, expectedRevisionId: previous.revisionId, title: current.conversationTitle ?? previous.title, body, tags: ['chat', `chat-provider-${options.provider}`, `chat-role-${current.role}`, accountSearchTag(options.sourceAccountId)], metadataPatch: metadata, idempotencyKey: revisionKey });
          docIndex.set(mapKey, saved);
        } else {
          const key = `chat-import:${stable}:${bodyHash}`;
          const saved = await vault.put({ scope, kind: 'chat_message', title: current.conversationTitle ?? `Chat ${conversation.slice(0, 40)}`, body, tags: ['chat', `chat-provider-${options.provider}`, `chat-role-${current.role}`, accountSearchTag(options.sourceAccountId)], metadata, idempotencyKey: key });
          docIndex.set(mapKey, saved);
        }
      }
      result.imported++; result.processed++; offset++; result.nextOffset = offset;
      await maybeCheckpoint();
      if (current.warnings?.length) for (const warning of current.warnings) result.warnings.push({ code: warning, record: offset - 1, message: warning });
    } catch (error) {
      if (!(error instanceof MDBError) || error.code !== 'INVALID_INPUT') throw error;
      result.rejected++; result.processed++;
      const warning: ImportWarning = { code: error instanceof MDBError ? error.code.toLowerCase() : 'record_error', record: offset, message: error instanceof Error ? error.message.slice(0, 240) : 'Record rejected' };
      result.warnings.push(warning);
      // Rejected records are durably reported as metadata only, then the checkpoint may progress.
      if (!options.preview) {
        await saveImportWarning(vault, personal, options, warning);
        ++offset; await maybeCheckpoint();
      } else offset++;
      result.nextOffset = offset;
    }
  }
  } finally {
    // A bounded batch, unresolved project, or failed commit can stop before EOF.
    // Return the generator so file-backed JSONL sources release their stream now,
    // rather than relying on garbage collection while the caller resumes later.
    if (!ended && typeof iterator.return === 'function') await iterator.return();
  }
  result.complete = ended && !unresolved;
  if (!options.preview && !unresolved && (checkpointOffset !== offset || ended)) {
    checkpoint = await saveCheckpoint(vault, personal, checkpoint, options, offset, ended ? 'complete' : 'running');
    checkpointOffset = offset;
  }
  return result;
}

async function savePending(vault: Vault, scope: Scope, options: ChatImportOptions, event: NormalizedChatEvent, reason: string): Promise<void> {
  const key = hash([options.provider, options.sourceAccountId, event.externalConversationId].join('\0'));
  const idempotencyKey = `chat-pending:${key}:${options.sourceSha256}`;
  try { await vault.put({ scope, kind: 'chat_import_pending', title: 'Unrouted chat import', body: JSON.stringify({ provider: options.provider, sourceAccountId: options.sourceAccountId, externalConversationId: event.externalConversationId, externalProjectId: event.externalProjectId ?? null, reason, sourceSha256: options.sourceSha256, batchId: options.batchId }), idempotencyKey, metadata: { status: 'pending', provider: options.provider, sourceAccountId: options.sourceAccountId, externalConversationId: event.externalConversationId, ...(event.externalProjectId ? { externalProjectId: event.externalProjectId } : {}), reason, sourceSha256: options.sourceSha256, batchId: options.batchId } }); }
  catch (error) { if (!(error instanceof MDBError) || error.code !== 'CONFLICT') throw error; }
}

async function saveImportWarning(vault: Vault, scope: Scope, options: ChatImportOptions, warning: ImportWarning): Promise<void> {
  const value = { schemaVersion: 1, batchId: options.batchId, sourceSha256: options.sourceSha256, ...warning };
  try {
    await vault.put({
      scope,
      kind: 'chat_import_warning',
      title: `Chat import warning at record ${warning.record}`,
      body: JSON.stringify(value),
      idempotencyKey: `chat-import-warning:${options.batchId}:${options.sourceSha256}:${warning.record}`,
      metadata: { batchId: options.batchId, sourceSha256: options.sourceSha256, record: warning.record, code: warning.code },
    });
  } catch (error) {
    if (!(error instanceof MDBError) || error.code !== 'CONFLICT') throw error;
  }
}

async function saveCheckpoint(vault: Vault, scope: Scope, existing: Document | undefined, options: ChatImportOptions, nextOffset: number, status: 'running' | 'complete'): Promise<Document> {
  const value = { schemaVersion: 1, provider: options.provider, sourceAccountId: options.sourceAccountId, sourceSha256: options.sourceSha256, batchId: options.batchId, nextOffset, status, updatedAt: new Date().toISOString() };
  if (existing) {
    try {
      const saved = JSON.parse(existing.body) as { provider?: string; sourceAccountId?: string; sourceSha256?: string; batchId?: string; nextOffset?: number; status?: string };
      if (saved.provider === options.provider && saved.sourceAccountId === options.sourceAccountId && saved.sourceSha256 === options.sourceSha256 && saved.batchId === options.batchId && saved.nextOffset === nextOffset && saved.status === status) return existing;
    } catch { /* Replace an invalid checkpoint only through the normal versioned patch path. */ }
    return vault.patch({ objectId: existing.id, expectedRevisionId: existing.revisionId, body: JSON.stringify(value), metadataPatch: { nextOffset, status, sourceSha256: options.sourceSha256 } });
  }
  return vault.put({ scope, kind: 'chat_import_run', title: `Chat import ${options.batchId}`, body: JSON.stringify(value), idempotencyKey: `chat-import-run:${options.batchId}:start`, metadata: { batchId: options.batchId, provider: options.provider, sourceAccountId: options.sourceAccountId, sourceSha256: options.sourceSha256, nextOffset, status } });
}
