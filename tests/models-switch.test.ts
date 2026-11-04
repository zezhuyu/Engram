import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Engram, OWNER, MDBError, applyModelSet, showModel, setModel, testModel, createProviderFromConfig } from '../packages/sdk/index.js';

const fresh = async (t: TestContext) => { const root = await mkdtemp(path.join(os.tmpdir(), 'mdb-switch-')); t.after(() => rm(root, { recursive: true, force: true })); const client = new Engram(root, OWNER); await client.init({ sqlite: false }); return client; };
const base = { provider: null, allowNetwork: false } as const;

test('one switch: local agent <-> OpenAI-compatible API round-trips and drops the other kind\'s fields', async () => {
  const api = applyModelSet({ ...base }, { api: 'http://127.0.0.1:11434/v1', modelName: 'gpt-oss:20b', maxOutputTokens: 8000, apiKeyEnv: 'MY_KEY' });
  assert.equal(api.provider, 'ollama'); assert.equal(api.baseUrl, 'http://127.0.0.1:11434/v1'); assert.equal(api.apiKeyEnv, 'MY_KEY');
  const cli = applyModelSet(api, { localAgent: 'claude' });
  assert.equal(cli.provider, 'claude-cli');
  for (const key of ['baseUrl', 'apiKeyEnv', 'maxOutputTokens', 'modelName'] as const) assert.equal(cli[key], undefined, `${key} must not leak into a local-agent config`);
  const back = applyModelSet({ ...cli, command: '/usr/bin/claude' }, { api: 'http://127.0.0.1:1234/v1', modelName: 'm' });
  assert.equal(back.provider, 'openai-compatible'); assert.equal(back.command, undefined);
  assert.equal(applyModelSet(back, { provider: 'none' }).provider, null);
});

test('invalid combinations and key values are refused', async t => {
  assert.throws(() => applyModelSet({ ...base }, { provider: 'bogus' }), /Unknown provider/);
  assert.throws(() => applyModelSet({ ...base }, { localAgent: 'claude', api: 'http://x/v1' }), /mutually exclusive/);
  assert.throws(() => applyModelSet({ ...base }, { apiKeyEnv: 'sk-live-abcdef123456' }), /NAME/);
  assert.throws(() => applyModelSet({ ...base }, { localAgent: 'codex', baseUrl: 'http://127.0.0.1:1/v1' }), /OpenAI-compatible API/);
  const client = await fresh(t); const before = (await client.vault.config()).model;
  await assert.rejects(setModel(client.vault, { api: 'https://llm.example.com/v1', modelName: 'm' }, {}), /allowNetwork/);
  await assert.rejects(setModel(client.vault, { api: 'http://127.0.0.1:9/v1' }, {}), /modelName/);
  await assert.rejects(setModel(client.vault, { provider: 'openai', modelName: 'm', allowNetwork: true }, {}), /OPENAI_API_KEY/);
  assert.deepEqual((await client.vault.config()).model, before, 'a refused set must not change the vault');
});

test('show never prints key values and reports the environment override and the private-content gate', async t => {
  const client = await fresh(t); const env = { SECRET_VAR: 'sk-super-secret-value-123456' };
  await setModel(client.vault, { provider: 'openai', modelName: 'gpt', apiKeyEnv: 'SECRET_VAR', allowNetwork: true }, env);
  const shown = showModel(await client.vault.config(), env); const json = JSON.stringify(shown);
  assert.ok(!json.includes('sk-super-secret'), 'key value leaked'); assert.equal(shown.apiKeySet, true); assert.equal(shown.kind, 'OpenAI-compatible API'); assert.equal(shown.locality, 'remote');
  assert.match(String(shown.privateContentGate), /NOT sent/);
  const open = showModel({ ...(await client.vault.config()), model: { ...(await client.vault.config()).model, allowPrivateContentToRemote: true } }, env);
  assert.match(String(open.privateContentGate), /open/);
  const overridden = showModel(await client.vault.config(), { ...env, ENGRAM_MODEL_PROVIDER: 'claude-cli' });
  assert.equal(overridden.overriddenByEnvironment, true); assert.equal(overridden.kind, 'local agent CLI');
  const lowReasoningBudget = showModel({ ...(await client.vault.config()), model: { ...(await client.vault.config()).model, modelName: 'gpt-oss:latest', maxOutputTokens: 2000 } }, env);
  assert.match(JSON.stringify(lowReasoningBudget.warnings), /maxOutputTokens >= 4000/);
  for (const modelName of ['o1', 'o3-mini', 'o4', 'deepseek-r1', 'qwq', 'qwen3-thinking', 'org/model-thinking']) {
    const reasoning = showModel({ ...(await client.vault.config()), model: { ...(await client.vault.config()).model, modelName, maxOutputTokens: 2000 } }, env);
    assert.match(JSON.stringify(reasoning.warnings), /maxOutputTokens >= 4000/, `${modelName} should trigger the reasoning budget warning`);
  }
});

test('only the owner can change the switch', async t => {
  const client = await fresh(t);
  const other = new Engram(client.vault.root, { actorId: 'agent-x', permissions: [] });
  await assert.rejects(setModel(other.vault, { provider: 'none' }, {}), (e: unknown) => e instanceof MDBError);
});

test('model test sends no vault content and reports ok / failure', async t => {
  const client = await fresh(t); const seen: string[] = [];
  const server = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => { seen.push(Buffer.concat(chunks).toString()); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ kind: 'note', title: 'ok', body: 'ok', evidence: [{ uri: 'mdb://wiki/objects/obj_model_test', revisionId: 'rev_model_test' }] }) }, finish_reason: 'stop' }] })); }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  await client.put({ scope: { type: 'global', area: 'wiki' }, kind: 'note', title: 'PRIVATE-TITLE-77', body: 'PRIVATE-BODY-77' });
  await setModel(client.vault, { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, modelName: 'm' }, {});
  const config = await client.vault.config(); const result = await testModel(createProviderFromConfig(config.model, {}), config, {});
  assert.equal(result.ok, true); assert.equal(result.sentVaultContent, false);
  const reasoningConfig = { ...config, model: { ...config.model, modelName: 'deepseek-r1', maxOutputTokens: 1000 } };
  const reasoningResult = await testModel(createProviderFromConfig(reasoningConfig.model, {}), reasoningConfig, {});
  assert.match(JSON.stringify(reasoningResult.warnings), /maxOutputTokens >= 4000/);
  assert.ok(seen.length >= 1 && seen.every(body => !body.includes('PRIVATE-')), 'vault content reached the provider');
  assert.equal((await testModel(undefined, config, {}).catch(e => ({ ok: false, error: String(e) }))).ok, false);
});

test('model test forwards its AbortSignal to the provider call', async t => {
  const client = await fresh(t), config = await client.vault.config(), controller = new AbortController();
  let received: AbortSignal | undefined;
  const provider = { id: 'signal-test', generate: async (_input: unknown, options?: { signal?: AbortSignal }) => {
    received = options?.signal;
    return { kind: 'note', title: 'ok', body: 'ok', evidence: [] } as never;
  } };
  const result = await testModel(provider, config, {}, controller.signal);
  assert.equal(result.ok, true);
  assert.equal(received, controller.signal);
});
