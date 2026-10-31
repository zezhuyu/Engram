import './helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { Engram, OWNER, parseGenericJson, parseGenericJsonl, parseChatGptExport, parseChatGptZip, parseClaudeExport, parseGeminiTakeoutActivity, importChatEvents, type NormalizedChatEvent, type ActorContext } from '../packages/sdk/index.js';
import { toolsFor } from '../packages/mcp/index.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
async function setup(t: { after(fn: () => void | Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'engram-chat-import-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const owner = new Engram(root, OWNER); await owner.init({ sqlite: false });
  await owner.chatProjects.ensurePersonalWorkspace();
  await owner.createWorkspace('project', 'shared project', { member: ['read', 'write'] });
  await owner.createWorkspace('private', 'private');
  await owner.chatProjects.registerSourceAccount({ provider: 'generic', sourceAccountId: 'account-one', label: 'Test account' });
  return { root, owner };
}
function generic(events: Array<Record<string, unknown>>) {
  return parseGenericJson({ schemaVersion: 1, conversations: events.map((m, i) => ({ id: String(m.conversationId ?? 'conversation'), title: 'Test', projectId: m.projectId, messages: [{ ...m, id: String(m.id ?? `m${i}`) }] })) });
}
function zipMany(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let localOffset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name), compressed = deflateRawSync(content), crc = crc32(content);
    const local = Buffer.alloc(30 + nameBuf.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + nameBuf.length); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(localOffset, 42); nameBuf.copy(central, 46);
    centrals.push(central); localOffset += local.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
function zipSingle(name: string, content: Buffer): Buffer { return zipMany([{ name, content }]); }
function crc32(data: Uint8Array): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
const opts = (source: string, patch: Partial<Parameters<typeof importChatEvents>[3]> = {}) => ({ provider: 'generic' as const, sourceAccountId: 'account-one', batchId: 'import-test', sourceSha256: sha(source), membershipForProject: () => 'standalone' as const, ...patch });

test('generic JSONL streams line-bounded events and provider parsers preserve identity/branch metadata conservatively', async () => {
  const chunks = async function* () { yield Buffer.from('{"conversationId":"c","id":"m1","role":"user","text":"first"}\n{"conversationId":"c","id":"m2","role":"assistant","text":"second"}'); };
  const streamed = []; for await (const item of parseGenericJsonl(chunks())) streamed.push(item);
  assert.equal(streamed.length, 2); assert.equal(streamed[0]!.role, 'user');
  const chatgpt = parseChatGptExport([{ id: 'c', title: 'branched', mapping: { a: { message: { id: 'u', author: { role: 'user' }, content: { parts: ['question'] } }, parent: null, children: ['b', 'c'] }, b: { message: { id: 'a1', author: { role: 'assistant' }, content: { parts: ['branch one'] } }, parent: 'a', children: [] }, c: { message: { id: 'a2', author: { role: 'assistant' }, content: { parts: ['branch two'] } }, parent: 'a', children: [] } } }]);
  assert.equal(chatgpt.length, 3); assert.equal(chatgpt.find(m => m.externalMessageId === 'u')?.branchId, 'a');
  const claude = parseClaudeExport([{ uuid: 'cc', name: 'Claude', chat_messages: [{ uuid: 'x', sender: 'human', text: 'hello' }, { uuid: 'y', sender: 'assistant', text: 'hi', parent_message_uuid: 'x' }] }]);
  assert.deepEqual(claude.map(m => m.role), ['user', 'assistant']); assert.equal(claude[1]!.parentMessageId, 'x');
  const gemini = parseGeminiTakeoutActivity([{ id: 'g1', title: 'Prompted Gemini: What is 2+2?', products: ['Gemini Apps'], time: '2026-01-01T00:00:00Z' }]);
  assert.equal(gemini.length, 1); assert.equal(gemini[0]!.role, 'user'); assert.ok(gemini[0]!.warnings?.includes('takeout_activity_prompt_only'));
  assert.equal(parseGeminiTakeoutActivity([{ title: 'Search', products: ['Google Search'] }]).length, 0);
  const farFutureSeconds = parseGenericJson({ schemaVersion: 1, conversations: [{ id: 'future', messages: [{ id: 'future-m', role: 'user', text: 'future', timestamp: 32_503_680_000 }] }] });
  assert.equal(farFutureSeconds[0]!.timestamp, '3000-01-01T00:00:00.000Z', 'large Unix seconds are not misread as milliseconds');
  const activity = (title: string, time: string) => ({ title: `Prompted Gemini: ${title}`, products: ['Gemini Apps'], time });
  const original = parseGeminiTakeoutActivity([activity('stable prompt A', '2026-01-01T00:00:00Z'), activity('stable prompt B', '2026-01-02T00:00:00Z')]);
  const later = parseGeminiTakeoutActivity([activity('new prompt', '2026-01-03T00:00:00Z'), activity('stable prompt A', '2026-01-01T00:00:00Z'), activity('stable prompt B', '2026-01-02T00:00:00Z')]);
  assert.deepEqual(later.slice(1).map(m => m.externalMessageId), original.map(m => m.externalMessageId), 'id-less activity identifiers do not depend on array position');
  const chatgptImage = parseChatGptExport([{
    id: 'img-c', mapping: {
      n: { parent: null, children: [], message: {
        id: 'img-m', author: { role: 'user' },
        content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://asset-17' }, 'caption'] },
      } },
    },
  }]);
  assert.deepEqual(chatgptImage[0]!.contentParts, [{ kind: 'structured', contentType: 'image_asset_pointer', value: 'file-service://asset-17' }, { kind: 'text', value: 'caption' }]);
  const claudeBlocks = parseClaudeExport([{ uuid: 'claude-blocks', chat_messages: [{ uuid: 'b1', sender: 'assistant', content: [{ type: 'thinking', thinking: 'planning block' }, { type: 'tool_use', name: 'local_tool', input: { query: 'safe metadata' } }, { type: 'tool_result', content: 'tool output' }, { type: 'text', text: 'answer' }], attachments: [{ name: 'diagram.png' }] }] }]);
  assert.ok(claudeBlocks[0]!.contentParts.some(part => part.kind === 'structured' && part.contentType === 'thinking' && part.value.includes('planning block')));
  assert.ok(claudeBlocks[0]!.contentParts.some(part => part.kind === 'structured' && part.contentType === 'tool_use'));
  assert.ok(claudeBlocks[0]!.contentParts.some(part => part.kind === 'structured' && part.contentType === 'tool_result'));
  assert.ok(claudeBlocks[0]!.contentParts.some(part => part.kind === 'text' && part.value === 'answer'));
  assert.ok(claudeBlocks[0]!.contentParts.some(part => part.kind === 'attachment' && part.value === 'diagram.png'));
  assert.throws(() => parseGenericJson('{'), /Invalid generic chat JSON/);
});

test('bounded ChatGPT ZIP reads conversations without extraction and rejects checksum/path mismatch', () => {
  const body = Buffer.from(JSON.stringify([{ id: 'c', mapping: { n: { message: { id: 'm', author: { role: 'user' }, content: { parts: ['zip text'] } }, children: [], parent: null } } }]), 'utf8');
  assert.equal(parseChatGptZip(zipSingle('conversations.json', body))[0]!.contentParts[0]!.value, 'zip text');
  const bad = zipSingle('conversations.json', body); const central = bad.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bad[central + 16] = bad[central + 16]! ^ 1; assert.throws(() => parseChatGptZip(bad), /checksum|disagree/);
  assert.throws(() => parseChatGptZip(zipSingle('../conversations.json', body)), /unsafe member path/);
});

test('ChatGPT ZIP imports numbered split conversation JSON members in deterministic numeric order', () => {
  const conversation = (id: string, message: string) => Buffer.from(JSON.stringify([{ id, mapping: { [message]: { message: { id: message, author: { role: 'user' }, content: { parts: [message] } }, children: [], parent: null } } }]), 'utf8');
  const archive = zipMany([
    { name: 'conversations-10.json', content: conversation('c10', 'ten') },
    { name: 'unrelated.json', content: Buffer.from('{broken', 'utf8') },
    { name: 'conversations-2.json', content: conversation('c2', 'two') },
    { name: 'conversations.json', content: conversation('c0', 'zero') },
  ]);
  const events = parseChatGptZip(archive);
  assert.deepEqual(events.map(item => item.externalConversationId), ['c0', 'c2', 'c10']);
  assert.deepEqual(events.map(item => item.contentParts[0]?.value), ['zero', 'two', 'ten']);
  assert.throws(() => parseChatGptZip(zipSingle('conversations-copy.json', conversation('cx', 'ignored'))), /expected bounded provider export member/);
});

test('generic attachment parts preserve safe references and reject unsafe paths through durable import', async t => {
  const { owner } = await setup(t);
  const events = generic([{ id: 'attachment-1', role: 'user', contentParts: [
    { kind: 'attachment', value: 'images/diagram.png' },
    { kind: 'reference', value: 'https://example.test/reports/diagram.png?view=1' },
    { kind: 'attachment', value: '../../private/secret.txt' },
    { kind: 'reference', value: 'file:///Users/private/key.txt' },
  ] }]);
  assert.deepEqual(events[0]?.contentParts, [{ kind: 'attachment', value: 'images/diagram.png' }, { kind: 'reference', value: 'https://example.test/reports/diagram.png?view=1' }]);
  assert.ok(events[0]?.warnings?.includes('unsafe_attachment_reference'));
  const result = await importChatEvents(owner.vault, owner.chatProjects, events, opts('attachments', { batchId: 'attachments' }));
  assert.equal(result.imported, 1);
  const stored = (await owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] })).find(doc => doc.kind === 'chat_message')!;
  assert.match(stored.body, /\[attachment: images\/diagram\.png\]/u);
  assert.match(stored.body, /\[reference: https:\/\/example\.test\/reports\/diagram\.png\?view=1\]/u);
  assert.doesNotMatch(stored.body, /credential|password/u);
  assert.doesNotMatch(stored.body, /private|secret|key\.txt/u);
  assert.deepEqual(stored.metadata.normalizationWarnings, ['unsafe_attachment_reference']);
});

