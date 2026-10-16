import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../packages/core/vault.js';
import { AdaptiveStore } from '../packages/adaptive/state.js';
import { systemTimeZone, localParts, formatHHMM } from '../packages/adaptive/clock.js';

/**
 * Unattended daily profile cycle with a REAL worker process, the REAL clock and a LOCAL Ollama model, on a disposable vault of SYNTHETIC conversation text.
 * Resource pressure is simulated by setting the governor's load ceiling below the machine's load; it is released later and the deferred cycle must then run
 * by itself, with nothing calling tick manually. Nothing is sent to any external provider: the script refuses to run unless the model is loopback Ollama.
 * Not exercised: launchd/systemd registration, a multi-day schedule, autoAccept.
 */
const modelName = process.env.MDB_TEST_MODEL; const baseUrl = process.env.MDB_TEST_BASE_URL ?? 'http://127.0.0.1:11434/v1';
if (!modelName) throw new Error('Explicit local model configuration required: set MDB_TEST_MODEL (for example gpt-oss:latest); the provider is fixed to loopback Ollama');
if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(baseUrl)) throw new Error('MDB_TEST_BASE_URL must be a loopback address: private-looking conversation text is never sent to an external provider');
const CLI = path.resolve('bin/mdb.js'); const tz = systemTimeZone();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-sched-ollama-'));
const run = (args: string[]) => new Promise<string>((resolve, reject) => { const c = spawn(process.execPath, [CLI, '--root', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; }); c.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${args.join(' ')} -> ${code}: ${err || out}`))); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = []; const check = (name: string, pass: boolean, detail?: unknown) => { checks.push({ name, pass, ...(detail !== undefined ? { detail } : {}) }); };
let worker: ChildProcess | undefined;
try {
  await run(['init']); const vault = new Vault(root); await vault.createWorkspace('alpha', 'synthetic scheduler evaluation');
  await run(['model', 'set', '--api', baseUrl, '--model', modelName, '--max-output-tokens', '8000']);
  const say = (body: string, at: string) => vault.put({ scope: { type: 'workspace', workspaceId: 'alpha' }, kind: 'observation', title: 'User message', body, metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message', eventTime: at } });
  await say('From now on write commit messages in the imperative mood. Always run the linter before committing.', '2026-10-07T10:00:00.000Z');
  await say('I prefer small pull requests, and I want TODO comments to carry a ticket id.', '2026-10-07T10:05:00.000Z');
  const store = new AdaptiveStore(root);
  await run(['intelligence', 'schedule', 'configure', '--enable', '--mode', 'fixed', '--time', formatHHMM(localParts(new Date(Date.now() + 75_000), tz).minutes), '--timezone', tz, '--quiet-start', '00:00', '--quiet-end', '23:59', '--inactivity-minutes', '0', '--auto-accept', 'none']);
  await store.setConfig({ resources: { maxLoadAverage: 0.0001 } } as never); // simulated pressure: any real load is above this ceiling
  const before = (await store.cycles()).length;
  worker = spawn(process.execPath, [CLI, '--root', root, 'intelligence', 'schedule', 'worker', '--interval-s', '5'], { stdio: ['ignore', 'ignore', 'ignore'] });
  const pressureDeadline = Date.now() + 5 * 60_000; let skipped = false;
  while (Date.now() < pressureDeadline) { await sleep(5000); const events = await store.events(500); if (events.some(e => e.type === 'dream_skipped' && /RESOURCE_PRESSURE|load average/.test(String(e.reason)))) { skipped = true; break; } }
  const proposalsDuring = (await new (await import('../packages/intelligence/index.js')).IntelligenceEngine(vault, undefined).proposals()).length;
  check('under resource pressure the due cycle is deferred with an explicit reason, not run and not silently dropped', skipped && (await store.cycles()).length === before && proposalsDuring === 0, { skipped, cycles: (await store.cycles()).length - before, proposalsDuring });
  await sleep(15_000); check('it stays deferred while the pressure lasts (no cycle, no proposals)', (await store.cycles()).length === before);
  await store.setConfig({ resources: { maxLoadAverage: 10_000, maxRssMiB: 100_000 } } as never); // release both load and RSS ceilings for this model process
  const releasedAt = Date.now(); const doneDeadline = releasedAt + 12 * 60_000; let completed: Awaited<ReturnType<typeof store.cycles>>[number] | undefined;
  while (Date.now() < doneDeadline) { await sleep(5000); completed = (await store.cycles()).find(c => c.state === 'COMPLETED'); if (completed) break; }
  const allCycles = await store.cycles(); check('after the pressure subsides the deferred cycle runs by itself and COMPLETES (real worker, real clock, local Ollama)', !!completed, { waitedMs: Date.now() - releasedAt, states: allCycles.map(c => c.state), errors: allCycles.map(c => c.error), dream: allCycles.map(c => ({ status: c.dream.status, skipped: c.dream.skipped })) });
  const engine = new (await import('../packages/intelligence/index.js')).IntelligenceEngine(vault, undefined); const proposals = (await engine.proposals()).filter(p => p.input.kind === 'user_insight');
  check('the cycle produced reviewable insight proposals from the workspace conversation, each with evidence from alpha', proposals.length >= 2 && proposals.every(p => (p.input.evidence?.length ?? 0) >= 1), { proposals: proposals.map(p => ({ claim: p.input.body, status: p.status, spans: p.input.evidence?.map(e => e.span) })) });
  check('nothing was accepted automatically (autoAccept none)', proposals.every(p => p.status === 'pending' || p.status === 'rejected') && (await vault.listDocuments()).filter(d => d.kind === 'user_insight' && d.status === 'accepted').length === 0);
  const events = await store.events(500); const dailyStarts = events.filter(e => e.type === 'dream_started' && e.trigger === 'daily');
  const pressureSkips = events.filter(e => e.type === 'dream_skipped' && /RESOURCE_PRESSURE|load average|rss/i.test(String(e.reason)));
  const dailyCycles = (await store.cycles()).filter(c => c.kind === 'scheduled' && c.localDate === localParts(new Date(), tz).date);
  const startCycleIds = new Set(dailyStarts.map(e => e.cycleId));
  check('pressure is skipped before start; retries retain one cycle ID and one cycle for the local date', pressureSkips.length > 0 && dailyStarts.length > 0 && events.indexOf(pressureSkips[0]!) < events.indexOf(dailyStarts[0]!) && dailyCycles.length === 1 && startCycleIds.size === 1, { pressureSkips: pressureSkips.length, starts: dailyStarts.length, cycleIds: [...startCycleIds], dailyCycles: dailyCycles.map(c => ({ id: c.id, state: c.state })), types: events.map(e => `${e.type}${e.reason ? ':' + String(e.reason).slice(0, 40) : ''}`).slice(-12) });
  check('journal verifies', (await new Vault(root).verify()).ok === true);
} finally { try { worker?.kill('SIGTERM'); } catch { /* gone */ } await sleep(500); }
const status = checks.every(x => x.pass) ? 'PASS' : 'FAIL'; const id = new Date().toISOString().replace(/[:.]/g, '-');
const report = { id, status, method: 'real CLI worker process, real clock, daily start 75 s ahead, resource pressure simulated through the governor ceiling then released, local Ollama, synthetic conversation text, disposable vault', model: `ollama:${modelName}`, osServiceInstalled: false, checks };
await fs.mkdir('verification/dream', { recursive: true }); await fs.writeFile(`verification/dream/scheduler-ollama-${id}.json`, JSON.stringify(report, null, 2) + '\n'); await fs.writeFile('verification/dream/scheduler-ollama-latest.json', JSON.stringify(report, null, 2) + '\n');
await fs.rm(root, { recursive: true, force: true });
console.log(JSON.stringify({ status, checks: checks.map(x => [x.name, x.pass, x.pass ? undefined : x.detail]) }, null, 1)); process.exitCode = status === 'PASS' ? 0 : 1;
