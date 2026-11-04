import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safePath, withVaultLock } from '../storage-local/index.js';
import { assertDurableWriteCapacity } from '../core/storage-lifecycle.js';
import { looksSecret, redactText } from '../memory/redact.js';

export interface AuditRecord { at: string; key: string; oldValue: unknown; newValue: unknown; result: 'attempt' | 'applied' | 'failed' | 'rejected' }
const SECRET = /(sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/iu;
function redact(value: unknown): unknown {
  if (typeof value === 'string') { const safe = redactText(value); return SECRET.test(value) || looksSecret(value) && safe === value ? '[redacted]' : safe.length > 256 ? `${safe.slice(0, 32)}…` : safe; }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /key|token|secret|password/i.test(key) ? '[redacted]' : redact(item)]));
  return value;
}
export async function appendAudit(root: string, record: AuditRecord): Promise<void> {
  const file = await safePath(root, '.mdb/dashboard/audit.jsonl');
  await withVaultLock(root, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify({ ...record, oldValue: redact(record.oldValue), newValue: redact(record.newValue) })}\n`;
    await assertDurableWriteCapacity(root, Buffer.byteLength(line) + 4096);
    await fs.appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
  });
}
export async function readAudit(root: string): Promise<AuditRecord[]> {
  try { return (await fs.readFile(await safePath(root, '.mdb/dashboard/audit.jsonl'), 'utf8')).split('\n').filter(Boolean).slice(-200).flatMap(line => { try { return [JSON.parse(line) as AuditRecord]; } catch { return []; } }); }
  catch { return []; }
}
