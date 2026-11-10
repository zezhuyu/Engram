import { createHash } from 'node:crypto';
import { MDBError, type Document, type Scope, type Workspace } from '../core/types.js';
import type { Vault } from '../core/vault.js';

export const PERSONAL_WORKSPACE_ID = 'personal';
export const CHAT_PROVIDERS = ['chatgpt', 'claude', 'gemini', 'generic'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];
export type ProjectMembership = 'member' | 'standalone' | 'unknown';

export interface ChatSourceAccount {
  schemaVersion: 1;
  provider: ChatProvider;
  sourceAccountId: string;
  label: string;
  status: 'active' | 'revoked';
  registeredBy: string;
  registeredAt: string;
}

export interface ChatProjectBinding {
  schemaVersion: 1;
  provider: ChatProvider;
  sourceAccountId: string;
  externalProjectId: string;
  projectName: string;
  workspaceId: string;
  version: number;
  status: 'active' | 'unlinked';
  linkedAt: string;
  linkedBy: string;
  previousWorkspaceIds: string[];
}

export type ProjectRoute =
  | { status: 'routed'; workspaceId: string; bindingVersion?: number; reason: 'standalone' | 'project_binding' }
  | { status: 'pending'; reason: 'member_project_unmapped' }
  | { status: 'review_required'; reason: 'membership_unknown' };

