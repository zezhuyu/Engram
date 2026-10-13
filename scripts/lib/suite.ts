import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Verification INPUT fixtures (not generated reports) live in the tracked fixtures/inputs/ tree; verification/ itself is generated output and is not tracked. */
export function inputPath(relative: string): string { return existsSync(`fixtures/inputs/${relative}`) ? `fixtures/inputs/${relative}` : `verification/${relative}`; }
import { redactText } from '../../packages/memory/redact.js';
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const SECRET_KEY_WORD = '(?:token|secret|passw(?:or)?d|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)';
/**
 * Patterns applied before the shared scrubber (packages/memory/redact.ts, which is deliberately left alone: it protects capture). They close gaps found by probing: the shared one
 * does not match snake_case keys such as access_token or aws_secret_access_key (its \b fails after an underscore), masks only the scheme word of `Authorization: Basic <b64>`, and
 * knows only http(s) URL credentials. The key-name prefix is bounded (40) so a long base64 line cannot make the match quadratic; the 8-character value minimum keeps counts such as
 * `max_tokens: 5` readable.
 */
const EXTRA_PATTERNS: Array<[RegExp, string]> = [
  [/\b(authorization\s*[:=]\s*)(?:Basic|Digest|Negotiate|Token|Bearer)\s+\S+/gi, '$1[REDACTED]'],
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]'],
  [new RegExp(`(?<![A-Za-z0-9])([A-Za-z0-9_.-]{0,40}${SECRET_KEY_WORD}s?["']?\\s*[:=]\\s*["']?)(?!\\[REDACTED)[^\\s"',;&]{8,}`, 'gi'), '$1[REDACTED]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]+@/gi, '$1[REDACTED]@'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}/g, '[REDACTED]'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED]'], [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]'], [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'], [/\bhf_[A-Za-z0-9]{30,}/g, '[REDACTED]'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
];
/**
 * Diagnostic text can leave the machine (a CI log, an uploaded artifact that GitHub does not mask). Before it is printed or stored: values of secret-looking environment variables are
 * replaced by name, the patterns above and the shared secret scrubber run (bearer tokens, key=value secrets, provider key formats, URL credentials, private keys), Engram's own
 * credential format is masked, and the user's home directory becomes ~. A failing assertion still shows its message and the expected/actual shape. Residual risk: an unlabeled
 * high-entropy string under an arbitrary key name cannot be recognized.
 */
/** Linear scan (a regex with a repeated group and a lookahead is quadratic on long base64 output): the base64 lines directly above an END PRIVATE KEY marker are a key body even when its BEGIN line is not in the text. */
function redactOrphanKeyBodies(text: string): string {
  const marker = /-----END [A-Z ]*PRIVATE KEY-----/g; let out = '', last = 0; let m: RegExpExecArray | null;
  while ((m = marker.exec(text))) {
    if (m.index > 0 && text[m.index - 1] !== '\n') continue; let start = m.index;
    for (let steps = 0; steps < 2000 && start > last; steps++) { const prevStart = text.lastIndexOf('\n', start - 2) + 1; if (prevStart < last || !/^[A-Za-z0-9+/=]{40,}[ \t\r]*$/.test(text.slice(prevStart, start - 1))) break; start = prevStart; }
    if (start < m.index) { out += text.slice(last, start) + '[REDACTED PRIVATE KEY BODY]\n'; last = m.index; }
  }
  return last ? out + text.slice(last) : text;
}
export function scrubDiagnostics(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) if (value && value.length >= 8 && SECRET_ENV_NAME.test(name)) out = out.split(value).join(`[REDACTED:${name}]`);
  for (const [pattern, replacement] of EXTRA_PATTERNS) out = out.replace(pattern, replacement);
  out = redactOrphanKeyBodies(out);
  out = redactText(out).replace(/\bengram_[A-Za-z0-9_-]{16,}/g, 'engram_[REDACTED]');
  const home = os.homedir(); if (home && home.length > 1) out = out.split(home).join('~');
  return out;
}
export type Status = 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_RUN' | 'UNSUPPORTED';
export interface Gap { item: string; status: 'NOT_RUN' | 'UNSUPPORTED' | 'FAIL'; reason: string }
export interface SuiteSpec { name: string; title: string; files: string[]; gaps: Gap[]; limitations: string[]; allowedSkips?: string[]; env?: Record<string, string>; concurrency?: number }
export interface TestResult { name: string; status: Status; /** for a failed test: the TAP diagnostic block (assertion message, expected/actual, stack head), so a CI log shows why it failed */ detail?: string }
export interface SuiteReport {
  suite: string; git_commit: string; status: Status; run_at: string; command: string; durationMs: number;
  environment: Record<string, unknown>; counts: { pass: number; fail: number; skipped: number; total: number };
  tests: TestResult[]; cases: number; caseFailures: unknown[]; seeds: number[]; invariantAssertions: number | null;
  gaps: Gap[]; limitations: string[]; repro: string; caseDetails: { name: string; status: string; detail?: unknown }[];
}
const sh = (cmd: string, args: string[] = []): string => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };

