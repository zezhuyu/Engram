import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

/**
 * Binds an evaluation report to the exact inputs that produced it: corpus (and pack) digest, evaluator code digest, source fingerprint, tree state and model
 * configuration. A verifier can then refuse a report that was produced from a different corpus, evaluator or source than the one being judged.
 */
export const PROVENANCE_SCHEMA = 'engram-eval-provenance/1';
export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
export interface FileDigest { path: string; sha256: string; bytes: number }
export interface EvaluationProvenance {
  schema: typeof PROVENANCE_SCHEMA; corpus: FileDigest; pack?: FileDigest; evaluator: { files: Record<string, string>; sha256: string };
  sourceFingerprint: string; treeState: string;
  model: { provider: string; model: string | null; baseUrl: string | null; temperature: string | null; allowNetwork: boolean };
  runs: number; createdAt: string;
}
export async function digestFile(path: string): Promise<FileDigest> { const data = await fs.readFile(path); return { path, sha256: sha256Hex(data), bytes: data.length }; }
export async function digestFiles(paths: string[]): Promise<{ files: Record<string, string>; sha256: string }> {
  const files: Record<string, string> = {}; for (const p of [...paths].sort()) files[p] = (await digestFile(p)).sha256;
  return { files, sha256: sha256Hex(Object.entries(files).map(([p, h]) => `${p}:${h}`).join('\n')) };
}
export async function buildProvenance(input: { corpusPath: string; packPath?: string; evaluatorFiles: string[]; sourceFingerprint: string; treeState: string; model: EvaluationProvenance['model']; runs: number; now?: Date }): Promise<EvaluationProvenance> {
  return { schema: PROVENANCE_SCHEMA, corpus: await digestFile(input.corpusPath), ...(input.packPath ? { pack: await digestFile(input.packPath) } : {}), evaluator: await digestFiles(input.evaluatorFiles), sourceFingerprint: input.sourceFingerprint, treeState: input.treeState, model: input.model, runs: input.runs, createdAt: (input.now ?? new Date()).toISOString() };
}
export type ProvenanceStatus = 'BOUND' | 'UNBOUND' | 'MISMATCH';
export interface ProvenanceVerdict { status: ProvenanceStatus; problems: string[] }
/** UNBOUND = a historical report without provenance (never silently upgraded); MISMATCH = provenance present but does not match the expectation. */
export async function verifyProvenance(report: { provenance?: unknown }, expected: { corpusPath: string; evaluatorFiles: string[]; sourceFingerprint?: string }): Promise<ProvenanceVerdict> {
  const p = report.provenance as Partial<EvaluationProvenance> | undefined;
  if (!p || typeof p !== 'object') return { status: 'UNBOUND', problems: ['report carries no provenance block (historical report)'] };
  const problems: string[] = [];
  if (p.schema !== PROVENANCE_SCHEMA) problems.push('unknown provenance schema');
  if (!p.model || typeof p.model.provider !== 'string' || !('model' in p.model)) problems.push('model configuration missing');
  if (!p.corpus?.sha256 || p.corpus.sha256 !== (await digestFile(expected.corpusPath).catch(() => ({ sha256: 'unreadable' }))).sha256) problems.push('corpus digest does not match the canonical corpus');
  const now = await digestFiles(expected.evaluatorFiles).catch(() => undefined);
  if (!p.evaluator?.sha256 || !now || p.evaluator.sha256 !== now.sha256) problems.push('evaluator version (code digest) does not match');
  if (expected.sourceFingerprint !== undefined && p.sourceFingerprint !== expected.sourceFingerprint) problems.push('source fingerprint does not match');
  if (p.treeState !== 'clean') problems.push(`tree state was ${String(p.treeState)} (a release report needs a clean committed tree)`);
  return { status: problems.length ? 'MISMATCH' : 'BOUND', problems };
}
