import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ownChildProcess } from './helpers/owned-process.js';
import { ChatProjectRegistry } from '../packages/chat/projects.js';
import { captureOwnedChatTurn, createRegistration, drainSpool, readRegistration, revokeRegistration, spoolStats } from '../packages/memory/capture.js';
import { ConversationService } from '../packages/chat/conversations.js';
import { SearchEngine } from '../packages/search-files/index.js';
import { withVaultLock } from '../packages/storage-local/index.js';
import { disposableVault } from './helpers/disposable-vault.js';

async function setup(t: { after(fn: () => void | Promise<void>): void }) {
  const { root, vault: owner } = await disposableVault(t, { sqlite: false, prefix: 'engram-chat-owned-' });
  const projects = new ChatProjectRegistry(owner);
  await projects.ensurePersonalWorkspace(); await owner.createWorkspace('work', 'Work chat');
  await projects.registerSourceAccount({ provider: 'chatgpt', sourceAccountId: 'account-a' });
  await owner.grant('work', 'chat-client', ['read', 'write']);
  await projects.linkProject({ provider: 'chatgpt', sourceAccountId: 'account-a', externalProjectId: 'project-1', projectName: 'Project 1', workspaceId: 'work' });
  const registration = await createRegistration(owner, { host: 'engram-chat-client', principalId: 'chat-client', workspaceId: 'personal', consent: true, chatSource: { provider: 'chatgpt', sourceAccountId: 'account-a' } });
  t.after(async () => { await owner.close(); });
  return { root, owner, registration, projects };
}

test('owned client captures user and assistant messages through consent, routing, spool and journal', async t => {
  const s = await setup(t);
  const result = await captureOwnedChatTurn(s.root, s.registration.id, { conversationId: 'conv-1', turnId: 'turn-1', membership: 'member', externalProjectId: 'project-1', title: 'Deployment', userText: 'Please inspect the deployment plan.', assistantText: 'I found a possible issue.' });
  assert.equal(result.accepted, 2); assert.equal(result.route, 'pending'); assert.equal(result.queued, 2);
  assert.equal((await drainSpool(s.root)).ingested, 2);
  const docs = await s.owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'work' }] });
  const messages = docs.filter(doc => doc.kind === 'chat_message'); assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(doc => doc.metadata.speaker).sort(), ['assistant', 'user']);
  assert.ok(messages.every(doc => doc.metadata.provider === 'chatgpt' && doc.metadata.sourceAccountId === 'account-a' && doc.metadata.externalConversationId === 'conv-1'));
  assert.equal(messages.find(doc => doc.metadata.speaker === 'user')?.metadata.evidenceClass, 'user_authored');
  assert.equal(messages.find(doc => doc.metadata.speaker === 'assistant')?.metadata.evidenceClass, 'agent_observation');
  const search = new SearchEngine(s.owner); const conversations = new ConversationService(s.owner, search);
  assert.equal((await conversations.list({ provider: 'chatgpt' })).conversations[0]?.messageCount, 2);
  await search.close();
});

test('standalone turns route to Personal; unknown membership stays durably queued for explicit resolution', async t => {
  const s = await setup(t);
  const standalone = await captureOwnedChatTurn(s.root, s.registration.id, { conversationId: 'personal-1', turnId: 'turn-1', membership: 'standalone', title: 'Independent chat', userText: 'Keep this in my personal history.', assistantText: 'Understood.' });
  assert.equal(standalone.workspaceId, 'personal');
  assert.equal((await drainSpool(s.root)).ingested, 2);
  const unknown = await captureOwnedChatTurn(s.root, s.registration.id, { conversationId: 'unknown-1', turnId: 'turn-2', membership: 'unknown', title: 'Unresolved chat', userText: 'This must not silently route.', assistantText: 'Waiting for routing review.' });
  assert.equal(unknown.route, 'review_required'); assert.equal(unknown.queued, 2);
  const drain = await drainSpool(s.root); assert.equal(drain.deferred, 2); assert.equal((await spoolStats(s.root)).queued, 2);
  assert.equal((await s.owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] })).filter(doc => doc.metadata.externalConversationId === 'unknown-1').length, 0);
});

