import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { dreamer } from '../dream/helpers.js';
import { AdaptiveIntelligence } from '../../packages/adaptive/index.js';
import { CancelledError } from '../../packages/models/errors.js';
import type { Document, ModelCallOptions, ModelProposal, ModelProvider, ModelRequest, Scope } from '../../packages/sdk/index.js';
import type { Vault } from '../../packages/core/vault.js';

export type T = { after(fn: () => void | Promise<void>): void };
export const ws = (workspaceId: string): Scope => ({ type: 'workspace', workspaceId });
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Deterministic stand-in for a model: profile requests return the user's own explicit statement as an insight (key taken from "[key:xyz]"); dream requests use the shared dreamer. */
export class Scripted implements ModelProvider {
  readonly id = 'scripted'; calls: ModelRequest[] = []; private readonly dream = dreamer();
  onProfile?: (req: ModelRequest, options?: ModelCallOptions) => Promise<void> | void; profileFails?: (req: ModelRequest) => Error | undefined; dreamFails?: () => Error | undefined; profileWaitMs = 0;
  profileCalls = () => this.calls.filter(c => c.job === 'profile'); dreamCalls = () => this.calls.filter(c => c.job === 'dream');
  async generate(req: ModelRequest, options?: ModelCallOptions): Promise<ModelProposal> {
    this.calls.push(req);
    if (req.job === 'dream') { const e = this.dreamFails?.(); if (e) throw e; return this.dream.generate(req, options); }
    if (req.job !== 'profile') throw new Error(`unexpected job ${req.job}`);
    await this.onProfile?.(req, options); const e = this.profileFails?.(req); if (e) throw e;
    for (let waited = 0; waited < this.profileWaitMs; waited += 10) { if (options?.signal?.aborted) throw new CancelledError(); await sleep(10); }
    if (options?.signal?.aborted) throw new CancelledError();
    const doc = req.documents.find((d: Document) => d.metadata.speaker === 'user') ?? req.documents[0]!;
    const key = /\[key:(\w+)\]/.exec(doc.body)?.[1] ?? 'general'; const word = /prefer (\w+)/i.exec(doc.body)?.[1] ?? 'something';
    const span = doc.body.slice(0, Math.min(doc.body.length, 90));
    return { kind: 'user_insight', title: `Prefers ${word}`, body: `The user prefers ${word}.`, evidence: [{ uri: doc.uri, revisionId: doc.revisionId, span }], metadata: { category: 'preference', preferenceKey: key, sensitivity: 'none', explicitStatement: true } };
  }
}
export interface World { root: string; vault: Vault; ai: AdaptiveIntelligence; provider: Scripted; say: (workspaceId: string, text: string, extra?: Record<string, unknown>) => Promise<Document>; note: (workspaceId: string, kind: string, title: string, body: string, tags?: string[]) => Promise<Document> }
export async function world(t: T, options: { sqlite?: boolean; config?: Record<string, unknown>; workspaces?: string[]; provider?: boolean } = {}): Promise<World> {
  const { root, vault } = await disposableVault(t, { sqlite: options.sqlite ?? false });
  for (const id of options.workspaces ?? ['alpha', 'beta']) await vault.createWorkspace(id, `workspace ${id}`);
  const config = await vault.config(); config.dream = { ...config.dream, enabled: true, eventDriven: false, modes: ['micro', 'deep', 'strategic'] }; await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(config));
  const provider = new Scripted(); const ai = new AdaptiveIntelligence(vault, options.provider === false ? undefined : provider);
  await ai.configure({ enabled: true, autoAccept: 'low-risk', timezone: 'UTC', resources: { maxLoadAverage: 10_000, maxRssMiB: 1_000_000, activityPollMs: 20 }, ...(options.config ?? {}) } as never);
  const say = (workspaceId: string, text: string, extra: Record<string, unknown> = {}) => vault.put({ scope: ws(workspaceId), kind: 'observation', title: 'User message', body: text, metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message', eventTime: new Date().toISOString(), ...extra } });
  const note = (workspaceId: string, kind: string, title: string, body: string, tags: string[] = []) => vault.put({ scope: ws(workspaceId), kind, title, body, tags });
  return { root, vault, ai, provider, say, note };
}
