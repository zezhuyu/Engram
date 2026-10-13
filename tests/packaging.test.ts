import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Engram is distributed as the standalone bundle (scripts/standalone.mjs), not through npm. These guards stop an accidental `npm publish` (which would ship the test tree, verification
 * documents and the UNSAFE study prototypes under scripts/profiling) without ever running one: npm's own `publish --dry-run` does not refuse private packages, and a real publish may
 * hold the developer's registry credentials, so the checks are static.
 */
const root = process.cwd(); const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { private?: unknown; publishConfig?: unknown; files?: unknown; scripts?: Record<string, string> };
const PROTOTYPE = /(^|\/)(proto-[^/]*|upper-bound-experiment|mutation-check|final-profile|stage-[^/]*)\.(m?js|ts)$/;

function walk(dir: string, out: string[] = []): string[] { for (const name of readdirSync(dir)) { const p = path.join(dir, name); if (statSync(p).isDirectory()) walk(p, out); else out.push(path.relative(root, p)); } return out; }

test('the package is private, has no publish configuration and no workflow publishes it', () => {
  assert.equal(pkg.private, true, 'package.json must stay "private": true (the standalone bundle is the distribution)');
  assert.equal(pkg.publishConfig, undefined, 'no publishConfig');
  for (const hook of ['prepublishOnly', 'publish', 'postpublish']) assert.equal(pkg.scripts?.[hook], undefined, `no ${hook} script`);
  const workflows = path.join(root, '.github/workflows'); for (const file of readdirSync(workflows)) { const text = readFileSync(path.join(workflows, file), 'utf8'); assert.doesNotMatch(text, /npm\s+publish|NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/, `${file} must not publish to a registry`); }
});

test('if the package is ever made public it must have a files allowlist whose tarball excludes tests, verification and study prototypes', () => {
  if (pkg.private === true) return; // guarded by the first test; this branch only matters if someone removes the flag
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'a public package needs an explicit "files" allowlist');
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }); assert.equal(pack.status, 0, pack.stderr);
  const listed = (JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map(f => f.path);
  assert.deepEqual(listed.filter(f => PROTOTYPE.test(f) || f.startsWith('tests/') || f.startsWith('verification/') || f.startsWith('scripts/profiling/')), []);
});

test('the standalone bundle copies exactly dist, bin and the package files, and dist holds no study prototype', () => {
  const source = readFileSync(path.join(root, 'scripts/standalone.mjs'), 'utf8'); const copy = /for \(const path of \[([^\]]*)\]\)/.exec(source);
  assert.ok(copy, 'the bundle copy list must stay a single explicit allowlist in scripts/standalone.mjs');
  assert.deepEqual([...copy[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]), ['dist', 'bin', 'package.json', 'package-lock.json']);
  assert.deepEqual(walk(path.join(root, 'dist')).filter(f => PROTOTYPE.test(f) || f.includes('scripts/profiling')), [], 'compiled output must not contain prototypes or profiling tooling');
  assert.deepEqual(walk(path.join(root, 'bin')).filter(f => PROTOTYPE.test(f)), []);
});
