import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { recordCase } from '../helpers/report.js';
import { ownChildProcess, stopOwnedChildProcess } from '../helpers/owned-process.js';
import type { Vault } from '../../packages/core/vault.js';
import type { Scope } from '../../packages/core/types.js';

const MCP = resolve('bin/mdb-mcp.js');
const wiki: Scope = { type: 'global', area: 'wiki' };
type Json = Record<string, any>;

const REQUEST_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 30_000;

function requestSignal(): AbortSignal { return AbortSignal.timeout(REQUEST_TIMEOUT_MS); }

async function startServer(root: string, t: test.TestContext): Promise<{ endpoint: string; stop(): Promise<void> }> {
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const stop = () => stopOwnedChildProcess(child);
  // Register immediately so startup errors and timeouts still reap the child.
  ownChildProcess(t, child);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error); else resolveEndpoint(value!);
    };
    const onData = (chunk: string | Buffer) => {
      stderr += String(chunk);
      const match = /MCP HTTP listening at (http:\/\/\S+)/.exec(stderr);
      if (match) finish(undefined, match[1]!);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`MCP exited ${code ?? signal}: ${stderr}`));
    const timer = setTimeout(() => finish(new Error(`MCP startup timeout: ${stderr}`)), 10_000);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
  return { endpoint, stop };
}

async function connect(endpoint: string, token: string): Promise<{ session: string; call(name: string, args?: Json): Promise<Json>; raw(body: string): Promise<Response> }> {
  let id = 1;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close' };
  const init = await fetch(endpoint, { method: 'POST', headers, signal: requestSignal(), body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'wiki-deployment-probe', version: '1' } } }) });
  assert.equal(init.status, 200);
  await init.arrayBuffer();
  const session = init.headers.get('mcp-session-id');
  assert.ok(session, 'initialize returns an HTTP MCP session');
  return {
    session,
    raw: body => fetch(endpoint, { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': session }, signal: requestSignal(), body }),
    call: async (name, args = {}) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': session }, signal: requestSignal(), body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }) });
      assert.equal(response.status, 200, `${name} HTTP status`);
      return (await response.json() as Json).result as Json;
    }
  };
}

