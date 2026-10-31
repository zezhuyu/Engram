import './helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Engram, type ActorContext, type ChatProjectBinding } from '../packages/sdk/index.js';
import { MDBError, OWNER } from '../packages/core/types.js';

async function setup(t: { after(fn: () => void | Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'engram-chat-projects-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const owner = new Engram(root, OWNER); await owner.init({ sqlite: false });
  await owner.chatProjects.ensurePersonalWorkspace();
  await owner.createWorkspace('shared-project', 'shared', { reader: ['read', 'write'] });
  await owner.createWorkspace('private-project', 'private');
  const account = await owner.chatProjects.registerSourceAccount({ provider: 'chatgpt', sourceAccountId: 'acct-one', label: 'Account one' });
  await owner.chatProjects.registerSourceAccount({ provider: 'claude', sourceAccountId: 'acct-one', label: 'Claude account one' });
  await owner.chatProjects.registerSourceAccount({ provider: 'gemini', sourceAccountId: 'acct-two', label: 'Gemini account two' });
  return { root, owner, account };
}

test('Personal is created through normal Vault workspace creation and requires normal actor access', async t => {
  const { root, owner } = await setup(t);
  assert.ok((await owner.listWorkspaces()).some(workspace => workspace.id === 'personal'));
  const actor: ActorContext = { actorId: 'reader', permissions: ['workspace:shared-project:read', 'workspace:shared-project:write'] };
  const client = new Engram(root, actor);
  await assert.rejects(client.chatProjects.ensurePersonalWorkspace(), (error: unknown) => error instanceof MDBError && error.code === 'NOT_FOUND_OR_FORBIDDEN');
  await client.close();
  await owner.close();
});

test('provider project bindings are account-scoped, many-to-one, and retain stable IDs across rename', async t => {
  const { owner } = await setup(t);
  const chatgpt = await owner.chatProjects.linkProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'project-1', projectName: 'Alpha', workspaceId: 'shared-project' });
  const claude = await owner.chatProjects.linkProject({ provider: 'claude', sourceAccountId: 'acct-one', externalProjectId: 'project-9', projectName: 'Beta', workspaceId: 'shared-project' });
  const sameIdOtherAccount = await owner.chatProjects.linkProject({ provider: 'gemini', sourceAccountId: 'acct-two', externalProjectId: 'project-1', projectName: 'Gamma', workspaceId: 'shared-project' });
  assert.equal(chatgpt.workspaceId, 'shared-project'); assert.equal(claude.workspaceId, chatgpt.workspaceId); assert.equal(sameIdOtherAccount.workspaceId, 'shared-project');
  assert.equal((await owner.chatProjects.listProjects()).length, 3);
  const renamed = await owner.chatProjects.renameProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'project-1', projectName: 'Renamed', expectedVersion: 1 });
  assert.equal(renamed.version, 2); assert.equal(renamed.externalProjectId, 'project-1'); assert.equal(renamed.projectName, 'Renamed');
  await assert.rejects(owner.chatProjects.remapProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'project-1', workspaceId: 'private-project', expectedVersion: 1 }), (error: unknown) => error instanceof MDBError && error.code === 'CONFLICT');
  await owner.close();
});

test('ChatGPT can create a workspace, Claude can link that workspace, Gemini can create another, and standalone routes to Personal', async t => {
  const { owner } = await setup(t);
  const chatgpt = await owner.chatProjects.createWorkspaceAndLink({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'chatgpt-project', projectName: 'ChatGPT project', workspaceId: 'chatgpt-work' });
  assert.equal(chatgpt.workspaceId, 'chatgpt-work');
  assert.ok((await owner.listWorkspaces()).some(workspace => workspace.id === 'chatgpt-work'));
  const claude = await owner.chatProjects.linkProject({ provider: 'claude', sourceAccountId: 'acct-one', externalProjectId: 'claude-project', workspaceId: chatgpt.workspaceId });
  assert.equal(claude.workspaceId, chatgpt.workspaceId, 'different provider projects may share an Engram workspace');
  const gemini = await owner.chatProjects.createWorkspaceAndLink({ provider: 'gemini', sourceAccountId: 'acct-two', externalProjectId: 'gemini-project', projectName: 'Gemini project', workspaceId: 'gemini-work' });
  assert.equal(gemini.workspaceId, 'gemini-work');
  assert.ok((await owner.listWorkspaces()).some(workspace => workspace.id === 'gemini-work'));
  for (const [provider, sourceAccountId] of [['chatgpt', 'acct-one'], ['claude', 'acct-one'], ['gemini', 'acct-two']] as const) {
    assert.deepEqual(await owner.chatProjects.resolveProject({ provider, sourceAccountId, membership: 'standalone' }), { status: 'routed', workspaceId: 'personal', reason: 'standalone' });
  }
  await owner.close();
});