test('overlapping id-less Gemini exports deduplicate rows after prepend and reorder', async t => {
  const { owner } = await setup(t); await owner.chatProjects.registerSourceAccount({ provider: 'gemini', sourceAccountId: 'gemini-account' });
  const row = (prompt: string, time: string) => ({ title: `Prompted Gemini: ${prompt}`, products: ['Gemini Apps'], time });
  const exportA = parseGeminiTakeoutActivity([row('first stable prompt', '2026-02-01T00:00:00Z'), row('second stable prompt', '2026-02-02T00:00:00Z')]);
  const exportB = parseGeminiTakeoutActivity([row('new row', '2026-02-03T00:00:00Z'), row('second stable prompt', '2026-02-02T00:00:00Z'), row('first stable prompt', '2026-02-01T00:00:00Z')]);
  await importChatEvents(owner.vault, owner.chatProjects, exportA, { ...opts('gemini-export-a', { batchId: 'gemini-a', sourceAccountId: 'gemini-account' }), provider: 'gemini' });
  const second = await importChatEvents(owner.vault, owner.chatProjects, exportB, { ...opts('gemini-export-b', { batchId: 'gemini-b', sourceAccountId: 'gemini-account' }), provider: 'gemini' });
  assert.equal(second.imported, 1); assert.equal(second.duplicates, 2);
  const docs = (await owner.vault.listDocuments()).filter(doc => doc.kind === 'chat_message' && doc.metadata.provider === 'gemini');
  assert.equal(docs.length, 3); assert.deepEqual(new Set(docs.map(doc => doc.body)), new Set(['first stable prompt', 'second stable prompt', 'new row']));
  await owner.close();
});

test('durable import rejects unsafe attachment references even when callers supply normalized events directly', async t => {
  const { owner } = await setup(t);
  const unsafe = ['../../outside/private.txt', 'images/%2e%2e/private.txt', 'images/%252e%252e/private.txt', 'file:///Users/private/key.txt', 'https://user:password@example.test/transcript', 'https://example.test/%2e%2e/private.txt'];
  const events: NormalizedChatEvent[] = unsafe.map((value, index) => ({
    schemaVersion: 1, provider: 'generic', externalConversationId: 'direct-attachment', externalMessageId: `unsafe-${index}`,
    role: 'user', contentParts: [{ kind: 'attachment', value }],
  }));
  const result = await importChatEvents(owner.vault, owner.chatProjects, events, opts('direct-unsafe-attachment', { batchId: 'direct-unsafe-attachment' }));
  assert.equal(result.rejected, unsafe.length);
  assert.equal(result.imported, 0);
  const personal = await owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] });
  assert.equal(personal.filter(doc => doc.kind === 'chat_message').length, 0);
  const warning = personal.find(doc => doc.kind === 'chat_import_warning' && doc.metadata.batchId === 'direct-unsafe-attachment');
  assert.ok(warning, 'the rejection should be durably visible in import status');
  assert.doesNotMatch(warning!.body, /private|password|example\.test/u, 'diagnostics must not retain rejected references or URL credentials');
  await owner.close();
});

