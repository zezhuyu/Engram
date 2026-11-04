import test from 'node:test';
import assert from 'node:assert/strict';
import { applySetting, previewSetting, readSettings } from '../../packages/dashboard/settings.js';
import { readAudit } from '../../packages/dashboard/audit.js';
import { appendAudit } from '../../packages/dashboard/audit.js';
import { disposableVault } from './helpers.js';

test('settings are allowlisted, etag guarded, confirmed and audited', async t => {
  const v = await disposableVault(); t.after(v.cleanup);
  await v.engram.vault.setConfig(config => { config.model.provider = 'openai-compatible'; config.model.modelName = 'model-test'; config.model.baseUrl = 'https://example.test/v1'; config.model.allowNetwork = true; });
  const before = await readSettings(v.engram);
  const allowed: Array<[string, unknown]> = [
    ['scheduler.enabled', true], ['scheduler.paused', false], ['scheduler.mode', 'fixed'], ['scheduler.timezone', 'UTC'],
    ['scheduler.targetLocalTime', '04:30'], ['scheduler.quietStart', '00:00'], ['scheduler.quietEnd', '07:00'], ['scheduler.micro.enabled', true],
    ['dream.enabled', true], ['dream.eventDriven', false], ['dream.autoAccept', true], ['adaptive.autoAccept', 'none'],
    ['adaptive.workspaces.include', null], ['adaptive.workspaces.exclude', []], ['model.provider', 'none'], ['model.modelName', 'model-test'],
    ['model.baseUrl', 'https://example.test/v1'], ['model.apiKeyEnv', 'ENGRAM_TEST_KEY'], ['model.allowNetwork', false],
    ['embedding.provider', 'ollama'], ['embedding.model', 'embed-test'], ['embedding.allowNetwork', false],
  ];
  for (const [key, value] of allowed) {
    const result = await previewSetting(v.engram, { key, value, etag: before.etag });
    assert.equal('conflict' in result, false, `${key} preview should accept valid value`);
  }
  const preview = await previewSetting(v.engram, { key: 'scheduler.enabled', value: true, etag: before.etag });
  assert.equal('conflict' in preview, false);
  if ('conflict' in preview) return;
  assert.equal(preview.risk, 'normal');
  const applied = await applySetting(v.engram, { key: 'scheduler.enabled', value: true, etag: before.etag });
  assert.equal((await readSettings(v.engram)).settings['scheduler.enabled'], true);
  assert.ok(applied.etag);
  assert.deepEqual(await applySetting(v.engram, { key: 'scheduler.paused', value: true, etag: before.etag }), { conflict: true, etag: applied.etag });
  for (const key of ['acl.grants', 'credentials.token', 'trust.project', 'env.value', 'bind.host', 'model.apiKey']) await assert.rejects(() => previewSetting(v.engram, { key, value: 'x', etag: applied.etag }));
  const invalid: Array<[string, unknown]> = [
    ['scheduler.enabled', 'yes'], ['scheduler.paused', 1], ['scheduler.mode', 'unsafe'], ['scheduler.timezone', 'not-a-time-zone'],
    ['scheduler.targetLocalTime', '99:99'], ['scheduler.quietStart', '24:00'], ['scheduler.quietEnd', 'tomorrow'], ['scheduler.micro.enabled', null],
    ['dream.enabled', 'true'], ['dream.eventDriven', 0], ['dream.autoAccept', 'yes'], ['adaptive.autoAccept', 'all'],
    ['adaptive.workspaces.include', ['../private']], ['adaptive.workspaces.exclude', 'all'], ['model.provider', 'arbitrary'],
    ['model.modelName', 'sk-live-secret-value'], ['model.baseUrl', 'https://example.test/v1?key=secret'], ['model.apiKeyEnv', 'sk-live-secret-value'],
    ['model.allowNetwork', 'true'], ['embedding.provider', 'arbitrary'], ['embedding.model', 'sk-live-secret-value'], ['embedding.allowNetwork', 1],
  ];
  for (const [key, value] of invalid) await assert.rejects(() => previewSetting(v.engram, { key, value, etag: applied.etag }), key);
  const sensitive = await previewSetting(v.engram, { key: 'adaptive.autoAccept', value: 'low-risk', etag: applied.etag });
  assert.equal('conflict' in sensitive, false);
  if ('conflict' in sensitive) return;
  assert.equal(sensitive.confirm, 'accept semantic writes');
  await assert.rejects(() => applySetting(v.engram, { key: 'adaptive.autoAccept', value: 'low-risk', etag: applied.etag }));
  await applySetting(v.engram, { key: 'adaptive.autoAccept', value: 'low-risk', etag: applied.etag, confirm: 'accept semantic writes' });
  process.env.ENGRAM_MODEL_PROVIDER = 'ollama';
  try { const lockedEtag = (await readSettings(v.engram)).etag; await assert.rejects(() => previewSetting(v.engram, { key: 'model.provider', value: 'openai', etag: lockedEtag }), /locked/); }
  finally { delete process.env.ENGRAM_MODEL_PROVIDER; }
  const audit = await readAudit(v.root);
  assert.equal(audit.length, 4); assert.equal(audit[0]?.key, 'scheduler.enabled');
  assert.deepEqual(audit.slice(0, 2).map(record => record.result), ['attempt', 'applied']);
  assert.equal((await v.engram.config()).schemaVersion, 1);
});

test('settings refuse mutation when the pre-change audit append fails', async t => {
  const v = await disposableVault(); t.after(v.cleanup);
  const before = await readSettings(v.engram), original = before.settings['scheduler.enabled'];
  let appendCalls = 0;
  await assert.rejects(() => applySetting(v.engram, { key: 'scheduler.enabled', value: !original, etag: before.etag }, async () => {
    appendCalls++;
    throw new Error('audit storage unavailable');
  }), /Could not record the setting attempt/);
  assert.equal(appendCalls, 1);
  assert.equal((await readSettings(v.engram)).settings['scheduler.enabled'], original, 'setting remains unchanged when attempt audit cannot be made durable');
  assert.equal((await readAudit(v.root)).length, 0);
});

test('audit records redact secrets from both old and proposed values', async t => {
  const v = await disposableVault(); t.after(v.cleanup);
  await appendAudit(v.root, { at: new Date().toISOString(), key: 'model.baseUrl', oldValue: 'Bearer sk-old-secret-abcdefgh', newValue: 'https://host.test/?api_key=sk-new-secret-abcdefgh', result: 'attempt' });
  const serialized = JSON.stringify(await readAudit(v.root));
  assert.doesNotMatch(serialized, /sk-old-secret|sk-new-secret/);
  assert.match(serialized, /redacted/i);
});

test('a rejected setting setter records the attempt and failed outcome', async t => {
  const v = await disposableVault(); t.after(v.cleanup);
  const original = v.engram.adaptive.configure.bind(v.engram.adaptive);
  (v.engram.adaptive as any).configure = async () => { throw new Error('setter failed'); };
  const before = await readSettings(v.engram);
  await assert.rejects(() => applySetting(v.engram, { key: 'scheduler.enabled', value: !before.settings['scheduler.enabled'], etag: before.etag }), /setter failed/);
  (v.engram.adaptive as any).configure = original;
  assert.deepEqual((await readAudit(v.root)).map(record => record.result), ['attempt', 'failed']);
});
