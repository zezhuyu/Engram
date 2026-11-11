import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MDBError, type ActorContext } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { atomicWrite, safePath, withVaultLock } from '../storage-local/index.js';
import { deleteCredentialReplicaDevices } from '../replication/devices.js';

const FILE = '.mdb/http-credentials.json';
const actorPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const permissionPattern = /^(?:workspace:create|workspace:[A-Za-z0-9][A-Za-z0-9_-]{0,99}:(?:read|write|promote|\*)|workspace:[A-Za-z0-9][A-Za-z0-9_-]{0,99}:collection:[A-Za-z0-9][A-Za-z0-9._-]{0,99}:(?:read|write)|global:(?:wiki|shared|discoveries|profile|\*):(?:read|write|promote|\*))$/;
export const isValidRemotePermission = (permission: string): boolean => permissionPattern.test(permission) && !permission.includes('*');
type Credential = { id: string; tokenHash: string; actorId: string; permissions: string[]; createdAt: string; expiresAt?: string; lastUsedAt?: string };
export interface CredentialAuditEvent { at: string; action: 'created' | 'revoked' | 'rotated' | 'authorization_failed'; attempts?: number; actorId?: string; credentialId?: string; replacementId?: string; permissions?: string[] }
type CredentialStore = { version: 1; credentials: Credential[]; audit?: CredentialAuditEvent[] };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const lastUsedUpdates = new Map<string, { writtenAt: number; pending: boolean }>();
const expiredDeviceCleanup = new Set<string>();
const auditCap = 10_000;
const appendAudit = (store: CredentialStore, event: CredentialAuditEvent): CredentialAuditEvent[] => [...(store.audit ?? []), event].slice(-auditCap);

async function readStore(root: string): Promise<CredentialStore> {
  try {
    const store = JSON.parse(await fs.readFile(await safePath(root, FILE), 'utf8')) as CredentialStore;
    if (store.version !== 1 || !Array.isArray(store.credentials) || store.credentials.some(c => !c || typeof c.id !== 'string' || !/^[a-f0-9]{64}$/.test(c.tokenHash) || !actorPattern.test(c.actorId) || !Array.isArray(c.permissions) || c.permissions.some(p => typeof p !== 'string' || !permissionPattern.test(p)) || c.expiresAt !== undefined && !Number.isFinite(Date.parse(c.expiresAt)) || c.lastUsedAt !== undefined && !Number.isFinite(Date.parse(c.lastUsedAt))) || (store.audit !== undefined && (!Array.isArray(store.audit) || store.audit.length > auditCap || store.audit.some(a => !a || typeof a.at !== 'string' || !['created', 'revoked', 'rotated', 'authorization_failed'].includes(a.action))))) throw new Error('shape');
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, credentials: [] };
    throw new MDBError('INVALID_INPUT', 'HTTP credential registry is invalid');
  }
}

export async function hasHttpCredentials(root: string): Promise<boolean> {
  return (await readStore(root)).credentials.length > 0;
}

/** Record one failed HTTP auth attempt after all configured credential types fail. */
export async function recordHttpAuthorizationFailure(root: string): Promise<void> {
  await recordHttpAuthorizationFailures(root, 1);
}

/** Persist a bounded aggregate rather than doing a lock/fsync for every bad request. */
export async function recordHttpAuthorizationFailures(root: string, attempts: number): Promise<void> {
  if (!Number.isSafeInteger(attempts) || attempts < 1) return;
  await withVaultLock(root, async () => {
    const store = await readStore(root);
    if (!store.credentials.length) return;
    store.audit = appendAudit(store, { at: new Date().toISOString(), action: 'authorization_failed', attempts });
    await atomicWrite(root, FILE, JSON.stringify(store, null, 2));
  });
}

