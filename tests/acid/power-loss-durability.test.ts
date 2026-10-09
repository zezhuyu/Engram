import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../../packages/core/vault.js';
import { modules, runChild } from '../helpers/child.js';

const eio = () => Object.assign(new Error('injected fsync EIO'), { code: 'EIO' });

test('vault initialization durably publishes the root and journal directory parents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-init-fsync-'));
  const vaultRoot = path.join(root, 'new-vault');
  try {
    const failing = new Vault(vaultRoot, undefined, { fault: stage => { if (stage === 'fsync.directory.before') throw eio(); } });
    await assert.rejects(failing.init({ sqlite: false }), { code: 'EIO' });
    assert.equal(await fs.stat(path.join(vaultRoot, '.mdb/events/commits.jsonl')).then(() => true, () => false), false, 'init does not acknowledge an unsynced directory tree');
    const healthy = new Vault(vaultRoot); await healthy.init({ sqlite: false });
    assert.equal((await healthy.recover()).committed, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('file and revision-directory fsync failures before the journal never publish a commit', async t => {
  for (const stage of ['revision.fsync.before', 'revision.directory_fsync.before']) {
    await t.test(stage, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-fsync-precommit-'));
      try {
        const vault = new Vault(root); await vault.init({ sqlite: false });
        const failing = new Vault(root, undefined, { fault: current => { if (current === stage) throw eio(); } });
        await assert.rejects(failing.put({ scope: { type: 'global', area: 'wiki' }, kind: 'note', title: stage, body: 'uncommitted' }), { code: 'EIO' });
        assert.equal((await vault.events()).length, 0, 'journal remains the source of visibility');
        const recovery = await vault.recover(); assert.equal(recovery.committed, 0);
        assert.equal((await vault.listDocuments()).length, 0);
        assert.equal((await vault.verify()).ok, true);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
  }
});

test('journal fsync failure leaves an unacknowledged whole record in the permitted ambiguous class', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-fsync-journal-'));
  try {
    const vault = new Vault(root); await vault.init({ sqlite: false });
    const failing = new Vault(root, undefined, { fault: stage => { if (stage === 'journal.fsync.before') throw eio(); } });
    await assert.rejects(failing.put({ scope: { type: 'global', area: 'wiki' }, kind: 'note', title: 'ambiguous', body: 'complete newline terminated record' }), { code: 'EIO' });
    const events = await vault.events(); assert.equal(events.length, 1);
    assert.equal((await vault.get(events[0]!.objectId)).body, 'complete newline terminated record');
    assert.equal((await vault.recover()).committed, 1);
    assert.equal((await vault.verify()).ok, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('head or view fsync failures after the journal commit remain recoverable', async t => {
  for (const stage of ['fsync.file.before', 'fsync.directory.before']) {
    await t.test(stage, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-fsync-postcommit-'));
      try {
        const vault = new Vault(root); await vault.init({ sqlite: false });
        let committed = false;
        const failing = new Vault(root, undefined, { fault: current => { if (current === 'journal.after_fsync') committed = true; else if (committed && current === stage) throw eio(); } });
        await assert.rejects(failing.put({ scope: { type: 'global', area: 'wiki' }, kind: 'note', title: stage, body: 'committed before projection fsync failed' }), { code: 'EIO' });
        assert.equal((await vault.events()).length, 1, 'journal commit point already passed');
        const recovery = await vault.recover(); assert.equal(recovery.committed, 1);
        assert.equal((await vault.listDocuments())[0]!.body, 'committed before projection fsync failed');
        assert.equal((await vault.verify()).ok, true);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
  }
});

test('durable independent acknowledgment ledger agrees with recovered acknowledged transactions after process death', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-ack-ledger-'));
  const root = path.join(parent, 'vault'); const ledger = path.join(parent, 'ack-ledger.jsonl');
  try {
    const vault = new Vault(root); await vault.init({ sqlite: false });
    const code = `import {Vault} from ${JSON.stringify(modules.vault)};import {createHash} from 'node:crypto';import fs from 'node:fs/promises';
      const vault=new Vault(${JSON.stringify(root)});const d=await vault.put({scope:{type:'global',area:'wiki'},kind:'note',title:'acknowledged',body:'acknowledged body'});
      const file=await fs.open(${JSON.stringify(ledger)},'a',0o600);try{await file.writeFile(JSON.stringify({objectId:d.id,revisionId:d.revisionId,bodySha256:createHash('sha256').update(d.body).digest('hex')})+'\\n');await file.sync();}finally{await file.close();}
      const dir=await fs.open(${JSON.stringify(parent)},'r');try{await dir.sync();}finally{await dir.close();}process.kill(process.pid,'SIGKILL');`;
    const dead = await runChild(code); assert.equal(dead.signal, 'SIGKILL');
    const acknowledgments = (await fs.readFile(ledger, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { objectId: string; revisionId: string; bodySha256: string });
    assert.equal(acknowledgments.length, 1, 'ledger was fsynced before child termination');
    const recovered = new Vault(root); await recovered.recover();
    for (const ack of acknowledgments) {
      const document = await recovered.get(ack.objectId, ack.revisionId);
      assert.equal(createHash('sha256').update(document.body).digest('hex'), ack.bodySha256);
      const event = (await recovered.events()).find(item => item.objectId === ack.objectId && item.revisionId === ack.revisionId);
      assert.ok(event, 'every independently acknowledged revision is present in the recovered journal');
      const revision = await fs.readFile(path.join(root, `.mdb/objects/${ack.objectId}/revs/${ack.revisionId}.md`));
      assert.equal(createHash('sha256').update(revision).digest('hex'), event.revisionSha256);
    }
    assert.equal((await recovered.config()).sqlite.enabled, false);
    assert.equal((await recovered.verify()).ok, true);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
