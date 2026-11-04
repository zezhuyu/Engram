import { createHash } from 'node:crypto';
import { MDBError, type Document, type Scope } from '../core/types.js';

export const DEFAULT_SOURCE_LIMIT = 8 * 1024 * 1024;
export const CHAT_BODY_LIMIT = 32 * 1024;
export const CHAT_TIMEOUT_MS = 45_000;
export type SourceUpload = { name: string; type: string; bytes: Buffer };

export function uploadLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MDB_DASHBOARD_UPLOAD_LIMIT_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_SOURCE_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 64 * 1024 * 1024) throw new MDBError('INVALID_INPUT', 'MDB_DASHBOARD_UPLOAD_LIMIT_BYTES must be an integer from 1 to 67108864');
  return value;
}

export function safeSourceName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255) throw new MDBError('INVALID_INPUT', 'A source filename of at most 255 characters is required');
  const name = value.normalize('NFKC').replace(/\\/g, '/').split('/').pop()!.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120);
  if (!name || name === '.' || name === '..') throw new MDBError('INVALID_INPUT', 'Invalid source filename');
  return name;
}

const TYPES: Record<string, { extension: string; type: string; magic: (bytes: Buffer) => boolean; text?: boolean }> = {
  '.txt': { extension: '.txt', type: 'text/plain', magic: b => !b.subarray(0, Math.min(b.length, 8192)).some(byte => byte === 0 || byte < 9 || byte > 13 && byte < 32), text: true },
  '.md': { extension: '.md', type: 'text/markdown', magic: b => !b.subarray(0, Math.min(b.length, 8192)).some(byte => byte === 0 || byte < 9 || byte > 13 && byte < 32), text: true },
  '.markdown': { extension: '.markdown', type: 'text/markdown', magic: b => !b.subarray(0, Math.min(b.length, 8192)).some(byte => byte === 0 || byte < 9 || byte > 13 && byte < 32), text: true },
  '.json': { extension: '.json', type: 'application/json', magic: b => !b.subarray(0, Math.min(b.length, 8192)).some(byte => byte === 0 || byte < 9 || byte > 13 && byte < 32), text: true },
  '.pdf': { extension: '.pdf', type: 'application/pdf', magic: b => b.subarray(0, 5).toString() === '%PDF-' },
};

export function validateUpload(upload: SourceUpload, maxBytes = uploadLimit()): SourceUpload {
  const name = safeSourceName(upload.name), ext = name.slice(name.lastIndexOf('.')).toLowerCase(), allowed = TYPES[ext];
  if (!allowed || upload.type.toLowerCase().split(';')[0]!.trim() !== allowed.type) throw new MDBError('INVALID_INPUT', 'Source type and filename extension are not an allowed match');
  if (!upload.bytes.length || upload.bytes.length > maxBytes) throw Object.assign(new MDBError('BODY_TOO_LARGE', `Source must be between 1 and ${maxBytes} bytes`), { status: upload.bytes.length ? 413 : 400 });
  if (!allowed.magic(upload.bytes)) throw new MDBError('INVALID_INPUT', 'Source bytes do not match the declared file type');
  if (allowed.text) {
    const text = upload.bytes.toString('utf8');
    if (Buffer.from(text, 'utf8').compare(upload.bytes) !== 0) throw new MDBError('INVALID_INPUT', 'Text source must be valid UTF-8');
    if (/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(text)) throw new MDBError('INVALID_INPUT', 'Text source contains binary control bytes');
    if (ext === '.json') { try { JSON.parse(text); } catch { throw new MDBError('INVALID_INPUT', 'JSON source is malformed'); } }
  }
  return { ...upload, name, type: allowed.type };
}

export async function readLimited(req: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.byteLength; if (size > maxBytes) throw Object.assign(new MDBError('BODY_TOO_LARGE', `Request exceeds ${maxBytes} bytes`), { status: 413 }); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}

export function parseMultipart(bytes: Buffer, contentType: string): SourceUpload {
  const boundary = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary || boundary.length > 70) throw new MDBError('INVALID_INPUT', 'Multipart boundary is invalid');
  const raw = bytes.toString('latin1'), marker = `--${boundary}`, sections = raw.split(marker).slice(1).filter(part => !/^--\r?\n?$/.test(part));
  let file: SourceUpload | undefined;
  for (const section of sections) {
    const normalized = section.replace(/^\r?\n/, '').replace(/\r?\n--?$/, ''), split = normalized.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const headers = normalized.slice(0, split), disposition = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    if (!disposition?.[2]) continue;
    const name = disposition[2], type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? 'application/octet-stream';
    file = { name, type, bytes: Buffer.from(normalized.slice(split + 4), 'latin1') };
    break;
  }
  if (!file) throw new MDBError('INVALID_INPUT', 'A file field is required');
  return file;
}