test('preview writes no transcript; bounded batches checkpoint and replay is idempotent', async t => {
  const { owner } = await setup(t); const source = JSON.stringify({ export: 'fixture' }); const events = generic([{ id: 'm1', role: 'user', text: 'first' }, { id: 'm2', role: 'assistant', text: 'second' }]);
  const preview = await importChatEvents(owner.vault, owner.chatProjects, events, opts(source, { batchId: 'preview', preview: true }));
  assert.equal(preview.imported, 2); assert.equal((await owner.listDocuments()).filter(d => d.kind === 'chat_message').length, 0);
  const first = await importChatEvents(owner.vault, owner.chatProjects, events, opts(source, { batchId: 'run-one', maxRecords: 1 }));
  assert.equal(first.imported, 1); assert.equal(first.complete, false); assert.equal(first.nextOffset, 1);
  const resumed = await importChatEvents(owner.vault, owner.chatProjects, events, opts(source, { batchId: 'run-one', startOffset: first.nextOffset }));
  assert.equal(resumed.imported, 1); assert.equal(resumed.complete, true); assert.equal(resumed.nextOffset, 2);
  const replay = await importChatEvents(owner.vault, owner.chatProjects, events, opts(source, { batchId: 'run-one', startOffset: 2 }));
  assert.equal(replay.duplicates, 0, 'completed checkpoint at EOF does not reprocess');
  assert.equal((await owner.listDocuments()).filter(d => d.kind === 'chat_message').length, 2);
  const checkpoint = (await owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] })).find(doc => doc.kind === 'chat_import_run' && doc.metadata.batchId === 'run-one')!;
  const checkpointHistory = (await owner.history(checkpoint.id)).length;
  await importChatEvents(owner.vault, owner.chatProjects, events, opts(source, { batchId: 'run-one', startOffset: 2 }));
  assert.equal((await owner.history(checkpoint.id)).length, checkpointHistory, 'replaying a completed batch must not create a checkpoint revision');
  await owner.close();
});

test('read-only actors can preview Personal imports but cannot run them', async t => {
  const { root, owner } = await setup(t);
  await owner.grant('personal', 'chat-preview-reader', ['read']);
  const reader = new Engram(root, { actorId: 'chat-preview-reader', permissions: ['workspace:personal:read'] });
  const events = generic([{ id: 'preview-reader', role: 'user', text: 'preview only' }]);
  const preview = await importChatEvents(reader.vault, reader.chatProjects, events, opts('preview-reader', { batchId: 'preview-reader', preview: true }));
  assert.equal(preview.imported, 1);
  await assert.rejects(importChatEvents(reader.vault, reader.chatProjects, events, opts('preview-reader', { batchId: 'preview-reader-run' })), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  assert.equal((await owner.vault.listDocuments()).filter(doc => doc.kind === 'chat_message').length, 0);
  await reader.close(); await owner.close();
});

test('a crash after an acknowledged message before the bounded import checkpoint replays without loss or duplicates', async t => {
  const { owner } = await setup(t);
  const events = generic(Array.from({ length: 101 }, (_, i) => ({ id: `crash-${i}`, role: 'user', text: `durable message ${i}` })));
  const options = opts('bounded-checkpoint-crash', { batchId: 'bounded-checkpoint-crash' });
  const originalPut = owner.vault.put.bind(owner.vault); let committed = 0;
  owner.vault.put = async input => {
    const saved = await originalPut(input);
    if (input.kind === 'chat_message' && ++committed === 31) throw new Error('injected interruption after message commit before checkpoint');
    return saved;
  };
  await assert.rejects(importChatEvents(owner.vault, owner.chatProjects, events, options), /injected interruption/);
  owner.vault.put = originalPut;
  const afterInterruption = (await owner.vault.listDocuments()).filter(doc => doc.kind === 'chat_message');
  assert.equal(afterInterruption.length, 31, '31 acknowledged message commits survive the interruption');
  const run = (await owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] })).find(doc => doc.kind === 'chat_import_run' && doc.metadata.batchId === options.batchId);
  assert.ok(!run || JSON.parse(run.body).nextOffset === 0, 'the durable checkpoint is absent or remains at the start of the interrupted range');
  const resumed = await importChatEvents(owner.vault, owner.chatProjects, events, options);
  assert.equal(resumed.complete, true); assert.equal(resumed.duplicates, 31); assert.equal(resumed.imported, 70);
  const final = (await owner.vault.listDocuments()).filter(doc => doc.kind === 'chat_message');
  assert.equal(final.length, 101); assert.equal(new Set(final.map(doc => doc.metadata.externalMessageId)).size, 101);
  await owner.close();
});

test('bounded and unresolved imports close their async source iterator', async t => {
  const { owner } = await setup(t);
  const makeSource = (onClose: () => void) => (async function* () {
    try {
      yield* generic([
        { id: 'first', role: 'user', text: 'first record' },
        { id: 'second', role: 'user', text: 'second record', projectId: 'unmapped-project' },
      ]);
    } finally { onClose(); }
  })();

  let closedAfterLimit = false;
  const limited = await importChatEvents(owner.vault, owner.chatProjects, makeSource(() => { closedAfterLimit = true; }), opts('iterator-limit', { batchId: 'iterator-limit', maxRecords: 1 }));
  assert.equal(limited.processed, 1);
  assert.equal(limited.complete, false);
  assert.equal(closedAfterLimit, true, 'a bounded batch must release its underlying streaming source');

  let closedAfterPending = false;
  const pending = await importChatEvents(owner.vault, owner.chatProjects, makeSource(() => { closedAfterPending = true; }), opts('iterator-pending', { batchId: 'iterator-pending', membershipForProject: id => id ? 'member' : 'standalone' }));
  assert.equal(pending.pending, 1);
  assert.equal(pending.complete, false);
  assert.equal(closedAfterPending, true, 'an unresolved route must release the source before returning');
  await owner.close();
});

test('changed imported content creates an immutable revision and transient failures do not advance the checkpoint', async t => {
  const { owner } = await setup(t); const source = 'source-a'; const initial = generic([{ id: 'm1', role: 'user', text: 'old' }]);
  const run = await importChatEvents(owner.vault, owner.chatProjects, initial, opts(source, { batchId: 'revision' })); assert.equal(run.imported, 1);
  const changed = generic([{ id: 'm1', role: 'user', text: 'corrected', sourceRevision: 'r2' }]);
  const update = await importChatEvents(owner.vault, owner.chatProjects, changed, opts('source-b', { batchId: 'revision-two' })); assert.equal(update.imported, 1);
  const doc = (await owner.listDocuments()).find(d => d.kind === 'chat_message')!; assert.equal(doc.body, 'corrected'); assert.equal((await owner.history(doc.id)).length, 2);
  await owner.close();
});