const PERSONAL_SCOPE: Scope = { type: 'workspace', workspaceId: PERSONAL_WORKSPACE_ID };
const fail = (message: string): never => { throw new MDBError('INVALID_INPUT', message); };
const validProvider = (value: unknown): value is ChatProvider => CHAT_PROVIDERS.includes(value as ChatProvider);
function safeIdentity(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string') throw new MDBError('INVALID_INPUT', `Invalid ${label}`);
  if (value.length < 1 || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail(`Invalid ${label}`);
  return value;
}
function accountKey(provider: ChatProvider, sourceAccountId: string): string {
  return createHash('sha256').update(`${provider}\0${sourceAccountId}`).digest('hex');
}
function bindingKey(provider: ChatProvider, sourceAccountId: string, externalProjectId: string): string {
  return createHash('sha256').update(`${provider}\0${sourceAccountId}\0${externalProjectId}`).digest('hex');
}
function recordBody<T>(doc: Document, expectedKind: string): T {
  if (doc.kind !== expectedKind || doc.status !== 'active') throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
  try { return JSON.parse(doc.body) as T; } catch { throw new MDBError('INTERNAL', 'Chat registry record is malformed'); }
}

/** Provider project registry stored as immutable, journaled documents in Personal. */
export class ChatProjectRegistry {
  constructor(private readonly vault: Vault, private readonly now: () => Date = () => new Date()) {}

  async ensurePersonalWorkspace(): Promise<Workspace> {
    const visible = (await this.vault.listWorkspaces()).find(workspace => workspace.id === PERSONAL_WORKSPACE_ID);
    if (visible) return visible;
    if (!this.vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
    try { return await this.vault.createWorkspace(PERSONAL_WORKSPACE_ID, 'Personal conversations and account-scoped chat registry'); }
    catch (error) {
      // Concurrent owner initialization is idempotent from the caller's perspective.
      if (error instanceof MDBError && error.code === 'CONFLICT') {
        const existing = (await this.vault.listWorkspaces()).find(workspace => workspace.id === PERSONAL_WORKSPACE_ID);
        if (existing) return existing;
      }
      throw error;
    }
  }

  /** Account IDs are locally provisioned trust labels. Import files cannot choose or override them. */
  async registerSourceAccount(input: { provider: ChatProvider; sourceAccountId: string; label?: string }): Promise<ChatSourceAccount> {
    this.requireOwner();
    this.validateProvider(input.provider);
    const sourceAccountId = safeIdentity(input.sourceAccountId, 'sourceAccountId', 120);
    const label = safeIdentity(input.label ?? sourceAccountId, 'account label', 160);
    await this.ensurePersonalWorkspace();
    const id = accountKey(input.provider, sourceAccountId);
    const account: ChatSourceAccount = { schemaVersion: 1, provider: input.provider, sourceAccountId, label, status: 'active', registeredBy: this.vault.actor.actorId, registeredAt: this.now().toISOString() };
    const existing = await this.findAccount(input.provider, sourceAccountId);
    if (existing) {
      const prior = recordBody<ChatSourceAccount>(existing, 'chat_source_account');
      if (prior.status === 'active') return prior;
      const next: ChatSourceAccount = { ...prior, label, status: 'active', registeredBy: this.vault.actor.actorId, registeredAt: this.now().toISOString() };
      const restored = await this.vault.patch({ objectId: existing.id, expectedRevisionId: existing.revisionId, body: JSON.stringify(next), metadataPatch: { label, status: 'active' } });
      return recordBody<ChatSourceAccount>(restored, 'chat_source_account');
    }
    try {
      const doc = await this.vault.put({ scope: PERSONAL_SCOPE, kind: 'chat_source_account', title: `Chat source account: ${label}`, body: JSON.stringify(account), status: 'active', idempotencyKey: `chat-account:${id}:register`, metadata: { chatSchema: 1, provider: input.provider, sourceAccountId, status: 'active' } });
      return recordBody<ChatSourceAccount>(doc, 'chat_source_account');
    } catch (error) {
      if (!(error instanceof MDBError) || error.code !== 'CONFLICT') throw error;
      const existing = await this.findAccount(input.provider, sourceAccountId);
      if (!existing) throw error;
      const value = recordBody<ChatSourceAccount>(existing, 'chat_source_account');
      if (value.provider !== account.provider || value.sourceAccountId !== account.sourceAccountId) throw new MDBError('CONFLICT', 'Account identity collision');
      return value;
    }
  }

  async revokeSourceAccount(provider: ChatProvider, sourceAccountId: string): Promise<ChatSourceAccount> {
    this.requireOwner(); this.validateProvider(provider); safeIdentity(sourceAccountId, 'sourceAccountId', 120);
    const doc = await this.findAccount(provider, sourceAccountId);
    if (!doc) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
    const current = recordBody<ChatSourceAccount>(doc, 'chat_source_account');
    const updated: ChatSourceAccount = { ...current, status: 'revoked' };
    const saved = await this.vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, body: JSON.stringify(updated), metadataPatch: { status: 'revoked' } });
    return recordBody<ChatSourceAccount>(saved, 'chat_source_account');
  }

  async listSourceAccounts(): Promise<ChatSourceAccount[]> {
    await this.requireRegistryRead();
    return (await this.vault.listDocuments({ scopes: [PERSONAL_SCOPE] }))
      .filter(doc => doc.kind === 'chat_source_account')
      .map(doc => recordBody<ChatSourceAccount>(doc, 'chat_source_account'));
  }

  async createWorkspaceAndLink(input: { provider: ChatProvider; sourceAccountId: string; externalProjectId: string; projectName: string; workspaceId: string; description?: string }): Promise<ChatProjectBinding> {
    this.requireOwner();
    const workspaces = await this.vault.listWorkspaces();
    if (!workspaces.some(workspace => workspace.id === input.workspaceId)) await this.vault.createWorkspace(input.workspaceId, input.description ?? input.projectName);
    return this.linkProject(input);
  }

  async linkProject(input: { provider: ChatProvider; sourceAccountId: string; externalProjectId: string; projectName?: string; workspaceId: string }): Promise<ChatProjectBinding> {
    this.validateProvider(input.provider);
    const sourceAccountId = safeIdentity(input.sourceAccountId, 'sourceAccountId', 120);
    const externalProjectId = safeIdentity(input.externalProjectId, 'externalProjectId');
    const projectName = safeIdentity(input.projectName ?? externalProjectId, 'projectName', 300);
    const workspaceId = safeIdentity(input.workspaceId, 'workspaceId', 128);
    await this.requireRegistryWrite();
    await this.requireAccount(input.provider, sourceAccountId);
    if (!(await this.vault.canAccess({ type: 'workspace', workspaceId }, 'read')) || !(await this.vault.canAccess({ type: 'workspace', workspaceId }, 'write')) || !(await this.vault.listWorkspaces()).some(workspace => workspace.id === workspaceId)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
    const key = bindingKey(input.provider, sourceAccountId, externalProjectId);
    const existing = await this.findBinding(input.provider, sourceAccountId, externalProjectId);
    if (existing) {
      const prior = recordBody<ChatProjectBinding>(existing, 'chat_project_binding');
      if (prior.status === 'active') throw new MDBError('CONFLICT', 'Project already has an active workspace binding; use remap');
      const next: ChatProjectBinding = { ...prior, projectName, workspaceId, version: prior.version + 1, status: 'active', linkedAt: this.now().toISOString(), linkedBy: this.vault.actor.actorId };
      const saved = await this.vault.patch({ objectId: existing.id, expectedRevisionId: existing.revisionId, body: JSON.stringify(next), metadataPatch: { projectName, workspaceId, version: next.version, status: next.status } });
      return recordBody<ChatProjectBinding>(saved, 'chat_project_binding');
    }
    const binding: ChatProjectBinding = { schemaVersion: 1, provider: input.provider, sourceAccountId, externalProjectId, projectName, workspaceId, version: 1, status: 'active', linkedAt: this.now().toISOString(), linkedBy: this.vault.actor.actorId, previousWorkspaceIds: [] };
    try {
      const saved = await this.vault.put({ scope: PERSONAL_SCOPE, kind: 'chat_project_binding', title: `Chat project: ${projectName}`, body: JSON.stringify(binding), status: 'active', idempotencyKey: `chat-project:${key}:link:v1`, metadata: { chatSchema: 1, provider: input.provider, sourceAccountId, externalProjectId, projectName, workspaceId, version: 1, status: 'active' } });
      return recordBody<ChatProjectBinding>(saved, 'chat_project_binding');
    } catch (error) {
      if (!(error instanceof MDBError) || error.code !== 'CONFLICT') throw error;
      const raced = await this.findBinding(input.provider, sourceAccountId, externalProjectId);
      if (!raced) throw error;
      const value = recordBody<ChatProjectBinding>(raced, 'chat_project_binding');
      if (value.status === 'active' && value.workspaceId === workspaceId) return value;
      throw new MDBError('CONFLICT', 'Project already has an active workspace binding; use remap');
    }
  }

  async remapProject(input: { provider: ChatProvider; sourceAccountId: string; externalProjectId: string; workspaceId: string; expectedVersion: number }): Promise<ChatProjectBinding> {
    this.validateProvider(input.provider); await this.requireRegistryWrite();
    const sourceAccountId = safeIdentity(input.sourceAccountId, 'sourceAccountId', 120), externalProjectId = safeIdentity(input.externalProjectId, 'externalProjectId');
    await this.requireAccount(input.provider, sourceAccountId);
    const workspaceId = safeIdentity(input.workspaceId, 'workspaceId', 128);
    if (!(await this.vault.canAccess({ type: 'workspace', workspaceId }, 'read')) || !(await this.vault.canAccess({ type: 'workspace', workspaceId }, 'write')) || !(await this.vault.listWorkspaces()).some(workspace => workspace.id === workspaceId)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
    const doc = await this.findBinding(input.provider, sourceAccountId, externalProjectId);
    if (!doc) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
    const current = recordBody<ChatProjectBinding>(doc, 'chat_project_binding');
    if (current.status !== 'active' || current.version !== input.expectedVersion) throw new MDBError('CONFLICT', 'Project binding version changed');
    const next: ChatProjectBinding = { ...current, workspaceId, version: current.version + 1, linkedAt: this.now().toISOString(), linkedBy: this.vault.actor.actorId, previousWorkspaceIds: current.workspaceId === workspaceId ? current.previousWorkspaceIds : [...current.previousWorkspaceIds, current.workspaceId] };
    const saved = await this.vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, body: JSON.stringify(next), metadataPatch: { workspaceId, version: next.version } });
    return recordBody<ChatProjectBinding>(saved, 'chat_project_binding');
  }

  async unlinkProject(input: { provider: ChatProvider; sourceAccountId: string; externalProjectId: string; expectedVersion: number }): Promise<ChatProjectBinding> {
    this.validateProvider(input.provider); await this.requireRegistryWrite();
    const sourceAccountId = safeIdentity(input.sourceAccountId, 'sourceAccountId', 120), externalProjectId = safeIdentity(input.externalProjectId, 'externalProjectId');
    await this.requireAccount(input.provider, sourceAccountId);
    const doc = await this.findBinding(input.provider, sourceAccountId, externalProjectId);
    if (!doc) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
    const current = recordBody<ChatProjectBinding>(doc, 'chat_project_binding');
    if (current.status !== 'active' || current.version !== input.expectedVersion) throw new MDBError('CONFLICT', 'Project binding version changed');
    const next: ChatProjectBinding = { ...current, status: 'unlinked', version: current.version + 1, linkedAt: this.now().toISOString(), linkedBy: this.vault.actor.actorId };
    const saved = await this.vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, body: JSON.stringify(next), metadataPatch: { status: next.status, version: next.version } });
    return recordBody<ChatProjectBinding>(saved, 'chat_project_binding');
  }

  async renameProject(input: { provider: ChatProvider; sourceAccountId: string; externalProjectId: string; projectName: string; expectedVersion: number }): Promise<ChatProjectBinding> {
    this.validateProvider(input.provider); await this.requireRegistryWrite();
    const sourceAccountId = safeIdentity(input.sourceAccountId, 'sourceAccountId', 120), externalProjectId = safeIdentity(input.externalProjectId, 'externalProjectId'), projectName = safeIdentity(input.projectName, 'projectName', 300);
    const doc = await this.findBinding(input.provider, sourceAccountId, externalProjectId);
    if (!doc) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
    const current = recordBody<ChatProjectBinding>(doc, 'chat_project_binding');
    if (current.status !== 'active' || current.version !== input.expectedVersion) throw new MDBError('CONFLICT', 'Project binding version changed');
    const next: ChatProjectBinding = { ...current, projectName, version: current.version + 1, linkedAt: this.now().toISOString(), linkedBy: this.vault.actor.actorId };
    const saved = await this.vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, title: `Chat project: ${projectName}`, body: JSON.stringify(next), metadataPatch: { projectName, version: next.version } });
    return recordBody<ChatProjectBinding>(saved, 'chat_project_binding');
  }

  async listProjects(): Promise<ChatProjectBinding[]> {
    await this.requireRegistryRead();
    const [docs, workspaces] = await Promise.all([this.vault.listDocuments({ scopes: [PERSONAL_SCOPE] }), this.vault.listWorkspaces()]);
    const visibleWorkspaces = new Set(workspaces.map(workspace => workspace.id));
    const bindings = docs.filter(doc => doc.kind === 'chat_project_binding').map(doc => recordBody<ChatProjectBinding>(doc, 'chat_project_binding'));
    const visible: ChatProjectBinding[] = [];
    for (const binding of bindings) if (binding.status === 'active' && visibleWorkspaces.has(binding.workspaceId) && await this.vault.canAccess({ type: 'workspace', workspaceId: binding.workspaceId }, 'read')) visible.push(binding);
    return visible;
  }

  async resolveProject(input: { provider: ChatProvider; sourceAccountId: string; externalProjectId?: string | null; membership: ProjectMembership; access?: 'read' | 'write' }): Promise<ProjectRoute> {
    this.validateProvider(input.provider); await this.requireRegistryRead();
    const sourceAccountId = safeIdentity(input.sourceAccountId, 'sourceAccountId', 120);
    if (!['member', 'standalone', 'unknown'].includes(input.membership)) fail('Invalid project membership');
    await this.requireAccount(input.provider, sourceAccountId);
    if (input.membership === 'unknown') return { status: 'review_required', reason: 'membership_unknown' };
    if (input.membership === 'standalone') {
      if (input.externalProjectId) throw new MDBError('INVALID_INPUT', 'A standalone conversation cannot carry an external project identity');
      if (!(await this.vault.canAccess(PERSONAL_SCOPE, input.access ?? 'write'))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
      return { status: 'routed', workspaceId: PERSONAL_WORKSPACE_ID, reason: 'standalone' };
    }
    if (!input.externalProjectId) return { status: 'pending', reason: 'member_project_unmapped' };
    const externalProjectId = safeIdentity(input.externalProjectId, 'externalProjectId');
    const doc = await this.findBinding(input.provider, sourceAccountId, externalProjectId);
    if (!doc) return { status: 'pending', reason: 'member_project_unmapped' };
    const binding = recordBody<ChatProjectBinding>(doc, 'chat_project_binding');
    if (binding.status !== 'active') return { status: 'pending', reason: 'member_project_unmapped' };
    const destination = { type: 'workspace' as const, workspaceId: binding.workspaceId };
    if (!(await this.vault.canAccess(destination, 'read')) || ((input.access ?? 'write') === 'write' && !(await this.vault.canAccess(destination, 'write')))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
    return { status: 'routed', workspaceId: binding.workspaceId, bindingVersion: binding.version, reason: 'project_binding' };
  }

  private async findAccount(provider: ChatProvider, sourceAccountId: string): Promise<Document | undefined> {
    return (await this.vault.listDocuments({ scopes: [PERSONAL_SCOPE] })).find(doc => doc.kind === 'chat_source_account' && doc.metadata.provider === provider && doc.metadata.sourceAccountId === sourceAccountId);
  }
  private async findBinding(provider: ChatProvider, sourceAccountId: string, externalProjectId: string): Promise<Document | undefined> {
    return (await this.vault.listDocuments({ scopes: [PERSONAL_SCOPE] })).find(doc => doc.kind === 'chat_project_binding' && doc.metadata.provider === provider && doc.metadata.sourceAccountId === sourceAccountId && doc.metadata.externalProjectId === externalProjectId);
  }
  private async requireRegistryRead(): Promise<void> { await this.ensurePersonalVisible('read'); }
  private async requireRegistryWrite(): Promise<void> { await this.ensurePersonalVisible('write'); }
  private async ensurePersonalVisible(action: 'read' | 'write'): Promise<void> {
    if (!(await this.vault.canAccess(PERSONAL_SCOPE, action)) || !(await this.vault.listWorkspaces()).some(workspace => workspace.id === PERSONAL_WORKSPACE_ID)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
  }
  private async requireAccount(provider: ChatProvider, sourceAccountId: string): Promise<ChatSourceAccount> {
    const doc = await this.findAccount(provider, sourceAccountId);
    if (!doc) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
    const account = recordBody<ChatSourceAccount>(doc, 'chat_source_account');
    if (account.provider !== provider || account.sourceAccountId !== sourceAccountId || account.status !== 'active') throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
    return account;
  }
  private validateProvider(value: unknown): asserts value is ChatProvider { if (!validProvider(value)) fail('Unsupported chat provider'); }
  private requireOwner(): void { if (!this.vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Owner access is required'); }
}