export function validScope(value: unknown): Scope {
  if (value === undefined) return { type: 'global', area: 'wiki' };
  if (!value || typeof value !== 'object') throw new MDBError('INVALID_INPUT', 'Invalid source scope');
  const scope = value as Record<string, unknown>;
  if (scope.type === 'global' && ['wiki', 'shared', 'discoveries'].includes(String(scope.area))) return { type: 'global', area: scope.area as 'wiki' | 'shared' | 'discoveries' };
  if (scope.type === 'workspace' && typeof scope.workspaceId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(scope.workspaceId) && (scope.collectionId === undefined || typeof scope.collectionId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(scope.collectionId))) return { type: 'workspace', workspaceId: scope.workspaceId, ...(scope.collectionId ? { collectionId: scope.collectionId } : {}) };
  throw new MDBError('INVALID_INPUT', 'Invalid source scope');
}

const CHAT_STOPWORDS = new Set('a an and are as at be by can do for from has how i in is it me my of on or our say tell that the their them these this to use was we what when where which who why with you your'.split(' '));
export function chatTerms(text: string): string[] { return [...new Set(text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].filter(term => !CHAT_STOPWORDS.has(term)); }
export function isSmallTalk(question: string): boolean { const normalized = question.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim(); return /^(hi|hello|hey|sup|thanks|thank you|help|help please|who are you|what can you do|what can i do|what do you do|what are you|good morning|good afternoon|good evening)$/.test(normalized); }
export function smallTalkAnswer(question: string, docs: Document[]) {
  const pages = docs.filter(doc => doc.kind === 'wiki_page'), examples = pages.slice(0, 3).map(doc => `What does “${doc.title}” say about …?`);
  const answer = `Engram assistant, not from your wiki. I can answer questions from your wiki with citations, add sources by attaching or pasting a file or submitting a URL, and optionally synthesize answers with a configured model. Your vault has ${docs.length} document${docs.length === 1 ? '' : 's'} across ${pages.length} wiki page${pages.length === 1 ? '' : 's'}.${examples.length ? ` Try: ${examples.join(' · ')}` : ''}`;
  return { kind: 'small_talk' as const, answer, citations: [], examples };
}
function matchedPassage(body: string, terms: string[], max = 700): string { const lower = body.toLocaleLowerCase(); const at = terms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a,b) => a-b)[0] ?? 0; let start = Math.max(0, at - Math.floor(max / 3)); if (start > 0) { const boundary = body.indexOf(' ', start); if (boundary >= 0 && boundary - start < 80) start = boundary + 1; } const end = Math.min(body.length, start + max); return `${start ? '…' : ''}${body.slice(start,end).trim()}${end < body.length ? '…' : ''}`; }
export function retrievalAnswer(question: string, docs: Document[]) {
  const terms = chatTerms(question), ranked = docs.map(doc => { const haystack = `${doc.title} ${doc.body}`.normalize('NFKC').toLocaleLowerCase(); const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0); return { doc, score }; }).sort((a,b) => b.score-a.score);
  const top = ranked[0]?.score ?? 0, relevant = terms.length ? ranked.filter(item => item.score > 0 && item.score >= Math.max(1, Math.ceil(top * .5))).slice(0,3) : [];
  const citations = relevant.map(({doc}) => ({ uri: doc.uri, revisionId: doc.revisionId }));
  const answer = relevant.length ? relevant.map(({doc}, index) => `${doc.title}: ${matchedPassage(doc.body, terms)} [${index + 1}]`).join('\n\n') : `I searched authorized page titles and content for “${question.trim()}” but found no matching passage. Try rephrasing your question or choose a recently updated page below.`;
  return { kind: relevant.length ? 'answer' as const : 'no_match' as const, answer, citations };
}

export function validateChatModelOutput(value: unknown, docs: Document[]): { answer: string; citations: Array<{ uri: string; revisionId: string }> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MDBError('INVALID_MODEL_OUTPUT', 'Chat synthesis returned an invalid object');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(key => !['kind', 'title', 'body', 'evidence'].includes(key)) || typeof obj.body !== 'string' || !obj.body.trim() || obj.body.length > 12_000 || !Array.isArray(obj.evidence) || obj.evidence.length > 20) throw new MDBError('INVALID_MODEL_OUTPUT', 'Chat synthesis output failed schema validation');
  const allowed = new Set(docs.map(doc => `${doc.uri}\n${doc.revisionId}`));
  const citations = obj.evidence.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new MDBError('INVALID_MODEL_OUTPUT', 'Chat synthesis citation is invalid');
    const citation = item as Record<string, unknown>;
    if (Object.keys(citation).some(key => !['uri', 'revisionId', 'span'].includes(key)) || typeof citation.uri !== 'string' || typeof citation.revisionId !== 'string' || !allowed.has(`${citation.uri}\n${citation.revisionId}`)) throw new MDBError('INVALID_MODEL_OUTPUT', 'Chat synthesis cited a source outside the retrieved authorized set');
    return { uri: citation.uri, revisionId: citation.revisionId };
  });
  return { answer: obj.body, citations: [...new Map(citations.map(item => [`${item.uri}\n${item.revisionId}`, item])).values()] };
}

export function stableUploadKey(upload: SourceUpload): string { return createHash('sha256').update(upload.bytes).update('\0').update(upload.name).digest('hex'); }