test('same chat text with corrected role, timestamp, or branch provenance creates an immutable revision', async t => {
  const { owner } = await setup(t);
  const source = 'same-text-provenance';
  const base = generic([{ id: 'm1', role: 'assistant', text: 'shared content', timestamp: '2026-01-01T00:00:00Z', branchId: 'branch-a', parentMessageId: 'parent-a' }]);
  const first = await importChatEvents(owner.vault, owner.chatProjects, base, opts(source, { batchId: 'provenance-one' }));
  assert.equal(first.imported, 1);
  const changed = generic([{ id: 'm1', role: 'user', text: 'shared content', timestamp: '2026-01-02T00:00:00Z', branchId: 'branch-b' }]);
  const second = await importChatEvents(owner.vault, owner.chatProjects, changed, opts(source, { batchId: 'provenance-two' }));
  assert.equal(second.imported, 1, 'metadata-only source corrections must not be discarded as duplicates');
  const doc = (await owner.listDocuments()).find(item => item.kind === 'chat_message')!;
  assert.equal(doc.metadata.role, 'user');
  assert.equal(doc.metadata.speaker, 'user');
  assert.equal(doc.metadata.sourceTimestamp, '2026-01-02T00:00:00.000Z');
  assert.equal(doc.metadata.branchId, 'branch-b');
  assert.equal(doc.metadata.parentMessageId, null, 'removed lineage must be cleared instead of leaking stale provenance');
  assert.ok(doc.tags.includes('chat-role-user'));
  assert.equal(doc.tags.includes('chat-role-assistant'), false, 'search tags must follow corrected speaker metadata');
  assert.equal((await owner.history(doc.id)).length, 2, 'the earlier role and branch provenance remain immutable history');
  const replay = await importChatEvents(owner.vault, owner.chatProjects, changed, opts(source, { batchId: 'provenance-replay' }));
  assert.equal(replay.duplicates, 1, 're-importing the corrected source is idempotent');
  assert.equal((await owner.history(doc.id)).length, 2, 'an identical corrected source does not append another revision');
  await owner.close();
});

test('rejected import records remain durably inspectable without retaining message text', async t => {
  const { owner } = await setup(t);
  const events = generic([{ id: 'accepted-1', role: 'user', text: 'safe first record' }, { id: 'rejected', role: 'user', text: 'DO_NOT_PERSIST_THIS_TEXT' }, { id: 'accepted-2', role: 'assistant', text: 'safe final record' }]);
  const malformed = events.map(item => ({ ...item }));
  malformed[1]!.role = 'invalid-role' as NormalizedChatEvent['role'];
  const result = await importChatEvents(owner.vault, owner.chatProjects, malformed, opts('warning-source', { batchId: 'warning-batch' }));
  assert.equal(result.rejected, 1);
  const records = (await owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] })).filter(doc => doc.kind === 'chat_import_warning' && doc.metadata.batchId === 'warning-batch');
  assert.equal(records.length, 1, 'the rejection warning must survive process restart and be visible in batch status');
  assert.equal(records[0]!.body.includes('DO_NOT_PERSIST_THIS_TEXT'), false, 'warning records must not copy rejected message content');
  const replay = await importChatEvents(owner.vault, owner.chatProjects, malformed, opts('warning-source', { batchId: 'warning-batch', startOffset: result.nextOffset }));
  assert.equal(replay.warnings.length, 1, 'a resumed process can reconstruct prior rejection diagnostics from the journal');
  await owner.close();
});

test('unknown project membership is metadata-only pending and leaves the durable cursor before that event', async t => {
  const { owner } = await setup(t); const events = generic([{ id: 'm1', role: 'user', projectId: 'unknown-project', text: 'PRIVATE-UNROUTED-CANARY' }]);
  const result = await importChatEvents(owner.vault, owner.chatProjects, events, opts('pending-source', { batchId: 'pending', membershipForProject: () => 'unknown' }));
  assert.equal(result.pending, 1); assert.equal(result.nextOffset, 0); assert.equal(result.complete, false);
  const docs = await owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] });
  assert.equal(docs.filter(d => d.kind === 'chat_message').length, 0);
  assert.equal(docs.filter(d => d.kind === 'chat_import_pending').length, 1);
  assert.equal(docs.some(d => d.body.includes('PRIVATE-UNROUTED-CANARY')), false);
  await owner.close();
});