test('owned chat capture survives temporary drain outage and replay remains idempotent', async t => {
  const s = await setup(t); let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const lock = withVaultLock(s.root, () => hold);
  const input = { conversationId: 'retry-1', turnId: 'turn-1', membership: 'member' as const, externalProjectId: 'project-1', userText: 'Retry this capture.', assistantText: 'The retry should not duplicate it.' };
  const first = await captureOwnedChatTurn(s.root, s.registration.id, input); assert.equal(first.accepted, 2); assert.equal(first.queued, 2);
  release(); await lock; await drainSpool(s.root);
  await captureOwnedChatTurn(s.root, s.registration.id, input); await drainSpool(s.root);
  const docs = await s.owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'work' }] });
  assert.equal(docs.filter(doc => doc.kind === 'chat_message' && doc.metadata.externalConversationId === 'retry-1').length, 2);
});

test('queued owned-chat turns survive producer SIGKILL and restart drain without loss or duplication', async t => {
  const s = await setup(t);
  const moduleUrl = new URL('../packages/memory/capture.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { captureOwnedChatTurn } = await import(process.env.CAPTURE_MODULE_URL);
    await captureOwnedChatTurn(process.env.CAPTURE_TEST_ROOT, process.env.CAPTURE_REGISTRATION_ID, {
      conversationId: 'killed-producer-1', turnId: 'turn-kill-1', membership: 'standalone',
      title: 'Crash recovery', userText: 'Preserve this user message.', assistantText: 'Preserve this assistant response.'
    });
    process.stdout.write('CAPTURE_ACKNOWLEDGED\\n');
    setInterval(() => {}, 1000);
  `], {
    cwd: process.cwd(),
    env: { ...process.env, CAPTURE_MODULE_URL: moduleUrl, CAPTURE_TEST_ROOT: s.root, CAPTURE_REGISTRATION_ID: s.registration.id },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  ownChildProcess(t, child);
  let stdout = '';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`owned capture producer did not acknowledge; stdout=${stdout}`)), 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.includes('CAPTURE_ACKNOWLEDGED')) { clearTimeout(timeout); resolve(); }
    });
  });
  assert.equal(child.kill('SIGKILL'), true);
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  assert.equal(closed.signal, 'SIGKILL');
  assert.equal((await spoolStats(s.root)).queued, 2);

  const firstDrain = await drainSpool(s.root);
  assert.equal(firstDrain.ingested, 2);
  assert.equal((await spoolStats(s.root)).queued, 0);
  const repeatedDrain = await drainSpool(s.root);
  assert.equal(repeatedDrain.ingested, 0);
  const messages = (await s.owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] }))
    .filter(doc => doc.kind === 'chat_message' && doc.metadata.externalConversationId === 'killed-producer-1');
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(doc => doc.metadata.speaker).sort(), ['assistant', 'user']);
});

test('revoked or mismatched registration cannot capture, and project identity is registration-bound', async t => {
  const s = await setup(t);
  await revokeRegistration(s.root, s.registration.id);
  await assert.rejects(captureOwnedChatTurn(s.root, s.registration.id, { conversationId: 'x', turnId: 't', membership: 'standalone', userText: 'no', assistantText: 'no' }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  assert.equal((await spoolStats(s.root)).queued, 0);
  assert.ok(await readRegistration(s.root, s.registration.id) === undefined);
});

test('revoking a trusted source account rejects queued chat turns instead of retrying forever', async t => {
  const s = await setup(t);
  const queued = await captureOwnedChatTurn(s.root, s.registration.id, { conversationId: 'revoked-1', turnId: 'turn-1', membership: 'standalone', userText: 'queued before revocation', assistantText: 'also queued' });
  assert.equal(queued.accepted, 2);
  await s.projects.revokeSourceAccount('chatgpt', 'account-a');
  const result = await drainSpool(s.root);
  assert.equal(result.rejected, 2);
  assert.equal(result.deferred, 0);
  assert.equal((await spoolStats(s.root)).queued, 0);
  assert.equal((await s.owner.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'personal' }] })).filter(doc => doc.kind === 'chat_message').length, 0);
});