test('membership routes standalone to Personal, unmapped member to pending, and unknown to explicit review', async t => {
  const { owner } = await setup(t);
  const standalone = await owner.chatProjects.resolveProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', membership: 'standalone' });
  const pending = await owner.chatProjects.resolveProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'not-linked', membership: 'member' });
  const unknown = await owner.chatProjects.resolveProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'project-unknown', membership: 'unknown' });
  assert.deepEqual(standalone, { status: 'routed', workspaceId: 'personal', reason: 'standalone' });
  await assert.rejects(owner.chatProjects.resolveProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'untrusted-project', membership: 'standalone' }), (error: unknown) => error instanceof MDBError && error.code === 'INVALID_INPUT');
  assert.deepEqual(pending, { status: 'pending', reason: 'member_project_unmapped' });
  assert.deepEqual(unknown, { status: 'review_required', reason: 'membership_unknown' });
  const binding = await owner.chatProjects.linkProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'p', workspaceId: 'shared-project' });
  assert.deepEqual(await owner.chatProjects.resolveProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'p', membership: 'member' }), { status: 'routed', workspaceId: 'shared-project', bindingVersion: binding.version, reason: 'project_binding' });
  await owner.close();
});

test('unmapped member projects never fall through to Personal and remap/unlink are versioned', async t => {
  const { owner } = await setup(t);
  const initial = await owner.chatProjects.linkProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'p', workspaceId: 'shared-project' });
  const moved: ChatProjectBinding = await owner.chatProjects.remapProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'p', workspaceId: 'private-project', expectedVersion: initial.version });
  assert.deepEqual(moved.previousWorkspaceIds, ['shared-project']);
  assert.deepEqual(await owner.chatProjects.resolveProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'p', membership: 'member' }), { status: 'routed', workspaceId: 'private-project', bindingVersion: 2, reason: 'project_binding' });
  const unlinked = await owner.chatProjects.unlinkProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'p', expectedVersion: moved.version });
  assert.equal(unlinked.status, 'unlinked');
  assert.deepEqual(await owner.chatProjects.resolveProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'p', membership: 'member' }), { status: 'pending', reason: 'member_project_unmapped' });
  await owner.close();
});

test('credential-bound actors cannot inspect or route into a project they cannot read', async t => {
  const { root, owner } = await setup(t);
  await owner.chatProjects.linkProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'private-id', workspaceId: 'private-project' });
  await owner.grant('personal', 'reader', ['read', 'write']);
  const actor: ActorContext = { actorId: 'reader', permissions: ['workspace:personal:read', 'workspace:personal:write'], credentialBound: true, authId: 'cred-reader' };
  const client = new Engram(root, actor);
  assert.equal((await client.chatProjects.listProjects()).length, 0, 'unauthorized target binding is omitted without metadata leak');
  await assert.rejects(client.chatProjects.resolveProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'private-id', membership: 'member' }), (error: unknown) => error instanceof MDBError && error.code === 'NOT_FOUND_OR_FORBIDDEN');
  await assert.rejects(client.chatProjects.linkProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'other', workspaceId: 'private-project' }), (error: unknown) => error instanceof MDBError && error.code === 'NOT_FOUND_OR_FORBIDDEN');
  await client.close(); await owner.close();
});

test('account revocation immediately prevents project resolution; only owner may provision accounts', async t => {
  const { root, owner } = await setup(t);
  await owner.chatProjects.linkProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'p', workspaceId: 'shared-project' });
  await owner.chatProjects.revokeSourceAccount('chatgpt', 'acct-one');
  await assert.rejects(owner.chatProjects.resolveProject({ provider: 'chatgpt', sourceAccountId: 'acct-one', externalProjectId: 'p', membership: 'member' }), (error: unknown) => error instanceof MDBError && error.code === 'NOT_FOUND_OR_FORBIDDEN');
  const actor: ActorContext = { actorId: 'reader', permissions: ['workspace:personal:read', 'workspace:personal:write'], credentialBound: true };
  const client = new Engram(root, actor);
  await assert.rejects(client.chatProjects.registerSourceAccount({ provider: 'generic', sourceAccountId: 'x' }), (error: unknown) => error instanceof MDBError && error.code === 'NOT_FOUND_OR_FORBIDDEN');
  await client.close(); await owner.close();
});