test('conversation list/get/search are ACL filtered and require disambiguation across source accounts', async t => {
  const { root, owner } = await setup(t); const events = generic([{ id: 'u', role: 'user', text: 'unique-search-canary', conversationId: 'same' }, { id: 'a', role: 'assistant', text: 'answer', conversationId: 'same' }]);
  await importChatEvents(owner.vault, owner.chatProjects, events, opts('query-source', { batchId: 'query' }));
  const listed = await owner.chatConversations.list(); assert.equal(listed.conversations[0]!.messageCount, 2);
  const got = await owner.chatConversations.get({ externalConversationId: 'same', provider: 'generic', sourceAccountId: 'account-one' }); assert.equal(got.messages.length, 2);
  const found = await owner.chatConversations.search({ query: 'unique-search-canary', provider: 'generic', sourceAccountId: 'account-one' }); assert.equal(found.conversations.length, 1); assert.equal(found.conversations[0]!.matches[0]!.snippet.includes('unique-search-canary'), true);
  const actor: ActorContext = { actorId: 'member', permissions: ['workspace:project:read'] }; const member = new Engram(root, actor);
  assert.equal((await member.chatConversations.list()).conversations.length, 0);
  await assert.rejects(member.chatConversations.get({ externalConversationId: 'same', provider: 'generic', sourceAccountId: 'account-one' }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  await member.close(); await owner.close();
});

test('conversation cursors page deterministically and reject changed filters', async t => {
  const { owner } = await setup(t);
  const events = generic([
    { id: 'page-a-user', conversationId: 'page-a', role: 'user', timestamp: '2025-01-01T00:00:00Z', text: 'pagination-marker alpha' },
    { id: 'page-b-user', conversationId: 'page-b', role: 'assistant', timestamp: '2025-02-01T00:00:00Z', text: 'pagination-marker beta' },
    { id: 'page-c-user', conversationId: 'page-c', role: 'user', timestamp: '2025-03-01T00:00:00Z', text: 'pagination-marker gamma' },
  ]);
  await importChatEvents(owner.vault, owner.chatProjects, events, opts('pagination-source', { batchId: 'pagination', membershipForProject: () => 'standalone' }));
  const first = await owner.chatConversations.list({ provider: 'generic', limit: 1 });
  assert.equal(first.conversations[0]?.externalConversationId, 'page-c');
  assert.ok(first.nextCursor);
  const second = await owner.chatConversations.list({ provider: 'generic', limit: 1, cursor: first.nextCursor });
  assert.equal(second.conversations[0]?.externalConversationId, 'page-b');
  await assert.rejects(owner.chatConversations.list({ provider: 'generic', role: 'user', limit: 1, cursor: first.nextCursor }), { code: 'INVALID_INPUT' });
  const dated = await owner.chatConversations.list({ provider: 'generic', since: '2025-02-01T00:00:00Z', limit: 10 });
  assert.deepEqual(dated.conversations.map(conversation => conversation.externalConversationId), ['page-c', 'page-b'], JSON.stringify(await owner.chatConversations.list({ provider: 'generic', limit: 10 })));
  const until = await owner.chatConversations.list({ provider: 'generic', until: '2025-02-01T00:00:00Z', limit: 10 });
  assert.deepEqual(until.conversations.map(conversation => conversation.externalConversationId), ['page-b', 'page-a']);
  const datedSearch = await owner.chatConversations.search({ query: 'pagination-marker', provider: 'generic', since: '2025-02-01T00:00:00Z', limit: 10 });
  assert.deepEqual(new Set(datedSearch.conversations.map(conversation => conversation.externalConversationId)), new Set(['page-c', 'page-b']));
  await assert.rejects(owner.chatConversations.list({ since: 'not-a-date' }), { code: 'INVALID_INPUT' });
  await assert.rejects(owner.chatConversations.list({ since: '2025-03-01', until: '2025-02-01' }), { code: 'INVALID_INPUT' });
  const search1 = await owner.chatConversations.search({ query: 'pagination-marker', provider: 'generic', limit: 1 });
  assert.equal(search1.conversations.length, 1);
  assert.ok(search1.nextCursor);
  const search2 = await owner.chatConversations.search({ query: 'pagination-marker', provider: 'generic', limit: 1, cursor: search1.nextCursor });
  assert.equal(search2.conversations.length, 1);
  assert.notEqual(search2.conversations[0]?.externalConversationId, search1.conversations[0]?.externalConversationId);
  const oneMessage = await owner.chatConversations.get({ externalConversationId: 'page-a', provider: 'generic', sourceAccountId: 'account-one', maxMessages: 1 });
  assert.equal(oneMessage.messages.length, 1);
  assert.equal(oneMessage.messageCount, 1);
  await owner.close();
});

test('conversation get continues past 1,000 messages with stable keyset cursor ordering', async t => {
  const { owner } = await setup(t);
  const events: NormalizedChatEvent[] = Array.from({ length: 1001 }, (_, i) => ({
    schemaVersion: 1, provider: 'generic', externalConversationId: 'large-conversation', externalMessageId: `message-${String(i).padStart(4, '0')}`,
    role: 'user', contentParts: [{ kind: 'text', value: `page marker ${i}` }], timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
  }));
  await importChatEvents(owner.vault, owner.chatProjects, events, opts('large-paging', { batchId: 'large-paging', maxRecords: 10_000 }));
  const first = await owner.chatConversations.get({ externalConversationId: 'large-conversation', provider: 'generic', sourceAccountId: 'account-one', maxMessages: 1000 });
  assert.equal(first.messageCount, 1001); assert.equal(first.messages.length, 1000); assert.ok(first.nextCursor);
  const second = await owner.chatConversations.get({ externalConversationId: 'large-conversation', provider: 'generic', sourceAccountId: 'account-one', maxMessages: 1000, cursor: first.nextCursor });
  assert.equal(second.messages.length, 1); assert.equal(second.messages[0]?.content, 'page marker 1000'); assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.messages, ...second.messages].map(message => message.objectId)).size, 1001, 'pages contain each ACL-visible message once');
  await assert.rejects(owner.chatConversations.get({ externalConversationId: 'large-conversation', provider: 'generic', sourceAccountId: 'account-one', cursor: first.nextCursor, role: 'assistant' }), { code: 'INVALID_INPUT' });
  await owner.close();
});

test('hidden and non-user provider messages are retained but omitted from default conversation reads', async t => {
  const { owner } = await setup(t); await owner.chatProjects.registerSourceAccount({ provider: 'chatgpt', sourceAccountId: 'chatgpt-account' });
  const events = parseChatGptExport([{ id: 'visibility-c', title: 'Visibility policy', mapping: {
    user: { parent: null, children: [], message: { id: 'user', author: { role: 'user' }, content: { parts: ['visible user text'] } } },
    hidden: { parent: 'user', children: [], message: { id: 'hidden', author: { role: 'assistant' }, metadata: { is_visually_hidden_from_conversation: true }, content: { parts: ['hidden assistant payload'] } } },
    system: { parent: null, children: [], message: { id: 'system', author: { role: 'system' }, content: { parts: ['system prompt payload'] } } },
  } }]);
  await importChatEvents(owner.vault, owner.chatProjects, events, { ...opts('visibility-source', { batchId: 'visibility', sourceAccountId: 'chatgpt-account' }), provider: 'chatgpt' });
  const normal = await owner.chatConversations.get({ externalConversationId: 'visibility-c', provider: 'chatgpt', sourceAccountId: 'chatgpt-account' });
  assert.equal(normal.messageCount, 1); assert.deepEqual(normal.messages.map(message => message.role), ['user']);
  assert.equal((await owner.chatConversations.list({ provider: 'chatgpt' })).conversations[0]?.messageCount, 1);
  assert.equal((await owner.chatConversations.search({ query: 'hidden assistant payload', provider: 'chatgpt' })).conversations.length, 0);
  const all = await owner.chatConversations.get({ externalConversationId: 'visibility-c', provider: 'chatgpt', sourceAccountId: 'chatgpt-account', includeNonUser: true });
  assert.equal(all.messageCount, 3); assert.deepEqual(new Set(all.messages.map(message => message.role)), new Set(['user', 'assistant', 'system']));
  assert.ok((await owner.chatConversations.search({ query: 'hidden assistant payload', provider: 'chatgpt', includeNonUser: true })).conversations.length > 0);
  const docs = (await owner.vault.listDocuments()).filter(doc => doc.kind === 'chat_message' && doc.metadata.provider === 'chatgpt');
  assert.equal(docs.find(doc => doc.metadata.externalMessageId === 'hidden')?.metadata.hidden, true, 'provider hidden state is retained as provenance');
  await owner.close();
});

