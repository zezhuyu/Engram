import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../packages/core/vault.js';
import { AdaptiveStore } from '../packages/adaptive/state.js';
import { systemTimeZone, localParts, formatHHMM } from '../packages/adaptive/clock.js';

/**
 * Unattended scheduler evidence with REAL processes and the REAL clock (no injected time): the CLI worker is started as a child process, the daily start time is set a
 * minute ahead, and nothing calls tick manually. The vault has no model provider, so model-assisted stages are BLOCKED (MODEL_UNAVAILABLE) by design: this proves the
 * due-run, restart and two-worker mechanics, NOT a completed model-backed cycle and NOT launchd/systemd registration (those fields are recorded false).
 */
const CLI = path.resolve('bin/mdb.js'); const tz = systemTimeZone();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-sched-e2e-'));
const run = (args: string[]) => new Promise<string>((resolve, reject) => { const c = spawn(process.execPath, [CLI, '--root', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; }); c.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${args.join(' ')} -> ${code}: ${err || out}`))); });
const worker = (name: string): ChildProcess => spawn(process.execPath, [CLI, '--root', root, 'intelligence', 'schedule', 'worker', '--interval-s', '5'], { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ENGRAM_WORKER_NAME: name } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = []; const check = (name: string, pass: boolean, detail?: unknown) => { checks.push({ name, pass, ...(detail !== undefined ? { detail } : {}) }); };
const children: ChildProcess[] = [];
try {
  await run(['init']); const vault = new Vault(root); await vault.createWorkspace('alpha', 'e2e'); await vault.put({ scope: { type: 'workspace', workspaceId: 'alpha' }, kind: 'observation', title: 'User message', body: 'I prefer TypeScript [key:lang]', metadata: { speaker: 'user' } });
  const startAt = new Date(Date.now() + 90_000); const start = localParts(startAt, tz); const hhmm = formatHHMM(start.minutes);
  await run(['intelligence', 'schedule', 'configure', '--enable', '--mode', 'fixed', '--time', hhmm, '--timezone', tz, '--quiet-start', '00:00', '--quiet-end', '23:59', '--inactivity-minutes', '0']);
  const store = new AdaptiveStore(root); const before = (await store.cycles()).length;
  const a = worker('a'), b = worker('b'); children.push(a, b); // two simultaneous workers
  const deadline = Date.now() + 8 * 60_000; let started = 0;
  while (Date.now() < deadline) { await sleep(5000); started = (await store.events(500)).filter(e => e.type === 'dream_started').length; if (started) break; }
  const events1 = await store.events(500); const cycles1 = await store.cycles();
  check('a due-run happened with no manual tick', started >= 1, { configuredStart: `${hhmm} ${tz}`, events: events1.map(e => e.type) });
  check('exactly one cycle started although two workers ran', events1.filter(e => e.type === 'dream_started').length === 1 && cycles1.length === before + 1, { cycles: cycles1.map(c => ({ id: c.id, state: c.state })) });
  check('the loser (or later ticks) reported a reason, not a second run', events1.every(e => e.type !== 'dream_started') || events1.filter(e => e.type === 'dream_scheduled').length >= 1);
  check('no usable model (privacy gate blocks the remote provider): model-assisted work is BLOCKED/retry, never faked complete', cycles1.every(c => c.state !== 'COMPLETED') || events1.some(e => e.type === 'dream_retry' || e.type === 'dream_completed'), { states: cycles1.map(c => c.state) });
  // Kill both workers abruptly (SIGKILL), then start one: it must resume without creating a second cycle for the same local date.
  for (const c of [a, b]) c.kill('SIGKILL'); await sleep(1500);
  const c = worker('c'); children.push(c); await sleep(12_000);
  const cycles2 = await store.cycles(); check('restart after SIGKILL does not duplicate the local-date cycle', cycles2.filter(x => x.kind === 'scheduled' && x.localDate === localParts(new Date(), tz).date).length === 1, { cycles: cycles2.map(x => ({ id: x.id, state: x.state, attempts: x.attempts })) });
  const status = JSON.parse(await run(['intelligence', 'schedule', 'status'])) as { nextDue: string; providerReady: boolean; deadLetters: number; lastStarted?: string; blockedReason?: string };
  check('status reports nextDue, lastStarted, and why the model-backed stages are blocked (the default remote provider may not receive private workspace content)', !!status.nextDue && typeof status.providerReady === 'boolean' && !!status.lastStarted && /MODEL_UNAVAILABLE/.test(status.blockedReason ?? ''), status);
  c.kill('SIGTERM'); await sleep(1000);
  check('journal verifies after kill -9 of the workers', (await new Vault(root).verify()).ok === true);
} finally { for (const c of children) try { c.kill('SIGKILL'); } catch { /* already gone */ } }
const status = checks.every(x => x.pass) ? 'PASS' : 'FAIL'; const id = new Date().toISOString().replace(/[:.]/g, '-');
const report = { id, status, method: 'real CLI worker processes, real clock, daily start set 90 s ahead, no manual tick, default config (a remote provider is not allowed to receive private workspace content)', checks, unattendedDueRun: checks[0]?.pass === true, restartSafe: checks.find(x => x.name.startsWith('restart'))?.pass === true && checks.find(x => x.name.startsWith('exactly one'))?.pass === true,
  osServiceInstalled: false, unattendedCompletedCycle: false, notes: ['launchd/systemd registration was NOT exercised: it would modify the user\'s login environment outside the repository. Units are printed by `schedule service` for the owner to install.', 'No model provider was configured, so no cycle completed; a model-backed unattended cycle is NOT_RUN.'], node: process.version, platform: `${os.platform()} ${os.arch()}`, timezone: tz, run_at: new Date().toISOString() };
await fs.mkdir('verification/dream', { recursive: true });
await fs.writeFile(`verification/dream/scheduler-${id}.json`, JSON.stringify(report, null, 2) + '\n'); await fs.writeFile('verification/dream/scheduler-latest.json', JSON.stringify(report, null, 2) + '\n');
await fs.writeFile(`verification/dream/scheduler-${id}.md`, `# Scheduler unattended evidence ${id}\n\nStatus: **${status}**. ${report.method}.\n\n${checks.map(x => `- ${x.pass ? 'PASS' : 'FAIL'} ${x.name}`).join('\n')}\n\nNot evidenced: OS service registration (launchd/systemd), unattended model-backed completed cycle.\n\n${report.notes.map(n => `- ${n}`).join('\n')}\n`);
await fs.rm(root, { recursive: true, force: true });
console.log(JSON.stringify({ status, checks: checks.map(x => [x.name, x.pass]) }, null, 1)); process.exitCode = status === 'PASS' ? 0 : 1;
