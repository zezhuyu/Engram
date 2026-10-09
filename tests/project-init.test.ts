import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Engram } from '../packages/sdk/index.js';
import { initializeProject } from '../packages/project-init.js';
import { execute } from '../packages/cli/index.js';

test('project init installs host memory capture and injects accepted preferences without replacing agent instructions', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'engram-project-init-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'), projectDir = path.join(base, 'sample-project'), settingsPath = path.join(base, 'claude-settings.json');
  await mkdir(projectDir);
  await writeFile(path.join(projectDir, 'CLAUDE.md'), '# Existing guidance\n\nKeep this section.\n');
  await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ['Read'] } }));
  const client = new Engram(root); await client.init({ sqlite: false });
  await client.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'Review practice', body: 'The user wants tests run and detailed feedback before a task is complete.', status: 'accepted', metadata: { category: 'preference', evidenceClass: 'explicit', visibility: 'user_private' } });
  await client.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'Other project preference', body: 'This applies only to another project.', status: 'accepted', metadata: { category: 'preference', evidenceClass: 'explicit', visibility: 'user_private', scopeLabel: 'different-project' } });

  const commandResult = await execute(['init', '--project', '--host', 'claude-code', '--project-dir', projectDir, '--settings-path', settingsPath, '--root', root, '--no-sqlite']);
  const result = (commandResult as { project: Awaited<ReturnType<typeof initializeProject>> }).project;
  assert.equal(result.workspaceId, 'sample-project');
  assert.equal(path.basename(result.instructionsFile), 'CLAUDE.md');
  const instructions = await readFile(result.instructionsFile, 'utf8');
  assert.match(instructions, /# Existing guidance/);
  assert.match(instructions, /Keep this section\./);
  assert.match(instructions, /The user wants tests run and detailed feedback/);
  assert.doesNotMatch(instructions, /This applies only to another project/);
  assert.match(instructions, /Do not create project-local notes/);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { permissions: { allow: string[] }; hooks: Record<string, unknown[]> };
  assert.deepEqual(settings.permissions.allow, ['Read']);
  assert.ok(Object.keys(settings.hooks).length > 0);
  assert.equal((await client.listWorkspaces()).filter(workspace => workspace.id === 'sample-project').length, 1);

  await initializeProject(client, { projectDir, host: 'claude-code', settingsPath });
  const repeated = await readFile(result.instructionsFile, 'utf8');
  assert.equal((repeated.match(/engram:managed:start/g) ?? []).length, 1, 'rerun replaces the managed block instead of duplicating it');
  assert.equal((await client.listWorkspaces()).filter(workspace => workspace.id === 'sample-project').length, 1);
});

test('remote project init connects directly to the shared HTTP MCP server without creating a local vault', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'engram-remote-init-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const projectDir = path.join(base, 'remote-project');
  await mkdir(projectDir);
  const result = await execute(['init', '--project', '--host', 'claude-code', '--project-dir', projectDir, '--mcp-url', 'https://memory.example/mcp', '--token-env', 'SHARED_ENGRAM_TOKEN', '--root', path.join(base, 'must-not-exist')]) as { project: Awaited<ReturnType<typeof initializeProject>> };
  assert.equal(result.project.adapter && (result.project.adapter as { mode: string }).mode, 'remote-mcp');
  const config = JSON.parse(await readFile(path.join(projectDir, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { type: string; url: string; headers: { Authorization: string } }> };
  assert.deepEqual(config.mcpServers.engram, { type: 'http', url: 'https://memory.example/mcp', headers: { Authorization: 'Bearer ${SHARED_ENGRAM_TOKEN}' } });
  const instructions = await readFile(result.project.instructionsFile, 'utf8');
  assert.match(instructions, /shared memory source across machines/);
  assert.match(instructions, /mdb_insight_search/);
  const hooksPath = path.join(projectDir, '.claude', 'settings.json');
  const withHooks = await initializeProject(undefined, { projectDir, host: 'claude-code', mcpUrl: 'https://memory.example/mcp', tokenEnv: 'SHARED_ENGRAM_TOKEN', principalId: 'claude-laptop', registrationId: 'reg_server', consent: true, settingsPath: hooksPath });
  assert.equal((withHooks.adapter as { registrationId: string }).registrationId, 'reg_server');
  const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  assert.match(hooks.hooks.UserPromptSubmit![0]!.hooks[0]!.command, /--remote-url/);
  await assert.rejects(readFile(path.join(projectDir, '.mdb', 'capture', 'registrations', 'reg_server.json')));
  await assert.rejects(readFile(path.join(base, 'must-not-exist', 'commits.jsonl')));
});

test('remote Codex project init uses bearer token environment lookup and replaces its managed config block', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'engram-codex-remote-init-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const projectDir = path.join(base, 'codex-project');
  await mkdir(path.join(projectDir, '.codex'), { recursive: true });
  await writeFile(path.join(projectDir, '.codex', 'config.toml'), 'model = "gpt-test"\n');
  const first = await initializeProject(undefined, { projectDir, host: 'codex', mcpUrl: 'https://memory.example/mcp', tokenEnv: 'SHARED_ENGRAM_TOKEN' });
  await initializeProject(undefined, { projectDir, host: 'codex', mcpUrl: 'https://memory.example/next', tokenEnv: 'SHARED_ENGRAM_TOKEN' });
  const config = await readFile(path.join(projectDir, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /model = "gpt-test"/);
  assert.match(config, /url = "https:\/\/memory\.example\/next"/);
  assert.match(config, /bearer_token_env_var = "SHARED_ENGRAM_TOKEN"/);
  assert.equal((config.match(/\[mcp_servers\.engram\]/g) ?? []).length, 1);
  assert.equal(path.basename(first.instructionsFile), 'AGENTS.md');
});