test('cross-project chat insight is user-directed, exact-span grounded, current, and review-only', async t => {
  const { owner } = await setup(t);
  await owner.chatProjects.linkProject({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'project-a', workspaceId: 'project' });
  await owner.chatProjects.linkProject({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'project-b', workspaceId: 'project' });
  const events = generic([
    { id: 'user-a', role: 'user', projectId: 'project-a', conversationId: 'conv-a', text: 'I prefer concise answers.' },
    { id: 'user-b', role: 'user', projectId: 'project-b', conversationId: 'conv-b', text: 'I prefer concise answers.' },
    { id: 'user-c', role: 'user', projectId: 'project-b', conversationId: 'conv-c', text: 'I enjoy technical explanations.' },
    { id: 'assistant-a', role: 'assistant', projectId: 'project-a', conversationId: 'conv-a', text: 'You prefer concise answers.' },
  ]);
  const imported = await importChatEvents(owner.vault, owner.chatProjects, events, opts('cross-project', { batchId: 'cross-project', membershipForProject: () => 'member' }));
  assert.equal(imported.imported, 4);
  const messages = (await owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'project' }] })).filter(doc => doc.kind === 'chat_message');
  assert.equal(messages.find(doc => doc.metadata.externalMessageId === 'user-a')?.metadata.speaker, 'user');
  assert.equal(messages.find(doc => doc.metadata.externalMessageId === 'assistant-a')?.metadata.speaker, 'assistant');
  const source = (id: string) => { const doc = messages.find(item => item.metadata.externalMessageId === id)!; return { objectId: doc.id, revisionId: doc.revisionId, span: doc.body }; };
  const proposal = await owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence: [source('user-a'), source('user-b')] });
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.input.metadata?.crossProjectChat, true);
  assert.equal(proposal.input.metadata?.extractionMethod, 'user-selected-verbatim-repetition');
  assert.equal(proposal.input.evidence?.length, 2);
  assert.equal((await owner.listDocuments()).filter(doc => doc.kind === 'user_insight' && doc.status === 'accepted').length, 0);
  await assert.rejects(owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence: [source('user-a'), source('assistant-a')] }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  await assert.rejects(owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence: [source('user-a'), { ...source('user-b'), span: 'I prefer very concise answers.' }] }), { code: 'INVALID_INPUT' });
  await assert.rejects(
    owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence: [source('user-a'), { ...source('user-c'), span: 'I prefer concise answers.' }] }),
    { code: 'INVALID_INPUT', message: 'Each evidence span must occur verbatim in its current source message' },
    'a fabricated full-claim quote must be rejected at the chat evidence boundary',
  );
  await assert.rejects(owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence: [source('user-a'), source('user-a')] }), { code: 'INVALID_INPUT' });
  const stale = source('user-b');
  const edited = messages.find(item => item.metadata.externalMessageId === 'user-b')!;
  await owner.patch({ objectId: edited.id, expectedRevisionId: edited.revisionId, body: 'I now prefer detailed answers.' });
  await assert.rejects(owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence: [source('user-a'), stale] }), { code: 'NOT_FOUND_OR_FORBIDDEN' }, 'a changed source cannot support a fresh proposal through its old revision');
  await owner.chatProjects.revokeSourceAccount('generic', 'account-one');
  await assert.rejects(owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence: [source('user-a'), source('user-a')] }), { code: 'NOT_FOUND_OR_FORBIDDEN' }, 'revoked source accounts cannot feed new aggregation');
  await owner.close();
});

test('a pending cross-project chat insight cannot be approved after one cited message is deleted', async t => {
  const { owner } = await setup(t);
  await owner.chatProjects.linkProject({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'delete-a', workspaceId: 'project' });
  await owner.chatProjects.linkProject({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'delete-b', workspaceId: 'project' });
  const events = generic([
    { id: 'delete-user-a', role: 'user', projectId: 'delete-a', conversationId: 'delete-conv-a', text: 'I prefer concise answers.' },
    { id: 'delete-user-b', role: 'user', projectId: 'delete-b', conversationId: 'delete-conv-b', text: 'I prefer concise answers.' },
  ]);
  const imported = await importChatEvents(owner.vault, owner.chatProjects, events, opts('delete-proposal-source', { batchId: 'delete-proposal', membershipForProject: () => 'member' }));
  assert.equal(imported.imported, 2);
  const docs = (await owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'project' }] })).filter(doc => doc.kind === 'chat_message');
  const ref = (messageId: string) => { const doc = docs.find(item => item.metadata.externalMessageId === messageId)!; return { objectId: doc.id, revisionId: doc.revisionId, span: doc.body }; };
  const proposal = await owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence: [ref('delete-user-a'), ref('delete-user-b')] });
  const source = docs.find(doc => doc.metadata.externalMessageId === 'delete-user-b')!;
  await owner.vault.delete(source.id, source.revisionId);
  let reviewError: unknown;
  try { await owner.reviewProposal(proposal.id, true, 'approve'); } catch (error) { reviewError = error; }
  assert.ok(reviewError, 'review must reject evidence whose source is no longer current');
  assert.equal((await owner.listDocuments()).filter(doc => doc.kind === 'user_insight' && doc.status === 'accepted').length, 0);
  await owner.close();
});

test('a pending cross-project chat insight cannot be approved from a superseded message revision', async t => {
  const { owner } = await setup(t);
  await owner.chatProjects.linkProject({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'edit-a', workspaceId: 'project' });
  await owner.chatProjects.linkProject({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'edit-b', workspaceId: 'project' });
  const events = generic([
    { id: 'edit-user-a', role: 'user', projectId: 'edit-a', conversationId: 'edit-conv-a', text: 'I prefer concise answers.' },
    { id: 'edit-user-b', role: 'user', projectId: 'edit-b', conversationId: 'edit-conv-b', text: 'I prefer concise answers.' },
  ]);
  await importChatEvents(owner.vault, owner.chatProjects, events, opts('edit-proposal-source', { batchId: 'edit-proposal', membershipForProject: () => 'member' }));
  const docs = (await owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'project' }] })).filter(doc => doc.kind === 'chat_message');
  const ref = (messageId: string) => { const doc = docs.find(item => item.metadata.externalMessageId === messageId)!; return { objectId: doc.id, revisionId: doc.revisionId, span: doc.body }; };
  const proposal = await owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence: [ref('edit-user-a'), ref('edit-user-b')] });
  const source = docs.find(doc => doc.metadata.externalMessageId === 'edit-user-b')!;
  await owner.patch({ objectId: source.id, expectedRevisionId: source.revisionId, body: 'I now prefer detailed answers.' });
  let reviewError: unknown;
  try { await owner.reviewProposal(proposal.id, true, 'approve'); } catch (error) { reviewError = error; }
  assert.ok(reviewError, 'review must reject evidence whose current message revision has changed');
  assert.equal((await owner.listDocuments()).filter(doc => doc.kind === 'user_insight' && doc.status === 'accepted').length, 0);
  await owner.close();
});