export function environment(): Record<string, unknown> {
  const tmp = os.tmpdir(); let filesystem = 'unknown';
  if (process.platform === 'darwin') { const dev = sh('df', ['-P', tmp]).split('\n')[1]?.split(/\s+/)[0]; const mount = sh('mount').split('\n').find(line => dev && line.startsWith(dev + ' ')); filesystem = /\((\w+)[,)]/.exec(mount ?? '')?.[1] ?? 'unknown'; }
  else filesystem = sh('stat', ['-f', '-c', '%T', tmp]) || 'unknown';
  let sqlite = 'unavailable'; try { sqlite = sh(process.execPath, ['-e', "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v)"]) || 'unavailable'; } catch { /* absent */ }
  return { os: `${os.type()} ${os.release()}`, platform: process.platform, arch: os.arch(), kernel: os.version(), tmpFilesystem: filesystem, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), node: process.version, sqlite, ripgrep: sh('rg', ['--version']).split('\n')[0] || 'not installed' };
}
export function gitCommit(): string { return sh('git', ['rev-parse', 'HEAD']) || 'no-git-repository'; }

export async function runSuite(spec: SuiteSpec, outRoot = 'verification'): Promise<SuiteReport> {
  const outDir = path.join(outRoot, spec.name); await fs.mkdir(outDir, { recursive: true });
  const casesFile = path.resolve(outDir, 'cases.jsonl'); await fs.rm(casesFile, { force: true });
  const args = ['--test', '--test-reporter=tap', ...(spec.concurrency ? [`--test-concurrency=${spec.concurrency}`] : []), ...spec.files];
  const started = Date.now();
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, VERIFY_CASES_FILE: casesFile, ...spec.env } });
  const durationMs = Date.now() - started;
  const tests: TestResult[] = [];
  const outLines = run.stdout.split('\n'); let detailed = 0; const MAX_DETAILS = 25; // bounded report size: details for the first 25 failures only
  for (let i = 0; i < outLines.length; i++) {
    const m = /^(not )?ok \d+ - (.*?)(?: # (SKIP|TODO).*)?$/.exec(outLines[i]!); if (!m) continue; // top-level only: subtests are indented
    const skipped = m[3] === 'SKIP'; let detail: string | undefined;
    if (m[1] && !skipped && detailed++ < MAX_DETAILS) { const block: string[] = []; for (let j = i + 1; j < outLines.length && /^\s/.test(outLines[j]!) && block.length < 60; j++) { if (outLines[j]!.trim() === '...') break; block.push(outLines[j]!.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+$/, '')); } detail = scrubDiagnostics(block.join('\n'), { ...process.env, ...spec.env }).slice(0, 6000); }
    tests.push({ name: m[2]!, status: skipped ? 'SKIPPED' : m[1] ? 'FAIL' : 'PASS', ...(detail ? { detail } : {}) });
  }
  const caseLines = (await fs.readFile(casesFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l) as { suite: string; name: string; status: string; seed?: number; detail?: unknown });
  const counts = { pass: tests.filter(t => t.status === 'PASS').length, fail: tests.filter(t => t.status === 'FAIL').length, skipped: tests.filter(t => t.status === 'SKIPPED').length, total: tests.length };
  const unapprovedSkips = tests.filter(t => t.status === 'SKIPPED' && !spec.allowedSkips?.some(s => t.name.includes(s)));
  let status: Status = counts.total === 0 ? 'NOT_RUN' : counts.fail > 0 || run.status !== 0 ? 'FAIL' : unapprovedSkips.length ? 'SKIPPED' : 'PASS';
  const caseFailures = caseLines.filter(c => c.status === 'FAIL'); if (caseFailures.length) status = 'FAIL';
  const command = `node ${args.join(' ')}`;
  const report: SuiteReport = {
    suite: spec.name, git_commit: gitCommit(), status, run_at: new Date().toISOString(), command, durationMs, environment: environment(), counts, tests,
    cases: caseLines.length, caseFailures, seeds: [...new Set(caseLines.map(c => c.seed).filter((s): s is number => typeof s === 'number'))], invariantAssertions: null,
    gaps: spec.gaps, limitations: spec.limitations, repro: `npm run build && ${command}`, caseDetails: caseLines.map(c => ({ name: `${c.suite}/${c.name}`, status: c.status, ...(c.detail ? { detail: c.detail } : {}) }))
  };
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(outDir, 'report.md'), markdown(spec, report) + '\n');
  if (status !== 'PASS') await fs.writeFile(path.join(outDir, 'last-output.txt'), scrubDiagnostics(run.stdout, { ...process.env, ...spec.env }).slice(-100000) + '\n--- stderr ---\n' + scrubDiagnostics(run.stderr, { ...process.env, ...spec.env }).slice(-10000)); // scrub the whole text first: a secret straddling the size cap must not survive as a fragment
  return report;
}
function markdown(spec: SuiteSpec, r: SuiteReport): string {
  const lines = [`# ${spec.title}`, '', `**Status: ${r.status}** — ${r.counts.pass}/${r.counts.total} tests passed, ${r.counts.fail} failed, ${r.counts.skipped} skipped; ${r.cases} recorded cases, ${r.caseFailures.length} case failures.`, '', `Run at ${r.run_at}, ${(r.durationMs / 1000).toFixed(1)} s. Commit: ${r.git_commit}.`, `Environment: ${r.environment.os} (${r.environment.arch}), tmp filesystem ${r.environment.tmpFilesystem}, Node ${r.environment.node}, SQLite ${r.environment.sqlite}, ${r.environment.cpu}.`, `Seeds: ${r.seeds.length ? r.seeds.join(', ') : 'none (deterministic)'}`, '', `Reproduce: \`${r.repro}\``, '', '## Tests', '', '| Status | Test |', '|---|---|', ...r.tests.map(t => `| ${t.status} | ${t.name.replace(/\|/g, '\\|')} |`), '', '## Not verified', '', '| Status | Item | Reason |', '|---|---|---|', ...spec.gaps.map(g => `| ${g.status} | ${g.item} | ${g.reason} |`), '', '## Limitations', '', ...spec.limitations.map(l => `- ${l}`)];
  return lines.join('\n');
}
export function summarize(report: SuiteReport): void {
  console.log(`${report.suite}: ${report.status} (${report.counts.pass}/${report.counts.total} tests, ${report.cases} cases, ${(report.durationMs / 1000).toFixed(1)} s)`);
  for (const t of report.tests.filter(t => t.status !== 'PASS')) { console.log(`  ${t.status}: ${t.name}`); if (t.status === 'FAIL' && t.detail) console.log(t.detail.split('\n').slice(0, 40).map(l => `      ${l}`).join('\n')); }
  if (report.status !== 'PASS') process.exitCode = 1;
}
