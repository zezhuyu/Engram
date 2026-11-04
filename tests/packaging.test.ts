import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, symlinkSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Engram is distributed as the standalone bundle (scripts/standalone.mjs), not through npm. These guards stop an accidental `npm publish` (which would ship the test tree, verification
 * documents and the UNSAFE study prototypes under scripts/profiling) without ever running one: npm's own `publish --dry-run` does not refuse private packages, and a real publish may
 * hold the developer's registry credentials, so the checks are static.
 */
const root = process.cwd(); const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { private?: unknown; publishConfig?: unknown; files?: unknown; scripts?: Record<string, string>; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
const PROTOTYPE = /(^|\/)(proto-[^/]*|upper-bound-experiment|mutation-check|final-profile|stage-[^/]*)\.(m?js|ts)$/;

function walk(dir: string, out: string[] = []): string[] { for (const name of readdirSync(dir)) { const p = path.join(dir, name); if (statSync(p).isDirectory()) walk(p, out); else out.push(path.relative(root, p)); } return out; }

test('the package is private, has no publish configuration and no workflow publishes it', () => {
  assert.equal(pkg.private, true, 'package.json must stay "private": true (the standalone bundle is the distribution)');
  assert.equal(pkg.publishConfig, undefined, 'no publishConfig');
  for (const hook of ['prepublishOnly', 'publish', 'postpublish']) assert.equal(pkg.scripts?.[hook], undefined, `no ${hook} script`);
  const workflows = path.join(root, '.github/workflows'); for (const file of readdirSync(workflows)) { const text = readFileSync(path.join(workflows, file), 'utf8'); assert.doesNotMatch(text, /npm\s+publish|NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/, `${file} must not publish to a registry`); }
});

test('public release publication requires a version tag, release environment approval, and current release qualification', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const publish = /  publish-release:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:|$)/.exec(workflow)?.[1];
  assert.ok(publish, 'publish-release job exists');
  assert.match(workflow, /tags:\s*\['v\*'\]/, 'only explicit version tags trigger release qualification');
  assert.match(workflow, /workflow_dispatch:[\s\S]*?authorize_release:[\s\S]*?type:\s*boolean[\s\S]*?required:\s*true[\s\S]*?default:\s*false/, 'manual publication requires a reviewable affirmative input');
  assert.match(publish!, /if:\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.authorize_release\s*==\s*true\s*&&\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)/, 'a push or pull request can never publish, even for a version tag');
  assert.match(publish!, /needs:\s*\[package-apps,\s*release-qualification\]/, 'publication depends on current-source qualification');
  assert.match(publish!, /environment:\s*engram-release/, 'publication requires the separately protected owner review environment');
  assert.match(publish!, /ENGRAM_RELEASE_AUTHORIZATION_JSON:\s*\$\{\{\s*secrets\.ENGRAM_RELEASE_AUTHORIZATION_JSON\s*\}\}/, 'publication requires an owner-signed authorization secret');
  assert.match(publish!, /ENGRAM_RELEASE_AUTHORIZATION_PUBLIC_KEY:\s*\$\{\{\s*secrets\.ENGRAM_RELEASE_AUTHORIZATION_PUBLIC_KEY\s*\}\}/, 'the verifier uses the separately configured trust key');
  assert.ok(publish!.indexOf('node dist/scripts/verify-release-authorization.js') < publish!.indexOf('gh release create'), 'authorization is verified before the publication command');
  assert.ok(workflow.includes('[[ "$GITHUB_REF_NAME" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+'), 'release qualification accepts only semantic-version-shaped tags');
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/, 'release tags must point to a commit reachable from main');
  const releasePolicy = readFileSync(path.join(root, 'docs/release-publication.md'), 'utf8');
  assert.match(releasePolicy, /Required reviewers limited to the release owner/);
  assert.match(releasePolicy, /Prevent self-review enabled/);
  assert.match(releasePolicy, /Deployment branches\/tags restricted to version tags/);
  assert.match(workflow, /release-qualification:[\s\S]*?MDB_RELEASE_PROFILE:\s*full-intelligence-beta[\s\S]*?npm run verify:all[\s\S]*?npm run verify:release[\s\S]*?releaseProfile!=='full-intelligence-beta'[\s\S]*?releaseLevel\)\)/, 'full verification and exact selected-profile qualification gate publication');
  assert.match(readFileSync(path.join(root, 'scripts/verify-release.ts'), 'utf8'), /policy\.level === 'NOT_RELEASABLE'[^\n]*process\.exitCode = 1/, 'required selected-profile failures exit nonzero');
  assert.match(readFileSync(path.join(root, 'scripts/verify-release.ts'), 'utf8'), /'full-intelligence-beta'/, 'the default release profile is explicit');
  assert.match(readFileSync(path.join(root, 'docs/release-profile-contract.md'), 'utf8'), /local editable list is not proof/);
  assert.match(publish!, /permissions:\s*\n\s+contents:\s+write/, 'write permission is scoped to the publish job');
  assert.match(workflow, /\npermissions:\s*\n\s+contents:\s+read/, 'all non-publish jobs receive only repository read access');
  assert.doesNotMatch(publish!, /if:\s*github\.event_name\s*==\s*'push'/, 'push events never publish');
});

test('if the package is ever made public it must have a files allowlist whose tarball excludes tests, verification and study prototypes', () => {
  if (pkg.private === true) return; // guarded by the first test; this branch only matters if someone removes the flag
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'a public package needs an explicit "files" allowlist');
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }); assert.equal(pack.status, 0, pack.stderr);
  const listed = (JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map(f => f.path);
  assert.deepEqual(listed.filter(f => PROTOTYPE.test(f) || f.startsWith('tests/') || f.startsWith('verification/') || f.startsWith('scripts/profiling/')), []);
});

