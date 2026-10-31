import './helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute, isReadOnlyCommand } from '../packages/cli/index.js';
import { Engram } from '../packages/sdk/index.js';
import { MDBError } from '../packages/core/types.js';

test('chat CLI registers accounts, previews and imports exact-byte hashed generic exports, resumes and queries them', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'engram-chat-cli-'));
  const input = path.join(root, 'portable.json');
  t.after(async () => rm(root, { recursive: true, force: true }));
  await execute(['init', '--root', root, '--no-sqlite']);
  await execute(['chat', 'account', 'register', '--provider', 'generic', '--account', 'cli-account', '--root', root]);
  const source = JSON.stringify({ schemaVersion: 1, conversations: [{ id: 'standalone-1', title: 'CLI import', messages: [{ id: 'u1', role: 'user', text: 'CLI portable history marker' }, { id: 'a1', role: 'assistant', text: 'Captured answer' }] }] });
  await writeFile(input, source);
  let resumeError: unknown;
  try { await execute(['chat', 'import', 'resume', '--provider', 'generic', '--account', 'cli-account', '--format', 'generic-json', '--file', input, '--root', root]); } catch (error) { resumeError = error; }
  assert.ok(resumeError instanceof MDBError && resumeError.code === 'INVALID_ARGUMENT');
  const preview = await execute(['chat', 'import', 'preview', '--provider', 'generic', '--account', 'cli-account', '--format', 'generic-json', '--file', input, '--membership', 'standalone', '--batch', 'cli-preview', '--root', root]) as { imported: number; mode: string };
  assert.equal(preview.mode, 'preview'); assert.equal(preview.imported, 2);
  const client = new Engram(root); assert.equal((await client.listDocuments()).filter(doc => doc.kind === 'chat_message').length, 0); await client.close();
  const imported = await execute(['chat', 'import', 'run', '--provider', 'generic', '--account', 'cli-account', '--format', 'generic-json', '--file', input, '--membership', 'standalone', '--batch', 'cli-run', '--root', root]) as { imported: number; complete: boolean };
  assert.equal(imported.imported, 2); assert.equal(imported.complete, true);
  const listing = await execute(['chat', 'list', '--provider', 'generic', '--account', 'cli-account', '--root', root]) as { conversations: Array<{ externalConversationId: string; messageCount: number; workspaceId: string }> };
  assert.deepEqual(listing.conversations.map(value => [value.externalConversationId, value.messageCount, value.workspaceId]), [['standalone-1', 2, 'personal']]);
  const search = await execute(['chat', 'search', '--provider', 'generic', '--account', 'cli-account', '--query', 'portable history marker', '--root', root]) as { conversations: unknown[] };
  assert.equal(search.conversations.length, 1);
  const fetched = await execute(['chat', 'get', '--provider', 'generic', '--account', 'cli-account', '--conversation', 'standalone-1', '--root', root]) as { messages: Array<{ role: string }> };
  assert.deepEqual(fetched.messages.map(message => message.role), ['user', 'assistant']);
  const status = await execute(['chat', 'import', 'status', '--batch', 'cli-run', '--root', root]) as { status: string; nextOffset: number };
  assert.equal(status.status, 'complete'); assert.equal(status.nextOffset, 2);
  assert.equal(isReadOnlyCommand('chat', 'search'), true); assert.equal(isReadOnlyCommand('chat', 'import', 'preview'), true); assert.equal(isReadOnlyCommand('chat', 'import', 'run'), false);
  assert.equal((await readFile(input, 'utf8')), source, 'import never modifies the user export');
});

test('owned chat client registration requires consent and binds the trusted provider account', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'engram-chat-client-cli-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await execute(['init', '--root', root, '--no-sqlite']);
  await execute(['chat', 'account', 'register', '--provider', 'claude', '--account', 'claude-account', '--root', root]);
  let consentError: unknown;
  try { await execute(['chat', 'client', 'register', '--provider', 'claude', '--account', 'claude-account', '--principal', 'chat-owner', '--root', root]); } catch (error) { consentError = error; }
  assert.ok(consentError instanceof MDBError && /consent/i.test(consentError.message));
  const registration = await execute(['chat', 'client', 'register', '--provider', 'claude', '--account', 'claude-account', '--principal', 'chat-owner', '--consent', '--root', root]) as { host: string; workspaceId: string; chatSource?: { provider: string; sourceAccountId: string }; capture: string[] };
  assert.equal(registration.host, 'engram-chat-client'); assert.equal(registration.workspaceId, 'personal');
  assert.deepEqual(registration.chatSource, { provider: 'claude', sourceAccountId: 'claude-account' });
  assert.deepEqual(registration.capture, ['user.message', 'assistant.message']);
});