test('an accepted chat-derived insight is hidden after a cited chat statement is corrected', async t => {
  const { owner } = await setup(t);
  await owner.chatProjects.linkProject({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'accepted-a', workspaceId: 'project' });
  await owner.chatProjects.linkProject({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'accepted-b', workspaceId: 'project' });
  const events = generic([
    { id: 'accepted-user-a', role: 'user', projectId: 'accepted-a', conversationId: 'accepted-conv-a', text: 'I prefer concise answers.' },
    { id: 'accepted-user-b', role: 'user', projectId: 'accepted-b', conversationId: 'accepted-conv-b', text: 'I prefer concise answers.' },
  ]);
  await importChatEvents(owner.vault, owner.chatProjects, events, opts('accepted-proposal-source', { batchId: 'accepted-proposal', membershipForProject: () => 'member' }));
  const docs = (await owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'project' }] })).filter(doc => doc.kind === 'chat_message');
  const refs = docs.map(doc => ({ objectId: doc.id, revisionId: doc.revisionId, span: doc.body }));
  const proposal = await owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence: refs });
  const approved = await owner.reviewProposal(proposal.id, true, 'owner review');
  assert.equal(approved.status, 'approved');
  assert.equal((await owner.listDocuments()).filter(doc => doc.kind === 'user_insight' && doc.status === 'accepted').length, 1);
  const changed = docs[0]!;
  await owner.patch({ objectId: changed.id, expectedRevisionId: changed.revisionId, body: 'I now prefer detailed answers.' });
  assert.equal((await owner.listDocuments()).filter(doc => doc.kind === 'user_insight' && doc.status === 'accepted').length, 0,
    'a derived insight relying on a chat revision that is no longer current must not remain visible');
  await owner.close();
});

test('a repeated user preference across ChatGPT and Claude projects becomes only a cited pending global proposal', async t => {
  const { owner } = await setup(t);
  await owner.createWorkspace('claude-project-workspace', 'Claude project');
  await owner.chatProjects.registerSourceAccount({ provider: 'chatgpt', sourceAccountId: 'chatgpt-account' });
  await owner.chatProjects.registerSourceAccount({ provider: 'claude', sourceAccountId: 'claude-account' });
  await owner.chatProjects.linkProject({ provider: 'chatgpt', sourceAccountId: 'chatgpt-account', externalProjectId: 'chatgpt-project', workspaceId: 'project' });
  await owner.chatProjects.linkProject({ provider: 'claude', sourceAccountId: 'claude-account', externalProjectId: 'claude-project', workspaceId: 'claude-project-workspace' });
  const chatgpt = parseChatGptExport([{ id: 'chatgpt-conversation', project_id: 'chatgpt-project', mapping: { user: { message: { id: 'chatgpt-user', author: { role: 'user' }, content: { parts: ['I prefer concise answers.'] } }, parent: null, children: [] } } }]);
  const claude = parseClaudeExport([{ uuid: 'claude-conversation', project_id: 'claude-project', chat_messages: [{ uuid: 'claude-user', sender: 'human', text: 'I prefer concise answers.' }] }]);
  const chatgptImport = await importChatEvents(owner.vault, owner.chatProjects, chatgpt, { ...opts('chatgpt-source', { batchId: 'cross-provider-chatgpt', membershipForProject: () => 'member' }), provider: 'chatgpt', sourceAccountId: 'chatgpt-account' });
  const claudeImport = await importChatEvents(owner.vault, owner.chatProjects, claude, { ...opts('claude-source', { batchId: 'cross-provider-claude', membershipForProject: () => 'member' }), provider: 'claude', sourceAccountId: 'claude-account' });
  assert.equal(chatgptImport.imported, 1); assert.equal(claudeImport.imported, 1);
  const docs = (await owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'project' }, { type: 'workspace', workspaceId: 'claude-project-workspace' }] })).filter(doc => doc.kind === 'chat_message');
  const evidence = docs.map(doc => ({ objectId: doc.id, revisionId: doc.revisionId, span: doc.body }));
  assert.deepEqual(new Set(docs.map(doc => doc.metadata.provider)), new Set(['chatgpt', 'claude']));
  const proposal = await owner.proposeCrossProjectChatInsight({ category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.', evidence });
  assert.equal(proposal.status, 'pending');
  assert.deepEqual(proposal.input.evidence?.map(item => item.span), ['I prefer concise answers.', 'I prefer concise answers.']);
  assert.equal((await owner.listDocuments()).filter(doc => doc.kind === 'user_insight' && doc.status === 'accepted').length, 0);
  await owner.close();
});