test('standalone packaging excludes source maps and upstream reference corpora while keeping adapter drivers optional', () => {
  const source = readFileSync(path.join(root, 'scripts/standalone.mjs'), 'utf8'); const copy = /for \(const path of \[([^\]]*)\]\)/.exec(source);
  assert.ok(copy, 'the bundle copy list must stay a single explicit allowlist in scripts/standalone.mjs');
  const bundlePaths = [...copy[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(bundlePaths, ['dist/packages', 'dist/integrations', 'bin', 'skills', 'package.json', 'package-lock.json']);
  assert.ok(!bundlePaths.includes('dist'), 'standalone bundles must not copy compiled tests, fixtures, or build scripts');
  assert.ok(bundlePaths.includes('dist/packages') && bundlePaths.includes('dist/integrations'), 'standalone bundle retains compiled runtime and SDK integrations');
  assert.match(source, /removeSourceMaps\(join\(out, 'app', 'dist'\)\)/);
  assert.match(source, /skills', 'upstream-kb/);
  assert.match(source, /--omit=optional/);
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}).sort(), ['@aws-sdk/client-s3', 'pg']);
  assert.ok(pkg.dependencies && !('@aws-sdk/client-s3' in pkg.dependencies) && !('pg' in pkg.dependencies));
  const client = readFileSync(path.join(root, 'scripts/package-client.mjs'), 'utf8');
  assert.match(client, /\['dist\/packages', 'dist\/integrations', 'skills'\]/, 'client package carries the runtime skill directory');
  assert.ok(statSync(path.join(root, 'dist/packages/dashboard/server.js')).isFile(), 'dashboard server is compiled into the packaged runtime tree');
  assert.ok(statSync(path.join(root, 'dist/packages/dashboard/ui/view-model.js')).isFile(), 'embedded dashboard UI module is compiled into the packaged runtime tree');
  assert.match(client, /files: \['bin\/', 'dist\/', 'skills\/', 'README\.md'\]/, 'npm tarball allowlist carries skills without tests or verification artifacts');
  assert.match(client, /skills\/upstream-kb/);
  assert.match(client, /optionalDependencies:/);
  assert.deepEqual(walk(path.join(root, 'dist')).filter(f => PROTOTYPE.test(f) || f.includes('scripts/profiling')), [], 'compiled output must not contain prototypes or profiling tooling');
  assert.deepEqual(walk(path.join(root, 'bin')).filter(f => PROTOTYPE.test(f)), []);
});

test('filesystem MCP runtime starts when optional S3 and PostgreSQL drivers are absent', () => {
  const installed = mkdtempSync(path.join(tmpdir(), 'engram-optional-adapters-'));
  try {
    cpSync(path.join(root, 'dist/packages'), path.join(installed, 'dist/packages'), { recursive: true });
    cpSync(path.join(root, 'dist/integrations'), path.join(installed, 'dist/integrations'), { recursive: true });
    cpSync(path.join(root, 'bin/mdb-mcp.js'), path.join(installed, 'bin/mdb-mcp.js'));
    cpSync(path.join(root, 'node_modules/yaml'), path.join(installed, 'node_modules/yaml'), { recursive: true });
    const home = path.join(installed, 'home'), vault = path.join(installed, 'vault');
    const init = spawnSync(process.execPath, ['--input-type=module', '-e', `import{Vault}from${JSON.stringify(path.join(installed, 'dist/packages/core/vault.js'))};await new Vault(${JSON.stringify(vault)}).init({sqlite:false})`], { cwd: installed, encoding: 'utf8', timeout: 30_000 });
    assert.equal(init.status, 0, init.stderr);
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'optional-adapter-smoke', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map(message => JSON.stringify(message)).join('\n') + '\n';
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ENGRAM_DATA_DIR: vault, MDB_ROOT: vault, MDB_MCP_TRANSPORT: 'stdio', MDB_ACTOR_ID: 'packaging-smoke', MDB_PERMISSIONS: '*' };
    delete env.MDB_STORAGE_BACKEND;
    delete env.MDB_POSTGRES_URL;
    const result = spawnSync(process.execPath, [path.join(installed, 'bin/mdb-mcp.js'), '--root', vault], { cwd: installed, env, input, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } });
    const tools = messages.find(message => message.id === 2)?.result?.tools;
    assert.ok(tools?.some(tool => tool.name === 'mdb_search'), 'filesystem MCP starts and discovers tools without unused adapter packages');
  } finally { rmSync(installed, { recursive: true, force: true }); }
});

test('skillRoot resolves SKILL.md from an installed bundle layout', async () => {
  const installed = mkdtempSync(path.join(tmpdir(), 'engram-installed-layout-'));
  try {
    cpSync(path.join(root, 'dist/packages'), path.join(installed, 'dist/packages'), { recursive: true });
    cpSync(path.join(root, 'skills'), path.join(installed, 'skills'), { recursive: true });
    cpSync(path.join(root, 'package.json'), path.join(installed, 'package.json'));
    symlinkSync(path.join(root, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
    const { pathToFileURL } = await import('node:url');
    const { getSkill } = await import(pathToFileURL(path.join(installed, 'dist/packages/skills/index.js')).href);
    const skill = await getSkill('wiki-lint');
    assert.match(skill.instructions, /# wiki-lint/);
  } finally { rmSync(installed, { recursive: true, force: true }); }
});
