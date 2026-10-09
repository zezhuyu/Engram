import { Vault } from '/opt/engram/dist/packages/core/vault.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const [mode, root, stage] = process.argv.slice(2);
const scope = { type: 'global', area: 'wiki' };
const input = (title, body, idempotencyKey) => ({ scope, kind: 'note', title, body, idempotencyKey });

if (mode === 'prepare') {
  await fs.rm(root, { recursive: true, force: true });
  const vault = new Vault(root);
  await vault.init({ sqlite: false });
  const doc = await vault.put(input('acknowledged baseline', 'must survive every cut', 'baseline'));
  process.stdout.write(`ACK ${JSON.stringify({ id: doc.id, revisionId: doc.revisionId, title: doc.title })}\n`);
} else if (mode === 'cut') {
  const vault = new Vault(root, undefined, { fault(point) {
    if (point === stage) {
      process.stdout.write(`CUT ${point}\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  }});
  await vault.put(input('unacknowledged candidate', `cut at ${stage}`, `candidate:${stage}`));
  process.stdout.write('UNEXPECTED_ACK\n');
} else if (mode === 'recover') {
  const vault = new Vault(root);
  const first = await vault.recover();
  const before = await vault.verify();
  const docsBefore = await vault.listDocuments({ includeHistory: true });
  const second = await vault.recover();
  const after = await vault.verify();
  const docsAfter = await vault.listDocuments({ includeHistory: true });
  const journal = await fs.readFile(path.join(root, '.mdb/events/commits.jsonl'), 'utf8');
  const hash = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(journal).digest('hex'));
  const views = [];
  for (const doc of docsAfter) {
    const view = await fs.readFile(path.join(root, doc.path));
    const rev = await fs.readFile(path.join(root, `.mdb/objects/${doc.id}/revs/${doc.revisionId}.md`));
    views.push({ id: doc.id, viewMatchesRevision: view.equals(rev) });
  }
  const result = {
    committed: first.committed,
    recovered: first,
    secondRecovery: second,
    verifyBefore: before.ok,
    verifyAfter: after.ok,
    titles: docsAfter.map(d => d.title).sort(),
    documentsStable: JSON.stringify(docsBefore.map(d => [d.id,d.revisionId]).sort()) === JSON.stringify(docsAfter.map(d => [d.id,d.revisionId]).sort()),
    journalLines: journal.trim().split('\n').filter(Boolean).length,
    journalSha256: hash,
    views
  };
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
} else throw new Error(`Unknown mode: ${mode}`);