function cli(root: string, args: string[], expect = 0): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['bin/mdb.js', ...args, '--root', root, '--json'], { cwd: process.cwd(), encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, expect, `mdb ${args.join(' ')} stderr=${result.stderr}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

test('HTTP MCP and built CLI exercise wiki CRUD, skills, ACLs, bounds, concurrency and remote routing', async t => {
  const { root, vault } = await disposableVault(t);
  const originalConfig = await vault.config();
  await vault.setConfig(config => { config.model.provider = null; });
  const agent = await createHttpCredential(vault, 'wiki-http-writer', ['global:wiki:read', 'global:wiki:write']);
  const reader = await createHttpCredential(vault, 'wiki-http-reader', ['global:wiki:read']);
  const denied = await createHttpCredential(vault, 'wiki-http-denied', ['global:shared:read']);
  const source = await vault.put({ scope: wiki, kind: 'note', title: 'HTTP evidence', body: 'A calibrated observatory publishes a survey every autumn.' });
  const retire = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'HTTP retire', body: 'An obsolete page [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }] });
  const restorePage = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'HTTP restore', body: 'A restorable page [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }] });
  const restoreHead = await vault.delete(restorePage.id, restorePage.revisionId);
  const rename = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'HTTP rename', body: 'Rename target [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }] });
  const mergeTarget = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'HTTP merge target', body: 'Target text [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }] });
  const mergeSource = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'HTTP merge source', body: 'Source text.' });
  const empty = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'HTTP empty', body: '' });
  const beforeDiff = rename.revisionId;
  const afterDiff = await vault.patch({ objectId: rename.id, expectedRevisionId: rename.revisionId, body: 'Rename target with a revised body [1].' });

  const firstServer = await startServer(root, t);
  const client = await connect(firstServer.endpoint, agent.token);
  const listed = await fetch(firstServer.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': client.session, Connection: 'close' }, signal: requestSignal(), body: JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'tools/list', params: {} }) });
  const tools = ((await listed.json() as Json).result.tools as Array<{ name: string }>).map(tool => tool.name);
  for (const name of ['mdb_wiki_lint', 'mdb_wiki_propose_change', 'mdb_wiki_proposals', 'mdb_diff', 'mdb_skill_run']) assert.ok(tools.includes(name), `${name} is listed`);
  assert.equal(tools.some(name => /approve|wiki_delete|mdb_delete/u.test(name)), false, 'MCP offers no proposal approval or direct delete tool');

  const lint = (await client.call('mdb_wiki_lint', { scopes: [wiki], limit: 50 })).structuredContent.result as Json;
  const emptyIssue = lint.issues.find((issue: Json) => issue.objectId === empty.id && issue.issue === 'empty_page');
  assert.ok(emptyIssue, 'lint exposes a current empty-page finding');
  const proposals = await Promise.all([
    client.call('mdb_wiki_propose_change', { action: 'retire', targetPageId: retire.id, targetRevisionId: retire.revisionId, reason: 'HTTP reviewed retire.' }),
    client.call('mdb_wiki_propose_change', { action: 'restore', targetPageId: restorePage.id, targetRevisionId: restoreHead.revisionId, restoreRevisionId: restorePage.revisionId, reason: 'HTTP reviewed restore.' }),
    client.call('mdb_wiki_propose_change', { action: 'rename', targetPageId: rename.id, targetRevisionId: afterDiff.revisionId, newTitle: 'HTTP renamed page', reason: 'HTTP reviewed rename.' }),
    client.call('mdb_wiki_propose_change', { action: 'merge', targetPageId: mergeTarget.id, targetRevisionId: mergeTarget.revisionId, mergeSources: [{ pageId: mergeSource.id, revisionId: mergeSource.revisionId }], title: 'HTTP merged page', body: 'A calibrated observatory publishes a survey every autumn [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId, span: 'publishes a survey every autumn' }], reason: 'HTTP reviewed merge.' })
  ]);
  assert.ok(proposals.every(proposal => proposal.structuredContent.result.status === 'pending'));
  assert.equal(((await client.call('mdb_wiki_proposals', {})).structuredContent.result as unknown[]).length, 4);
  const diff = await client.call('mdb_diff', { objectId: rename.id, fromRevisionId: beforeDiff, toRevisionId: afterDiff.revisionId });
  assert.equal(diff.isError, undefined);

  const skills = [
    ['wiki-page-compiler', { scope: wiki, objectIds: [source.id] }],
    ['wiki-update', { scope: wiki, objectIds: [rename.id], targetPageId: rename.id }],
    ['wiki-maintenance', { scope: wiki, objectIds: [empty.id], targetPageId: empty.id, issues: [emptyIssue] }],
    ['cross-linker', { scope: wiki, objectIds: [rename.id], targetPageId: rename.id }],
    ['tag-taxonomy', { scope: wiki, objectIds: [rename.id], targetPageId: rename.id }]
  ] as const;
  for (const [name, input] of skills) {
    const result = await client.call('mdb_skill_run', { name, input });
    assert.equal(result.structuredContent.result.semanticExecutionAvailable, false, `${name} reports no provider`);
  }

  // Eight independently initialized sessions concurrently use different wiki tools.
  const clients = [];
  for (let index = 0; index < 8; index++) clients.push(await connect(firstServer.endpoint, agent.token));
  const concurrent = await Promise.all(clients.map((session, index) => session.call(
    ['mdb_wiki_lint', 'mdb_wiki_proposals', 'mdb_diff', 'mdb_skills_list', 'mdb_skill_run', 'mdb_wiki_lint', 'mdb_wiki_proposals', 'mdb_skill_run'][index]!,
    index === 2 ? { objectId: rename.id, fromRevisionId: beforeDiff, toRevisionId: afterDiff.revisionId }
      : index === 4 || index === 7 ? { name: 'wiki-page-compiler', input: { scope: wiki, objectIds: [source.id] } }
        : index === 0 || index === 5 ? { scopes: [wiki], limit: 20 } : {}
  ).catch(error => { throw new Error(`concurrent MCP client ${index} failed: ${String(error)}`); })));
  assert.equal(concurrent.length, 8);

  const deniedClient = await connect(firstServer.endpoint, denied.token);
  const hidden = await deniedClient.call('mdb_get', { objectId: retire.id });
  const absent = await deniedClient.call('mdb_get', { objectId: 'obj_not_present' });
  assert.equal(JSON.stringify(hidden.content), JSON.stringify(absent.content), 'denied and missing reads use the same generic error');
  const readOnly = await connect(firstServer.endpoint, reader.token);
  const forbiddenWrite = await readOnly.call('mdb_wiki_propose_change', { action: 'rename', targetPageId: rename.id, targetRevisionId: afterDiff.revisionId, newTitle: 'Never written', reason: 'Read-only probe.' });
  const missingWrite = await readOnly.call('mdb_wiki_propose_change', { action: 'rename', targetPageId: 'obj_not_present', targetRevisionId: 'rev_missing', newTitle: 'Never written', reason: 'Missing probe.' });
  assert.equal(JSON.stringify(forbiddenWrite.content), JSON.stringify(missingWrite.content), 'read-only and missing targets use the same generic error');
  const malformedResponse = await readOnly.raw('{');
  assert.equal(malformedResponse.status, 400, 'malformed JSON is bounded and rejected');
  assert.equal((await readOnly.raw(JSON.stringify({ payload: 'x'.repeat(2_200_000) }))).status, 413, 'oversized JSON receives a bounded rejection');
  let afterOversized: Json;
  try { afterOversized = await client.call('mdb_wiki_lint', { scopes: [wiki], limit: 1 }); }
  catch (error) { throw new Error(`listener check after oversized rejection failed: ${String(error)}`); }
  assert.ok(afterOversized.structuredContent, 'the listener remains available after rejecting the oversized body');

  // Remote CLI mode must route through HTTP. Exercise read-only commands and a remote proposal.
  const remoteEnv = { ...process.env, WIKI_E2E_TOKEN: agent.token };
  const remoteLint = spawnSync(process.execPath, ['bin/mdb.js', 'wiki', 'lint', '--server', firstServer.endpoint, '--token-env', 'WIKI_E2E_TOKEN', '--scope', 'wiki', '--json'], { cwd: process.cwd(), encoding: 'utf8', env: remoteEnv, timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(remoteLint.status, 0, remoteLint.stderr);
  assert.equal(JSON.parse(remoteLint.stdout).semanticTruthVerified, false);
  await firstServer.stop();

  // MCP uses the trusted vault model configuration, while keeping the call enqueue-only.
  await vault.setConfig(config => { config.model = { ...config.model, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelName: 'gpt-oss:latest', allowNetwork: false, locality: 'local' }; });
  const configuredServer = await startServer(root, t);
  const configured = await connect(configuredServer.endpoint, agent.token);
  for (const [name, input] of skills) {
    const result = await configured.call('mdb_skill_run', { name, input });
    assert.equal(result.structuredContent.result.semanticExecutionAvailable, true, `${name} sees the configured local provider`);
  }

  // Local CLI e2e: every wiki subcommand, both option syntaxes, JSON output, exit codes, review, and retrieval.
  const cliRetire = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'CLI retire', body: 'Retire through CLI [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }] });
  const cliRestore = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'CLI restore', body: 'Restore through CLI [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }] });
  const cliRestoreDeleted = await vault.delete(cliRestore.id, cliRestore.revisionId);
  const cliRename = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'CLI rename', body: 'Rename through CLI [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }] });
  const cliMergeTarget = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'CLI merge target', body: 'Merge target [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }] });
  const cliMergeSource = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'CLI merge source', body: 'Merge source.' });
  const lintSeparate = JSON.parse(cli(root, ['wiki', 'lint', '--scope', 'wiki', '--check', 'missing_evidence', '--min-severity', 'error', '--limit', '20']).stdout);
  const lintEquals = JSON.parse(cli(root, ['wiki', 'lint', '--scope=wiki', '--check=missing_evidence', '--min-severity=error', '--limit=20']).stdout);
  assert.equal(lintSeparate.semanticTruthVerified, false); assert.equal(lintEquals.semanticTruthVerified, false);
  const cliProposals = [
    JSON.parse(cli(root, ['wiki', 'propose', 'retire', '--page', cliRetire.id, '--revision', cliRetire.revisionId, '--reason', 'CLI retire']).stdout),
    JSON.parse(cli(root, ['wiki', 'propose', 'restore', `--page=${cliRestore.id}`, `--revision=${cliRestoreDeleted.revisionId}`, `--to-revision=${cliRestore.revisionId}`, '--reason=CLI restore']).stdout),
    JSON.parse(cli(root, ['wiki', 'propose', 'rename', '--page', cliRename.id, '--revision', cliRename.revisionId, '--title', 'CLI renamed page', '--reason', 'CLI rename']).stdout),
    JSON.parse(cli(root, ['wiki', 'propose', 'merge', `--target=${cliMergeTarget.id}`, `--revision=${cliMergeTarget.revisionId}`, `--source=${cliMergeSource.id}:${cliMergeSource.revisionId}`, '--title=CLI merged page', '--body=A calibrated observatory publishes a survey every autumn [1].', `--evidence=${source.uri}:${source.revisionId}:publishes a survey every autumn`, '--reason=CLI merge']).stdout)
  ];
  assert.ok(cliProposals.every(proposal => proposal.status === 'pending'));
  assert.equal(JSON.parse(cli(root, ['wiki', 'proposals', '--status', 'pending']).stdout).length, cliProposals.length + 4);
  const help = spawnSync(process.execPath, ['bin/mdb.js', 'help'], { cwd: process.cwd(), encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(help.status, 0); assert.match(help.stdout, /wiki lint/);
  const invalid = spawnSync(process.execPath, ['bin/mdb.js', 'wiki', 'propose', 'unknown', '--root', root, '--json'], { cwd: process.cwd(), encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /wiki propose requires/);
  for (const proposal of cliProposals) {
    const approved = JSON.parse(cli(root, ['intelligence', 'approve', proposal.id]).stdout);
    assert.equal(approved.status, 'approved');
  }
  const deletedViaCli = JSON.parse(cli(root, ['get', cliRetire.id]).stdout);
  assert.equal(deletedViaCli.status, 'deleted');
  assert.equal(JSON.parse(cli(root, ['history', cliRetire.id]).stdout).length, 2);
  const search = JSON.parse(cli(root, ['search', 'Retire through CLI', '--mode', 'grep', '--scope', 'wiki']).stdout);
  assert.equal(search.hits.some((hit: Json) => hit.objectId === cliRetire.id), false, 'retired page is absent from CLI search');
  assert.equal((await (vault as unknown as Vault).verify()).ok, true);
  assert.equal((await vault.config()).model.provider, 'ollama');
  assert.notEqual(originalConfig.model.provider, 'ollama', 'the test switches from the vault default to the configured provider');

  console.log(JSON.stringify({ http: { tools: tools.filter(name => name.startsWith('mdb_wiki') || name === 'mdb_diff'), actions: proposals.length, noProviderSkills: skills.length, providerSkills: skills.length, concurrentClients: concurrent.length, malformed: 400, oversized: 413, aclParity: true }, cli: { actions: cliProposals.length, optionForms: 2, json: true, invalidExitCode: invalid.status, remote: 'passed', reviewed: cliProposals.length, history: '2 revisions', searchHidesRetired: true } }));
  recordCase({ suite: 'wiki', name: 'wiki-http-cli-deployment-e2e', status: 'PASS' });
});
