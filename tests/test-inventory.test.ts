import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Completeness of the verification inventory. Every tests/**\/*.test.ts file must be run by `npm test` or by another declared script (verify:*, test:*, scripts/*.ts suites),
 * or be listed in tests/test-inventory-exemptions.json WITH a reason. A new unlisted test file fails here instead of silently never running (15 dashboard test files were once in no script).
 */
async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full, out); else if (/\.test\.(?:ts|mjs)$/.test(entry.name)) out.push(full); }
  return out;
}
const toRegex = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
const patternsIn = (text: string): string[] => [...text.matchAll(/(?:dist\/)?tests\/[\w\/\-.*]+\.test\.(?:js|mjs)/g)].map(m => m[0].replace(/^dist\//, '').replace(/\.test\.js$/, '.test.ts'));
test('every test file is run by npm test or another declared script, or is exempted with a reason', async () => {
  const root = process.cwd(); const files = (await walk(path.join(root, 'tests'))).map(f => path.relative(root, f).split(path.sep).join('/'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const npmTest = patternsIn(pkg.scripts.test!); let others = Object.entries(pkg.scripts).filter(([k]) => k !== 'test').flatMap(([, v]) => patternsIn(v));
  for (const f of await fs.readdir(path.join(root, 'scripts'))) if (/\.(?:ts|mjs)$/.test(f)) others = others.concat(patternsIn(await fs.readFile(path.join(root, 'scripts', f), 'utf8')));
  for (const f of await fs.readdir(path.join(root, '.github/workflows')).catch(() => [] as string[])) if (/\.ya?ml$/.test(f)) others = others.concat(patternsIn(await fs.readFile(path.join(root, '.github/workflows', f), 'utf8')));
  const covered = (patterns: string[]) => new Set(files.filter(f => patterns.some(p => toRegex(p).test(f))));
  const inTest = covered(npmTest), inOthers = covered(others);
  const exemptions = (JSON.parse(await fs.readFile(path.join(root, 'tests/test-inventory-exemptions.json'), 'utf8')) as { exemptions: Record<string, string> }).exemptions;
  for (const [file, reason] of Object.entries(exemptions)) { assert.ok(files.includes(file), `exemption for a file that does not exist: ${file}`); assert.ok(reason.trim().length >= 20, `exemption needs a real reason: ${file}`); }
  const unlisted = files.filter(f => !inTest.has(f) && !inOthers.has(f) && !(f in exemptions));
  assert.deepEqual(unlisted, [], `test files that no script runs and no exemption explains:\n${unlisted.join('\n')}`);
  for (const f of files.filter(f => f.startsWith('tests/dashboard/') && f.endsWith('.test.ts'))) assert.ok(inTest.has(f), `dashboard test ${f} must run in the default npm test (and therefore in CI)`);
  for (const p of npmTest) assert.ok(files.some(f => toRegex(p).test(f)), `npm test lists a pattern that matches no file: ${p}`);
});
