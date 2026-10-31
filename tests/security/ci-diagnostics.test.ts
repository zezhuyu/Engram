import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadSuiteReport, runSuite, scrubDiagnostics, summarize } from '../../scripts/lib/suite.js';

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

// Every shape below leaked through the first version (or the shared scrubber alone); each secret must be gone, and the non-secret structure kept.
const home = os.homedir();
const PROBES: Array<[string, string, string]> = [
  ['bearer header', 'Authorization: Bearer abcdefghijklmnop1234567890', 'abcdefghijklmnop1234567890'],
  ['basic auth header', 'authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3M=', 'dXNlcjpzdXBlcnNlY3JldHBhc3M='],
  ['bearer split over lines', 'Authorization: Bearer\n   abcdefghijklmnop1234567890', 'abcdefghijklmnop1234567890'],
  ['engram credential', `got ${TOKEN}`, 'A'.repeat(43)],
  ['access_token pair', 'access_token=ya29.a0AfH6SMBxxxxxxxxxxxxxxxx', 'ya29.a0AfH6SMBxxxxxxxxxxxxxxxx'],
  ['refresh_token json', '{"refresh_token":"1//0gXXXXXXXXXXXXXXXXXXXXXXXX"}', '1//0gXXXXXXXXXXXXXXXXXXXXXXXX'],
  ['id_token pair', 'id_token: eyJhbGciOiJSUzI1NiJ9xx', 'eyJhbGciOiJSUzI1NiJ9xx'],
  ['db_password pair', 'db_password=hunter2hunter2', 'hunter2hunter2'],
  ['client_secret', 'client_secret=abcd1234efgh5678', 'abcd1234efgh5678'],
  ['aws secret access key', 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['x-api-key header', 'x-api-key: abcdef0123456789abcdef', 'abcdef0123456789abcdef'],
  ['camelCase apiKey json', '{"apiKey":"abcdef0123456789abcdef"}', 'abcdef0123456789abcdef'],
  ['postgres url', 'postgres://admin:s3cretpass@db.internal:5432/app', 's3cretpass'],
  ['redis url with empty user', 'redis://:topsecretvalue@cache:6379', 'topsecretvalue'],
  ['mongodb+srv url', 'mongodb+srv://user:p4ssw0rd99@cluster0.mongodb.net', 'p4ssw0rd99'],
  ['https url credentials', 'https://user:pw12345678@example.com/x', 'pw12345678'],
  ['stripe live key', `sk_live_${'a1B2c3D4e5F6g7H8i9J0k1L2'}`, 'a1B2c3D4e5F6g7H8i9J0k1L2'],
  ['anthropic key', `sk-ant-api03-${'abcdefghijklmnopqrstuvwx'}`, 'abcdefghijklmnopqrstuvwx'],
  ['github pat', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['npm token', `npm_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`, 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
  ['gitlab token', `glpat-${'a1B2c3D4e5F6g7H8i9J0'}`, 'a1B2c3D4e5F6g7H8i9J0'],
  ['huggingface token', `hf_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5'}`, 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5'],
  ['sendgrid key', `SG.${'a1B2c3D4e5F6g7H8'}.${'i9J0k1L2m3N4o5P6'}`, 'a1B2c3D4e5F6g7H8'],
  ['google api key', `AIza${'SyA-1234567890abcdefghijklmnopqrstu'}`, 'SyA-1234567890abcdefghijklmnopqrstu'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
  ['private key', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'],
  ['private key without END (malformed)', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxx\nmore body lines', 'MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxx'],
  ['private key body whose BEGIN line was cut off', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC8\n-----END PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'],
  ['openssh private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'],
  ['home directory', `file ${home}/proj/notes.md`, home],
  ['query-string token', 'GET /x?token=abcdef0123456789&y=1', 'abcdef0123456789'],
  ['cookie', 'Cookie: session=abcdef0123456789abcdef; theme=dark', 'abcdef0123456789abcdef'],
  ['set-cookie', 'Set-Cookie: sid=abcdef0123456789abcdef; HttpOnly', 'abcdef0123456789abcdef'],
];

test('every known secret shape is scrubbed, including snake_case keys, Basic auth, non-HTTP URLs, provider keys, cookies and key bodies', () => {
  const leaked = PROBES.filter(([, text, secret]) => scrubDiagnostics(text, {}).includes(secret)).map(([name]) => name);
  assert.deepEqual(leaked, []);
});

test('ordinary diagnostic text is not over-redacted and the scrubber stays fast on large hostile input', () => {
  for (const keep of ['max_tokens: 5', 'tokens: 12', 'token count was 1500', 'expected: "actual-value"', 'obj_0123456789abcdef0123456789abcdef', 'status: FAILED at dist/tests/x.test.js:84:1', 'password policy test', 'AssertionError: Expected values to be strictly equal']) assert.equal(scrubDiagnostics(keep, {}), keep);
  for (const hostile of [('QUJD'.repeat(16) + '\n').repeat(16000), 'A-b_c.D'.repeat(150000), 'token '.repeat(170000), 'http://a:b/'.repeat(90000), ':='.repeat(500000)]) { const started = Date.now(); scrubDiagnostics(hostile, {}); assert.ok(Date.now() - started < 3000, 'a 1 MB hostile input must scrub in well under 3 s (it was quadratic once)'); }
});

async function suiteDir(t: { after(fn: () => void | Promise<void>): void }) { const dir = await mkdtemp(path.join(os.tmpdir(), 'engram-diag-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function nested<T>(work: () => Promise<T>): Promise<T> { const context = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT; try { return await work(); } finally { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; } }

test('output is scrubbed before it is cut to size, so a secret straddling the cap cannot survive as a fragment, and the artifact stays bounded', async t => {
  const dir = await suiteDir(t); const message = Array.from({ length: 4000 }, (_, i) => `Authorization: Bearer abcdefghijklmnop${i}`).join('\n'); // ~180 KB of tokens, so the 100 KB cut falls inside one
  await writeFile(path.join(dir, 'big.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict';\ntest('big', () => { assert.equal('a', 'b', ${JSON.stringify(message)}); });\n`);
  await nested(() => runSuite({ name: 'big', title: 'big', files: [path.join(dir, 'big.test.mjs')], gaps: [], limitations: [] }, path.join(dir, 'out')));
  const stored = await readFile(path.join(dir, 'out/big/last-output.txt'), 'utf8'); const json = await readFile(path.join(dir, 'out/big/report.json'), 'utf8');
  assert.equal(stored.includes('abcdefghijklmnop'), false, 'no token or token fragment in the artifact'); assert.equal(json.includes('abcdefghijklmnop'), false);
  assert.ok(stored.length <= 100_000 + 10_000 + 64, `last-output.txt is bounded (${stored.length} chars)`); assert.ok(json.length < 60_000, `report.json is bounded (${json.length} chars)`);
  const summary = JSON.parse(json) as { evidenceSource: { fingerprint: string; manifestPath: string; manifestSha256: string; fileCount: number } };
  const evidenceBytes = await readFile(path.join(dir, 'out/big/source-evidence.json'));
  assert.equal(summary.evidenceSource.manifestPath, 'source-evidence.json');
  assert.equal(createHash('sha256').update(evidenceBytes).digest('hex'), summary.evidenceSource.manifestSha256, 'the compact report binds the complete source file map');
  assert.equal((await loadSuiteReport(path.join(dir, 'out/big/report.json')))?.evidenceSource.fingerprint, summary.evidenceSource.fingerprint, 'release loading restores the complete source evidence');
});

test('release report loading fails closed when the source evidence sidecar is changed or absent', async t => {
  const dir = await suiteDir(t); await writeFile(path.join(dir, 'ok.test.mjs'), `import test from 'node:test'; test('ok', () => {});\n`);
  const out = path.join(dir, 'out'); await nested(() => runSuite({ name: 'ok', title: 'ok', files: [path.join(dir, 'ok.test.mjs')], gaps: [], limitations: [] }, out));
  const reportPath = path.join(out, 'ok/report.json');
  assert.ok(await loadSuiteReport(reportPath), 'unmodified report and evidence sidecar load');
  await writeFile(path.join(out, 'ok/source-evidence.json'), '{"tampered":true}\n');
  assert.equal(await loadSuiteReport(reportPath), undefined, 'edited evidence cannot be hydrated');
  await writeFile(path.join(out, 'ok/source-evidence.json'), '{}\n');
  const report = JSON.parse(await readFile(reportPath, 'utf8')); report.evidenceSource.manifestPath = '../outside.json'; await writeFile(reportPath, JSON.stringify(report));
  assert.equal(await loadSuiteReport(reportPath), undefined, 'manifest path traversal is rejected');
});

test('details are kept for at most the first 25 failures and the report stays bounded', async t => {
  const dir = await suiteDir(t); const many = Array.from({ length: 50 }, (_, i) => `test('fails ${i}', () => { assert.equal(${i}, -1, 'reason ${i}'); });`).join('\n');
  await writeFile(path.join(dir, 'many.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict';\n${many}\n`);
  const report = await nested(() => runSuite({ name: 'many', title: 'many', files: [path.join(dir, 'many.test.mjs')], gaps: [], limitations: [] }, path.join(dir, 'out')));
  assert.equal(report.counts.fail, 50); assert.equal(report.tests.filter(x => x.detail).length, 25, 'the first 25 failures carry their assertion text, the rest only their name');
  assert.match(report.tests[0]!.detail!, /reason 0/); assert.equal(report.tests[40]!.detail, undefined);
});

test('a passing suite is untouched: no artifact, no failure detail, only the headline is printed', async t => {
  const dir = await suiteDir(t); await writeFile(path.join(dir, 'ok.test.mjs'), `import test from 'node:test'; test('ok', () => {}); test('also ok', () => {});\n`);
  const report = await nested(() => runSuite({ name: 'ok', title: 'ok', files: [path.join(dir, 'ok.test.mjs')], gaps: [], limitations: [] }, path.join(dir, 'out')));
  assert.equal(report.status, 'PASS'); assert.equal(report.tests.some(x => x.detail !== undefined), false); await assert.rejects(stat(path.join(dir, 'out/ok/last-output.txt')), /ENOENT/);
  const saved = process.exitCode; const printed: string[] = []; const log = console.log; console.log = (...a: unknown[]) => { printed.push(a.join(' ')); }; try { summarize(report); } finally { console.log = log; process.exitCode = saved; }
  assert.equal(printed.length, 1); assert.match(printed[0]!, /^ok: PASS \(2\/2 tests/);
});

test('a failing suite still shows what is needed to debug it: the test name, the message, expected and actual values', async t => {
  const dir = await suiteDir(t); await writeFile(path.join(dir, 'f.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict';\ntest('compares two values', () => { assert.deepEqual({ max_tokens: 5, id: 'obj_0123456789abcdef0123456789abcdef' }, { max_tokens: 6, id: 'obj_0123456789abcdef0123456789abcdef' }, 'the budget differs'); });\n`);
  const report = await nested(() => runSuite({ name: 'f', title: 'f', files: [path.join(dir, 'f.test.mjs')], gaps: [], limitations: [] }, path.join(dir, 'out')));
  const detail = report.tests[0]!.detail!; assert.equal(report.tests[0]!.name, 'compares two values'); assert.match(detail, /the budget differs/); assert.match(detail, /max_tokens: 5/); assert.match(detail, /max_tokens: 6/); assert.match(detail, /obj_0123456789abcdef0123456789abcdef/); assert.match(detail, /AssertionError/);
});
