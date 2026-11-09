import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { applySetting, previewSetting, readSettings } from '../../packages/dashboard/settings.js';
import { readAudit } from '../../packages/dashboard/audit.js';
import { appendAudit } from '../../packages/dashboard/audit.js';
import { disposableVault } from './helpers.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';

async function dashboardRequest(port: number, route: string, options: { method?: string; token?: string; cookie?: string; password?: string; csrf?: boolean; body?: unknown } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  return fetch(origin + route, { method: options.method ?? 'GET', headers: {
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}),
    ...(options.csrf ? { 'X-Engram-Dashboard': '1' } : {}), ...(options.password ? { 'X-Engram-Reauth-Password': options.password } : {}),
    ...(options.method && options.method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
  }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
}

async function loginSession(port: number, token: string) {
  const origin = `http://127.0.0.1:${port}`, password = 'correct horse battery staple';
  const setup = await fetch(origin + '/api/auth/setup', { method: 'POST', headers: { Origin: origin, 'X-Engram-Dashboard': '1', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password, confirm: password }) });
  assert.equal(setup.status, 200);
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'X-Engram-Dashboard': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  return { password, cookie: String(login.headers.get('set-cookie')).split(';')[0]! };
}

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

test('model key readiness reflects environment fallback without exposing its value', async t => {
  const v = await disposableVault(); t.after(v.cleanup);
  const previous = process.env.ENGRAM_TEST_KEY;
  process.env.ENGRAM_TEST_KEY = 'settings-secret-canary';
  try {
    await v.engram.vault.setConfig(config => { config.model.provider = 'openai-compatible'; config.model.apiKeyRef = 'missing-secret'; config.model.apiKeyEnv = 'ENGRAM_TEST_KEY'; });
    const state = await readSettings(v.engram);
    assert.equal(state.settings['model.apiKeySet'], true);
    assert.equal(JSON.stringify(state).includes('settings-secret-canary'), false);
  } finally { if (previous === undefined) delete process.env.ENGRAM_TEST_KEY; else process.env.ENGRAM_TEST_KEY = previous; }
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

test('models detection endpoint returns readiness metadata only and keeps API secrets private', async t => {
  const v = await disposableVault(), canary = 'sk-dashboard-detect-secret-canary';
  const previousKey = process.env.OPENAI_API_KEY, previousOverride = process.env.ENGRAM_MODEL_PROVIDER;
  process.env.OPENAI_API_KEY = canary; process.env.ENGRAM_MODEL_PROVIDER = 'ollama';
  const dashboard = await createDashboardServer({ engram: v.engram, token: 'd'.repeat(64), idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; if (previousOverride === undefined) delete process.env.ENGRAM_MODEL_PROVIDER; else process.env.ENGRAM_MODEL_PROVIDER = previousOverride; });
  const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/models/detect`, { headers: { Authorization: `Bearer ${dashboard.token}` } });
  assert.equal(response.status, 200);
  const body = await response.json() as { agents: Array<{ id: string; found: boolean; path?: string; version?: string }>; ollama: { reachable: boolean; models: string[] }; providers: string[]; overriddenByEnvironment: boolean };
  assert.deepEqual(body.agents.map(agent => agent.id), ['claude-cli', 'codex-cli']);
  for (const agent of body.agents) if (agent.found) { assert.ok(path.isAbsolute(agent.path!)); assert.equal(typeof agent.version, 'string'); }
  assert.equal(typeof body.ollama.reachable, 'boolean'); assert.ok(Array.isArray(body.ollama.models));
  assert.ok(body.providers.includes('openai-compatible')); assert.equal(body.overriddenByEnvironment, true);
  assert.equal(JSON.stringify(body).includes(canary), false);
});

test('provider model-list routes require a dashboard session, use server-held keys, and honor remote consent', async t => {
  const v = await disposableVault(), token = 'm'.repeat(64), key = 'model-list-key-never-return';
  let authorizationHeader = '';
  const modelServer = createServer((req, res) => { authorizationHeader = String(req.headers.authorization || ''); res.setHeader('content-type', 'application/json'); res.end(req.url === '/api/tags' ? JSON.stringify({ models: [{ name: 'llama3' }, { name: 'nomic-embed-text' }] }) : JSON.stringify({ data: [{ id: 'chat-model-a' }] })); });
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address(); assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  await v.engram.vault.setConfig(config => { config.model.provider = 'openai-compatible'; config.model.modelName = 'chat-model-a'; config.model.baseUrl = baseUrl; config.model.apiKeyEnv = 'ENGRAM_MODEL_LIST_KEY'; config.model.allowNetwork = true; config.model.allowPrivateContentToRemote = false; });
  process.env.ENGRAM_MODEL_LIST_KEY = key;
  const dashboard = await createDashboardServer({ engram: v.engram, token, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); await new Promise<void>(resolve => modelServer.close(() => resolve())); delete process.env.ENGRAM_MODEL_LIST_KEY; });
  const noSession = await dashboardRequest(dashboard.port, '/api/models/list?provider=openai-compatible', { token }); assert.equal(noSession.status, 401);
  const session = await loginSession(dashboard.port, token);
  const listed = await dashboardRequest(dashboard.port, '/api/models/list?provider=openai-compatible', { cookie: session.cookie, csrf: true });
  assert.equal(listed.status, 200); const result = await listed.json() as any; assert.equal(result.source, 'provider'); assert.equal(result.default, true); assert.deepEqual(result.models.map((item: any) => item.id), ['chat-model-a']); assert.equal(JSON.stringify(result).includes(key), false); assert.equal(authorizationHeader, `Bearer ${key}`);
  await v.engram.vault.setConfig(config => { config.model.baseUrl = 'https://models.example/v1'; config.model.allowNetwork = false; config.model.allowPrivateContentToRemote = false; });
  const denied = await dashboardRequest(dashboard.port, '/api/models/list?provider=openai-compatible&refresh=1', { cookie: session.cookie, csrf: true }); const deniedBody = await denied.json() as any;
  assert.equal(deniedBody.source, 'unavailable'); assert.match(deniedBody.reason, /consent/i);
  const claude = await dashboardRequest(dashboard.port, '/api/models/list?provider=claude-cli&refresh=1', { cookie: session.cookie, csrf: true }); assert.deepEqual((await claude.json() as any).models.map((item: any) => item.id), ['opus','sonnet','haiku','claude-fable-5-1','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5']);
  const codex = await dashboardRequest(dashboard.port, '/api/models/list?provider=codex-cli&refresh=1', { cookie: session.cookie, csrf: true }); assert.ok((await codex.json() as any).models.some((item: any) => item.id === 'gpt-6-luna'));
  await v.engram.vault.setConfig(config => { config.embedding = { provider: 'ollama', baseUrl, model: 'embed-old' }; });
  const embedding = await dashboardRequest(dashboard.port, '/api/embedding/models?provider=ollama&refresh=1', { cookie: session.cookie, csrf: true }); const embeddingList = await embedding.json() as any;
  assert.deepEqual(embeddingList.models.map((item: any) => item.id), ['nomic-embed-text','llama3']); assert.equal(embeddingList.models[0].embedding, true);
  const openAIEmbedding = await dashboardRequest(dashboard.port, '/api/embedding/models?provider=openai&refresh=1', { cookie: session.cookie, csrf: true }); const curatedEmbedding = await openAIEmbedding.json() as any;
  assert.equal(curatedEmbedding.source, 'curated'); assert.ok(curatedEmbedding.models.some((item: any) => item.id === 'text-embedding-3-small'));
});

test('model settings API switches Ollama and both detected CLI providers without provider-specific UI state', async t => {
  const v = await disposableVault(), token = 'e'.repeat(64), previous = process.env.ENGRAM_MODEL_PROVIDER;
  delete process.env.ENGRAM_MODEL_PROVIDER;
  await v.engram.vault.setConfig(config => { config.model.provider = null; config.model.modelName = 'initial'; config.model.baseUrl = 'http://127.0.0.1:11434/v1'; });
  const dashboard = await createDashboardServer({ engram: v.engram, token, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); if (previous === undefined) delete process.env.ENGRAM_MODEL_PROVIDER; else process.env.ENGRAM_MODEL_PROVIDER = previous; });
  async function change(key: string, value: unknown) {
    const current = await (await dashboardRequest(dashboard.port, '/api/settings', { token })).json() as any;
    const preview = await (await dashboardRequest(dashboard.port, '/api/settings/preview', { method: 'POST', token, body: { key, value, etag: current.etag } })).json() as any;
    assert.equal(preview.conflict, undefined);
    const response = await dashboardRequest(dashboard.port, '/api/settings/apply', { method: 'POST', token, body: { key, value, etag: current.etag, ...(preview.confirm ? { confirm: preview.confirm } : {}) } });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  }
  for (const provider of ['ollama', 'claude-cli', 'codex-cli', 'ollama']) {
    await change('model.provider', provider);
    assert.equal((await v.engram.config()).model.modelName, undefined, 'switching providers clears the prior provider model');
    await change('model.modelName', 'synthetic-model');
    assert.equal((await v.engram.config()).model.provider, provider);
    assert.equal((await v.engram.config()).model.modelName, 'synthetic-model');
  }
});

test('model provider preview and apply accept an explicitly chosen model in the same request', async t => {
  const v = await disposableVault(); t.after(v.cleanup);
  await v.engram.vault.setConfig(config => { config.model.provider = 'ollama'; config.model.modelName = 'ollama-only'; });
  const before = await readSettings(v.engram);
  const preview = await previewSetting(v.engram, { key: 'model.provider', value: 'codex-cli', modelName: 'gpt-6-luna', etag: before.etag });
  assert.equal('conflict' in preview, false);
  assert.match((preview as any).diff, /gpt-6-luna/);
  await applySetting(v.engram, { key: 'model.provider', value: 'codex-cli', modelName: 'gpt-6-luna', etag: before.etag, confirm: (preview as any).confirm });
  const model = (await v.engram.config()).model;
  assert.equal(model.provider, 'codex-cli'); assert.equal(model.modelName, 'gpt-6-luna');
});

test('embedding provider changes clear the previous provider model through preview and apply', async t => {
  const v = await disposableVault(); t.after(v.cleanup);
  await v.engram.vault.setConfig(config => { config.embedding = { provider: 'ollama', model: 'nomic-embed-text' }; });
  const before = await readSettings(v.engram), preview = await previewSetting(v.engram, { key: 'embedding.provider', value: 'openai-compatible', etag: before.etag });
  assert.equal('conflict' in preview, false);
  const applied = await applySetting(v.engram, { key: 'embedding.provider', value: 'openai-compatible', etag: before.etag, confirm: (preview as any).confirm });
  assert.equal((await v.engram.config()).embedding?.model, undefined); assert.equal((applied as any).settings['embedding.provider'], 'openai-compatible');
});

test('model base URL rejects non-http schemes, credentials, query and fragment', async t => {
  const v = await disposableVault(); t.after(v.cleanup); const etag = (await readSettings(v.engram)).etag;
  for (const value of ['file:///tmp/model', 'ftp://model.example/v1', 'https://user:pass@model.example/v1', 'https://model.example/v1?token=secret', 'https://model.example/v1#fragment']) {
    await assert.rejects(() => previewSetting(v.engram, { key: 'model.baseUrl', value, etag }));
  }
  const clearBase = await previewSetting(v.engram, { key: 'model.baseUrl', value: '', etag });
  assert.equal('conflict' in clearBase, false); if (!('conflict' in clearBase)) assert.equal(clearBase.value, null, 'optional provider URLs can be cleared');
  await v.engram.vault.setConfig(config => { config.model.provider = 'openai-compatible'; config.model.modelName = 'missing-url'; config.model.baseUrl = undefined; });
  const missingUrlState = await readSettings(v.engram);
  await assert.rejects(() => previewSetting(v.engram, { key: 'model.provider', value: 'openai-compatible', etag: missingUrlState.etag }), /requires model.baseUrl/);
});

test('remote model selection uses typed consent for both gates; loopback selection does not', async t => {
  const v = await disposableVault(); t.after(v.cleanup);
  await v.engram.vault.setConfig(config => { config.model.provider = null; config.model.modelName = 'synthetic'; config.model.baseUrl = 'https://models.example/v1'; config.model.allowNetwork = false; config.model.allowPrivateContentToRemote = false; });
  let state = await readSettings(v.engram);
  const remote = await previewSetting(v.engram, { key: 'model.provider', value: 'openai-compatible', etag: state.etag });
  assert.equal('confirm' in remote && remote.confirm, 'allow remote model content');
  await assert.rejects(() => applySetting(v.engram, { key: 'model.provider', value: 'openai-compatible', etag: state.etag }), /Typed confirmation/);
  await applySetting(v.engram, { key: 'model.provider', value: 'openai-compatible', etag: state.etag, confirm: 'allow remote model content' });
  let model = (await v.engram.config()).model;
  assert.equal(model.allowNetwork, true); assert.equal(model.allowPrivateContentToRemote, true);
  state = await readSettings(v.engram);
  await applySetting(v.engram, { key: 'model.allowNetwork', value: false, etag: state.etag });
  state = await readSettings(v.engram);
  await applySetting(v.engram, { key: 'model.allowPrivateContentToRemote', value: false, etag: state.etag });
  model = (await v.engram.config()).model; assert.equal(model.allowNetwork, false); assert.equal(model.allowPrivateContentToRemote, false);
  state = await readSettings(v.engram);
  await applySetting(v.engram, { key: 'model.baseUrl', value: 'http://127.0.0.1:11434/v1', etag: state.etag });
  state = await readSettings(v.engram);
  const local = await previewSetting(v.engram, { key: 'model.provider', value: 'ollama', etag: state.etag });
  assert.equal('confirm' in local, false);
  await applySetting(v.engram, { key: 'model.provider', value: 'ollama', etag: state.etag });
  model = (await v.engram.config()).model; assert.equal(model.allowNetwork, false); assert.equal(model.allowPrivateContentToRemote, false);
  state = await readSettings(v.engram);
  await assert.rejects(() => applySetting(v.engram, { key: 'model.allowNetwork', value: true, etag: state.etag }), /typed provider confirmation/);
});

test('model secret endpoints require session CSRF and password reauth, use 0600 files, honor etags, and never echo secrets', async t => {
  const v = await disposableVault(), token = 'f'.repeat(64), prior = process.env.XDG_CONFIG_HOME, configHome = path.join(v.root, 'private-config'), canary = 'model-key-never-return-this';
  const logs: string[] = [], consoleFns = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = console.info = console.warn = console.error = (...items: unknown[]) => { logs.push(items.map(String).join(' ')); };
  process.env.XDG_CONFIG_HOME = configHome;
  const dashboard = await createDashboardServer({ engram: v.engram, token, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); if (prior === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prior; console.log = consoleFns.log; console.info = consoleFns.info; console.warn = consoleFns.warn; console.error = consoleFns.error; });
  const session = await loginSession(dashboard.port, token), current = await (await dashboardRequest(dashboard.port, '/api/settings', { token })).json() as any;
  const pathName = '/api/settings/model-secret';
  assert.equal((await dashboardRequest(dashboard.port, pathName, { method: 'PUT', token, body: { value: canary, etag: current.etag } })).status, 401, 'bearer requests are not a dashboard session');
  assert.equal((await dashboardRequest(dashboard.port, pathName, { method: 'PUT', cookie: session.cookie, body: { value: canary, etag: current.etag } })).status, 401, 'session writes require CSRF marker');
  const noReauth = await dashboardRequest(dashboard.port, pathName, { method: 'PUT', cookie: session.cookie, csrf: true, body: { value: canary, etag: current.etag } });
  assert.equal(noReauth.status, 401); assert.equal((await noReauth.json() as any).error.code, 'REAUTH_REQUIRED');
  const wrongPassword = await dashboardRequest(dashboard.port, pathName, { method: 'PUT', cookie: session.cookie, csrf: true, password: 'wrong password', body: { value: canary, etag: current.etag } });
  assert.equal(wrongPassword.status, 401);
  const conflict = await dashboardRequest(dashboard.port, pathName, { method: 'PUT', cookie: session.cookie, csrf: true, password: session.password, body: { value: canary, etag: 'stale-etag' } });
  assert.equal(conflict.status, 409);
  const response = await dashboardRequest(dashboard.port, pathName, { method: 'PUT', cookie: session.cookie, csrf: true, password: session.password, body: { value: canary, etag: current.etag } });
  assert.equal(response.status, 200); const settings = await response.json() as any;
  assert.equal(settings.settings['model.apiKeySet'], true); assert.equal(settings.settings['model.apiKeySource'], 'secret');
  assert.equal(JSON.stringify(settings).includes(canary), false);
  const secretFile = path.join(configHome, 'engram', 'secrets', 'model-provider');
  assert.equal((await stat(secretFile)).mode & 0o777, 0o600); assert.equal((await stat(path.dirname(secretFile))).mode & 0o777, 0o700); assert.equal(await readFile(secretFile, 'utf8'), canary);
  assert.equal(JSON.stringify(await v.engram.config()).includes(canary), false);
  const audit = await readAudit(v.root); assert.equal(JSON.stringify(audit).includes(canary), false); assert.ok(audit.some(entry => entry.key === 'model.secret' && JSON.stringify(entry.newValue).includes('model.apiKeyRef')));
  const replaced = await dashboardRequest(dashboard.port, pathName, { method: 'PUT', cookie: session.cookie, csrf: true, password: session.password, body: { value: canary + '-replacement', etag: settings.etag } });
  assert.equal(replaced.status, 200); const replacedSettings = await replaced.json() as any;
  assert.notEqual(replacedSettings.etag, settings.etag, 'secret replacement advances the settings etag');
  const staleReplace = await dashboardRequest(dashboard.port, pathName, { method: 'PUT', cookie: session.cookie, csrf: true, password: session.password, body: { value: canary, etag: settings.etag } });
  assert.equal(staleReplace.status, 409);
  const deleted = await dashboardRequest(dashboard.port, pathName, { method: 'DELETE', cookie: session.cookie, csrf: true, password: session.password, body: { etag: replacedSettings.etag } });
  assert.equal(deleted.status, 200); const after = await deleted.json() as any; assert.equal(after.settings['model.apiKeySet'], false); assert.equal(after.settings['model.apiKeySource'], 'none');
  await assert.rejects(() => stat(secretFile), { code: 'ENOENT' }); assert.equal(JSON.stringify(after).includes(canary), false); assert.equal(logs.some(line => line.includes(canary)), false);
});

test('built-in embedding preview is read-only and activation before verified download preserves settings', async t => {
  const { root, engram, cleanup } = await disposableVault(); t.after(cleanup);
  const dashboard = await createDashboardServer({ engram, token: 'd'.repeat(64), failedTokenLimit: 100, rateLimit: 100 }); t.after(() => dashboard.close());
  const preview = await dashboardRequest(dashboard.port, '/api/embedding/builtin', { token: dashboard.token });
  assert.equal(preview.status, 200); const payload = await preview.json() as any;
  assert.equal(payload.preview.id, 'bge-m3'); assert.equal(payload.status.state, 'not_installed');
  const before = await engram.config();
  const session = await loginSession(dashboard.port, dashboard.token);
  const activation = await dashboardRequest(dashboard.port, '/api/embedding/builtin/activate', { method: 'POST', cookie: session.cookie, csrf: true, password: session.password, body: {} });
  assert.equal(activation.status, 409);
  const after = await engram.config(); assert.deepEqual(after.embedding, before.embedding); assert.equal(after.sqlite.enabled, before.sqlite.enabled);
  assert.equal((await dashboardRequest(dashboard.port, '/api/embedding/builtin/progress', { token: dashboard.token })).status, 200);
  assert.equal(root.length > 0, true);
});

test('embedding secret endpoint stores only the independent embedding key and honors session re-authentication', async t => {
  const v = await disposableVault(), token = 'e'.repeat(64), prior = process.env.XDG_CONFIG_HOME, configHome = path.join(v.root, 'private-embedding-config'), key = 'embedding-key-canary';
  process.env.XDG_CONFIG_HOME = configHome;
  const dashboard = await createDashboardServer({ engram: v.engram, token, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); if (prior === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prior; });
  const session = await loginSession(dashboard.port, token), current = await (await dashboardRequest(dashboard.port, '/api/settings', { token })).json() as any;
  const endpoint = '/api/settings/embedding-secret';
  const saved = await dashboardRequest(dashboard.port, endpoint, { method: 'PUT', cookie: session.cookie, csrf: true, password: session.password, body: { value: key, etag: current.etag } });
  assert.equal(saved.status, 200); const response = await saved.json() as any;
  assert.equal(response.settings['embedding.apiKeySet'], true); assert.equal(response.settings['embedding.apiKeySource'], 'secret');
  assert.equal(JSON.stringify(response).includes(key), false); assert.equal(JSON.stringify(await v.engram.config()).includes(key), false);
  assert.equal((await stat(path.join(configHome, 'engram/secrets/embedding-provider'))).mode & 0o777, 0o600);
  const removed = await dashboardRequest(dashboard.port, endpoint, { method: 'DELETE', cookie: session.cookie, csrf: true, password: session.password, body: { etag: response.etag } });
  assert.equal(removed.status, 200); assert.equal((await removed.json() as any).settings['embedding.apiKeySet'], false);
});