test('integrated provider routing imports and searches linked projects and standalone Personal history', async t => {
  const { owner } = await setup(t);
  for (const [provider, sourceAccountId] of [['chatgpt', 'acct-gpt'], ['claude', 'acct-claude'], ['gemini', 'acct-gemini']] as const) {
    await owner.chatProjects.registerSourceAccount({ provider, sourceAccountId });
  }
  await owner.chatProjects.linkProject({ provider: 'chatgpt', sourceAccountId: 'acct-gpt', externalProjectId: 'gpt-project', workspaceId: 'project' });
  await owner.chatProjects.linkProject({ provider: 'claude', sourceAccountId: 'acct-claude', externalProjectId: 'claude-project', workspaceId: 'project' });
  await owner.chatProjects.createWorkspaceAndLink({ provider: 'gemini', sourceAccountId: 'acct-gemini', externalProjectId: 'gemini-project', projectName: 'Gemini project', workspaceId: 'gemini-work' });

  const chatgpt = [
    ...parseChatGptExport([{ id: 'gpt-project-chat', project_id: 'gpt-project', title: 'Project', mapping: { u: { message: { id: 'gpt-project-user', author: { role: 'user' }, content: { parts: ['shared project evidence marker'] } }, parent: null, children: [] } } }]),
    ...parseChatGptExport([{ id: 'gpt-personal-chat', title: 'Standalone', mapping: { u: { message: { id: 'gpt-personal-user', author: { role: 'user' }, content: { parts: ['personal gpt marker'] } }, parent: null, children: [] } } }]),
  ];
  const claude = [
    ...parseClaudeExport([{ uuid: 'claude-project-chat', project_id: 'claude-project', chat_messages: [{ uuid: 'claude-project-user', sender: 'human', text: 'shared project evidence marker' }] }]),
    ...parseClaudeExport([{ uuid: 'claude-personal-chat', chat_messages: [{ uuid: 'claude-personal-user', sender: 'human', text: 'personal claude marker' }] }]),
  ];
  // This verifies provider-neutral binding/import. Gemini Takeout's direct row
  // schema is still provisional and is not qualified by this normalized event.
  const gemini: NormalizedChatEvent[] = [
    { schemaVersion: 1, provider: 'gemini', externalConversationId: 'gemini-project-chat', externalMessageId: 'gemini-project-user', externalProjectId: 'gemini-project', role: 'user', contentParts: [{ kind: 'text', value: 'gemini project marker' }] },
    { schemaVersion: 1, provider: 'gemini', externalConversationId: 'gemini-personal-chat', externalMessageId: 'gemini-personal-user', role: 'user', contentParts: [{ kind: 'text', value: 'personal gemini marker' }] },
  ];
  for (const [provider, account, events] of [['chatgpt', 'acct-gpt', chatgpt], ['claude', 'acct-claude', claude], ['gemini', 'acct-gemini', gemini]] as const) {
    const source = JSON.stringify(events), batchId = `integrated-${provider}`;
    const options = { ...opts(source, { batchId, membershipForProject: projectId => projectId ? 'member' as const : 'standalone' as const }), provider, sourceAccountId: account };
    const imported = await importChatEvents(owner.vault, owner.chatProjects, events, options);
    assert.equal(imported.imported, 2, `${provider} project and standalone events should both import`);
    assert.equal(imported.complete, true);
    const replay = await importChatEvents(owner.vault, owner.chatProjects, events, { ...options, batchId: `${batchId}-replay` });
    assert.equal(replay.duplicates, 2, `${provider} replay should be idempotent`);
    assert.equal(replay.imported, 0);
  }

  const personal = (await owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] })).filter(doc => doc.kind === 'chat_message');
  assert.equal(personal.length, 3);
  assert.deepEqual(new Set(personal.map(doc => doc.metadata.provider)), new Set(['chatgpt', 'claude', 'gemini']));
  const shared = (await owner.chatConversations.search({ query: 'shared project evidence marker', scopes: [{ type: 'workspace', workspaceId: 'project' }] })).conversations;
  assert.deepEqual(new Set(shared.map(conversation => conversation.provider)), new Set(['chatgpt', 'claude']));
  const geminiProject = await owner.chatConversations.search({ query: 'gemini project marker', scopes: [{ type: 'workspace', workspaceId: 'gemini-work' }] });
  assert.equal(geminiProject.conversations.length, 1);
  assert.equal((await owner.chatConversations.search({ query: 'personal gemini marker', scopes: [{ type: 'workspace', workspaceId: 'gemini-work' }] })).conversations.length, 0);
  await owner.close();
});

test('cross-project aggregation rechecks each source workspace ACL before creating a global proposal', async t => {
  const { root, owner } = await setup(t);
  await owner.chatProjects.linkProject({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'private-project', workspaceId: 'private' });
  await owner.chatProjects.linkProject({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'readable-project', workspaceId: 'project' });
  const readableEvents = generic([{ id: 'readable-user', role: 'user', projectId: 'readable-project', text: 'I prefer concise answers.' }]);
  await importChatEvents(owner.vault, owner.chatProjects, readableEvents, opts('readable-project-source', { batchId: 'readable-project-source', membershipForProject: () => 'member' }));
  const privateEvent = generic([{ id: 'private-user', role: 'user', projectId: 'private-project', text: 'I prefer concise answers.', conversationId: 'private-conversation' }]);
  await importChatEvents(owner.vault, owner.chatProjects, privateEvent, opts('private-project-source', { batchId: 'private-project-source', membershipForProject: () => 'member' }));
  await owner.grant('personal', 'limited-chat-reader', ['read']);
  await owner.grant('project', 'limited-chat-reader', ['read', 'write']);
  const limited = new Engram(root, { actorId: 'limited-chat-reader', permissions: ['workspace:personal:read', 'workspace:project:read', 'workspace:project:write'] });
  const publicSource = (await owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'project' }] })).find(doc => doc.kind === 'chat_message')!;
  const privateSource = (await owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'private' }] })).find(doc => doc.kind === 'chat_message')!;
  await assert.rejects(limited.proposeCrossProjectChatInsight({
    category: 'preference', preferenceKey: 'answer_length', claim: 'I prefer concise answers.',
    evidence: [publicSource, privateSource].map(doc => ({ objectId: doc.id, revisionId: doc.revisionId, span: doc.body })),
  }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  await limited.close(); await owner.close();
});

test('standard and remote MCP expose conversation reads with actor ACLs and authorized project linking', async t => {
  const { root, owner } = await setup(t); const events = generic([{ id: 'm1', role: 'user', text: 'mcp chat search marker' }]);
  await importChatEvents(owner.vault, owner.chatProjects, events, opts('mcp-source', { batchId: 'mcp-import' }));
  const standard = toolsFor(owner); const remote = toolsFor(owner, 'remote-web');
  assert.ok(standard.some(tool => tool.name === 'mdb_chat_search')); assert.ok(remote.some(tool => tool.name === 'engram_chat_search'));
  const result = await remote.find(tool => tool.name === 'engram_chat_search')!.execute({ query: 'mcp chat search marker', provider: 'generic', sourceAccountId: 'account-one' }) as { conversations: unknown[] };
  assert.equal(result.conversations.length, 1);
  const link = standard.find(tool => tool.name === 'mdb_chat_project_link')!;
  const binding = await link.execute({ provider: 'generic', sourceAccountId: 'account-one', externalProjectId: 'mcp-project', workspaceId: 'project' }) as { workspaceId: string };
  assert.equal(binding.workspaceId, 'project');
  const reader: ActorContext = { actorId: 'member', permissions: ['workspace:project:read'] }; const limited = new Engram(root, reader);
  const denied = toolsFor(limited).find(tool => tool.name === 'mdb_chat_search')!;
  assert.deepEqual((await denied.execute({ query: 'mcp chat search marker', provider: 'generic', sourceAccountId: 'account-one' }) as { conversations: unknown[] }).conversations, []);
  await limited.close(); await owner.close();
});