export async function credentialAudit(owner: Vault): Promise<CredentialAuditEvent[]> {
  if (!owner.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Owner access is required');
  return (await readStore(owner.root)).audit ?? [];
}

/** Owner-only inventory deliberately excludes token hashes and bearer values. */
export async function listHttpCredentials(owner: Vault): Promise<Array<{ id: string; actorId: string; permissions: string[]; createdAt: string; lastUsedAt: string | null; expiresAt: string | null }>> {
  if (!owner.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Owner access is required');
  return (await readStore(owner.root)).credentials.map(c => ({ id: c.id, actorId: c.actorId, permissions: [...c.permissions], createdAt: c.createdAt, lastUsedAt: c.lastUsedAt ?? null, expiresAt: c.expiresAt ?? null }));
}

/** Owner-only. The secret is returned once; only its SHA-256 digest is stored. */
export async function createHttpCredential(owner: Vault, actorId: string, permissions: string[], expiresAt?: string): Promise<{ id: string; token: string }> {
  if (!owner.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Owner access is required');
  if (!actorPattern.test(actorId) || actorId === 'owner' || !permissions.length || permissions.some(permission => !permissionPattern.test(permission))) throw new MDBError('INVALID_INPUT', 'Invalid actor ID or scoped permissions');
  const token = `engram_${randomBytes(32).toString('base64url')}`;
  if (expiresAt !== undefined && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 366 * 24 * 60 * 60_000)) throw new MDBError('INVALID_INPUT', 'Credential expiry must be within the next 366 days');
  const credential: Credential = { id: `cred_${randomBytes(10).toString('hex')}`, tokenHash: hash(token), actorId, permissions: [...new Set(permissions)], createdAt: new Date().toISOString(), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) };
  await withVaultLock(owner.root, async () => {
    const store = await readStore(owner.root);
    if (store.credentials.some(item => item.actorId === actorId)) throw new MDBError('CONFLICT', 'An active HTTP credential already exists for this actor; revoke it before rotating');
    store.credentials.push(credential);
    store.audit = appendAudit(store, { at: credential.createdAt, action: 'created', actorId: owner.actor.actorId, credentialId: credential.id, permissions: credential.permissions });
    await atomicWrite(owner.root, FILE, JSON.stringify(store, null, 2));
  });
  return { id: credential.id, token };
}

export async function revokeHttpCredential(owner: Vault, credentialId: string): Promise<boolean> {
  if (!owner.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Owner access is required');
  let removed = false;
  await withVaultLock(owner.root, async () => {
    const store = await readStore(owner.root); const removedCredential = store.credentials.find(item => item.id === credentialId); const next = store.credentials.filter(item => item.id !== credentialId);
    removed = next.length !== store.credentials.length;
    if (removed) await atomicWrite(owner.root, FILE, JSON.stringify({ ...store, credentials: next, audit: appendAudit(store, { at: new Date().toISOString(), action: 'revoked', actorId: owner.actor.actorId, credentialId, permissions: removedCredential?.permissions }) }, null, 2));
  });
  if (removed) await deleteCredentialReplicaDevices(owner.root, credentialId);
  return removed;
}

/** Atomically invalidates the old token and issues a replacement for the same server identity. */
export async function rotateHttpCredential(owner: Vault, credentialId: string, permissions?: string[]): Promise<{ id: string; token: string }> {
  if (!owner.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Owner access is required');
  const token = `engram_${randomBytes(32).toString('base64url')}`; const id = `cred_${randomBytes(10).toString('hex')}`;
  let created: Credential | undefined;
  await withVaultLock(owner.root, async () => {
    const store = await readStore(owner.root); const old = store.credentials.find(item => item.id === credentialId);
    if (!old) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Credential not found');
    if (old.expiresAt && Date.parse(old.expiresAt) <= Date.now()) throw new MDBError('INVALID_INPUT', 'Expired credentials cannot be rotated; create a new scoped credential');
    const nextPermissions = [...new Set(permissions ?? old.permissions)];
    if (!nextPermissions.length || nextPermissions.some(permission => !permissionPattern.test(permission))) throw new MDBError('INVALID_INPUT', 'Invalid scoped permissions');
    created = { id, tokenHash: hash(token), actorId: old.actorId, permissions: nextPermissions, createdAt: new Date().toISOString(), ...(old.expiresAt ? { expiresAt: old.expiresAt } : {}) };
    const credentials = [...store.credentials.filter(item => item.id !== old.id), created];
    const audit = appendAudit(store, { at: created.createdAt, action: 'rotated', actorId: owner.actor.actorId, credentialId: old.id, replacementId: created.id, permissions: nextPermissions });
    await atomicWrite(owner.root, FILE, JSON.stringify({ ...store, credentials, audit }, null, 2));
  });
  await deleteCredentialReplicaDevices(owner.root, credentialId);
  return { id, token };
}

export async function resolveHttpActor(root: string, authorization: string | undefined, legacyToken?: string, legacyActor: ActorContext = { actorId: 'mcp-anonymous', permissions: [] }, auditFailure = true): Promise<ActorContext | undefined> {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? '');
  if (!match) {
    if (auditFailure) await recordHttpAuthorizationFailure(root);
    return undefined;
  }
  const token = match[1]!; const digest = Buffer.from(hash(token));
  const store = await readStore(root);
  for (const credential of store.credentials) if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) { const key = `${path.resolve(root)}:${credential.id}`; if (!expiredDeviceCleanup.has(key)) { await deleteCredentialReplicaDevices(root, credential.id); expiredDeviceCleanup.add(key); } }
  let resolved: ActorContext | undefined;
  for (const credential of store.credentials) {
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) continue;
    const expected = Buffer.from(credential.tokenHash);
    if (expected.length === digest.length && timingSafeEqual(expected, digest)) resolved = { actorId: credential.actorId, permissions: [...credential.permissions], credentialBound: true, authId: `credential:${credential.id}` };
  }
  if (resolved) {
    const credential = store.credentials.find(item => resolved!.authId === `credential:${item.id}`);
    if (credential) {
      const key = `${path.resolve(root)}:${credential.id}`, now = Date.now(), state = lastUsedUpdates.get(key) ?? { writtenAt: 0, pending: false };
      if (!state.pending && now - state.writtenAt >= 30_000) {
        state.pending = true; lastUsedUpdates.set(key, state);
        try {
          await withVaultLock(root, async () => { const current = await readStore(root), entry = current.credentials.find(item => item.id === credential.id); if (entry) { entry.lastUsedAt = new Date().toISOString(); await atomicWrite(root, FILE, JSON.stringify(current, null, 2)); } });
          state.writtenAt = now;
        } catch { /* last-used telemetry must not block an otherwise valid credential */ }
        finally { state.pending = false; if (lastUsedUpdates.size > 4096) lastUsedUpdates.delete(lastUsedUpdates.keys().next().value!); }
      }
    }
    return resolved;
  }
  if (legacyToken) {
    const provided = Buffer.from(token), expected = Buffer.from(legacyToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return { actorId: legacyActor.actorId, permissions: [...legacyActor.permissions], authId: `legacy:${hash(token)}` };
  }
  if (auditFailure && store.credentials.length) await recordHttpAuthorizationFailure(root);
  return undefined;
}
