import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSuite, scrubDiagnostics, summarize } from '../../scripts/lib/suite.js';

const TOKEN = `engram_${'A'.repeat(43)}`;

test('CI failure diagnostics show the assertion but never credentials, secret environment values or the home directory', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'engram-diag-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const secrets = { bearer: 'abcdefghijklmnop1234567890', pair: 'hunter2hunter2', env: 'ci-secret-value-12345678', github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----' };
  const home = os.homedir();
  const message = `leak check: Authorization: Bearer ${secrets.bearer}; ${TOKEN}; password=${secrets.pair}; env ${secrets.env}; ${secrets.github}; ${secrets.key}; file ${home}/private-project/notes.md; https://user:pw12345678@example.com/x`;
  await writeFile(path.join(dir, 'leaky.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict';\ntest('fails on purpose and mentions secrets', () => { assert.equal('actual-value', 'expected-value', ${JSON.stringify(message)}); });\n`);
  const spec = { name: 'diag', title: 'diag', files: [path.join(dir, 'leaky.test.mjs')], gaps: [], limitations: [], env: { CI_DEPLOY_TOKEN: secrets.env } };
  const context = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT; // a nested `node --test` must not inherit the outer runner's child-process mode
  let report: Awaited<ReturnType<typeof runSuite>>; try { report = await runSuite(spec, path.join(dir, 'out')); } finally { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; }
  const saved = process.exitCode; const printed: string[] = []; const log = console.log; console.log = (...a: unknown[]) => { printed.push(a.join(' ')); };
  try { summarize(report); } finally { console.log = log; process.exitCode = saved; }
  const stored = await readFile(path.join(dir, 'out/diag/last-output.txt'), 'utf8'); const json = await readFile(path.join(dir, 'out/diag/report.json'), 'utf8');
  const surfaces: Record<string, string> = { 'printed summary': printed.join('\n'), 'report.json': json, 'last-output.txt': stored };
  assert.equal(report.status, 'FAIL');
  for (const [where, text] of Object.entries(surfaces)) {
    for (const [what, literal] of [['bearer value', secrets.bearer], ['engram credential', TOKEN], ['password pair', secrets.pair], ['secret env value', secrets.env], ['provider key', secrets.github], ['private key body', 'MIIEvQIBADANBgkq'], ['url password', 'pw12345678'], ['home directory', `${home}/private-project`]] as const) assert.equal(text.includes(literal), false, `${where} must not contain the ${what}`);
  }
  assert.match(surfaces['printed summary']!, /AssertionError/); assert.match(surfaces['printed summary']!, /actual-value/); assert.match(surfaces['printed summary']!, /expected-value/); assert.match(surfaces['printed summary']!, /leak check/, 'the assertion message itself is still shown');
  assert.match(surfaces['last-output.txt']!, /leak check/);
});

test('scrubDiagnostics masks Engram credentials and known secret environment values, keeps ordinary text', () => {
  const out = scrubDiagnostics(`ok ${TOKEN} x ${'engram_short'} ids obj_0123456789abcdef0123456789abcdef value=secret-env-12345 path`, { MY_API_KEY: 'secret-env-12345', PLAIN: 'visible-value' });
  assert.equal(out.includes(TOKEN), false); assert.match(out, /engram_\[REDACTED\]/); assert.equal(out.includes('secret-env-12345'), false); assert.match(out, /obj_0123456789abcdef0123456789abcdef/, 'ordinary ids are not masked'); assert.match(out, /engram_short/, 'short strings that are not credentials stay');
  assert.equal(scrubDiagnostics('visible-value stays', { PLAIN: 'visible-value' }), 'visible-value stays');
});
