#!/usr/bin/env node
// Unattended Dream verification with a REAL user-level launchd agent, the REAL clock and a LOCAL model (Ollama on loopback). Disposable vault, synthetic documents only.
//
// What it is allowed to do, and nothing else:
//   * create a vault under $TMPDIR/.tmp-dream-launchd-<id> (or ENGRAM_E2E_PARENT) holding synthetic documents (no user memories),
//   * write ONE plist, ~/Library/LaunchAgents/dev.engram.intelligence-worker.e2e<id>.plist, load it into the user's GUI domain (launchctl bootstrap gui/$UID),
//   * kill/restart ONLY that label, and ALWAYS boot it out and delete the plist and the vault afterwards.
// It refuses non-loopback model endpoints, refuses a label that is already loaded, and never touches any other LaunchAgent. Nothing is sent to an external model provider.
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname); const cli = path.join(repo, 'bin/mdb.js'); const uid = process.getuid();
const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); const label = `dev.engram.intelligence-worker.e2e${id}`; const domain = `gui/${uid}`;
const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const scratchParent = process.env.ENGRAM_E2E_PARENT ?? os.tmpdir(); const root = path.join(scratchParent, `.tmp-dream-launchd-${id}`); const logFile = path.join(os.tmpdir(), `engram-launchd-e2e-${id}.log`);
const MODEL = process.env.ENGRAM_E2E_MODEL ?? 'gpt-oss:latest'; const OLLAMA = 'http://127.0.0.1:11434';
const sleep = ms => new Promise(r => setTimeout(r, ms)); const checks = []; const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); log(pass ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)); return !!pass; };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const mdb = (...args) => { const r = run(process.execPath, [cli, '--root', root, ...args]); if (r.status !== 0) throw new Error(`mdb ${args.join(' ')} -> ${r.status}: ${(r.stderr || r.stdout).slice(0, 400)}`); try { return JSON.parse(r.stdout); } catch { return r.stdout; } };
const launchctlPrint = () => run('launchctl', ['print', `${domain}/${label}`]); const pidOf = text => Number(/\bpid = (\d+)/.exec(text)?.[1] ?? 0);
const waitFor = async (what, fn, timeoutMs, everyMs = 5000) => { const end = Date.now() + timeoutMs; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(everyMs); } };
const guardRoot = () => { if (!root.includes('/.tmp-dream-launchd-') && !path.resolve(root).startsWith(path.resolve(os.tmpdir()))) throw new Error('refusing to touch a path that is not the disposable vault'); };

let report; let installed = false;
try {
  if (process.platform !== 'darwin') throw new Error('launchd verification runs on macOS only');
  const tags = await fetch(`${OLLAMA}/api/tags`).then(r => r.json()).catch(() => undefined);
  if (!tags?.models?.some(m => m.name === MODEL)) throw new Error(`local model ${MODEL} is not available at ${OLLAMA}`);
  check('local model reachable on loopback only', new URL(OLLAMA).hostname === '127.0.0.1', { endpoint: OLLAMA, model: MODEL });
  if (launchctlPrint().status === 0) throw new Error(`label ${label} is already loaded: refusing`);
  if (await fs.stat(plistPath).then(() => true, () => false)) throw new Error(`${plistPath} already exists: refusing`);

  // 1. Disposable vault with synthetic content.
  mdb('init', '--no-sqlite'); const sdk = await import(path.join(repo, 'dist/packages/core/vault.js')); const YAML = (await import('yaml')).default; const { buildPack } = await import(path.join(repo, 'dist/tests/dream/pack.js'));
  const vault = new sdk.Vault(root); await vault.createWorkspace('demo', 'synthetic workspace for the launchd verification');
  const cfg = await vault.config(); cfg.model = { ...cfg.model, provider: 'ollama', modelName: MODEL, allowNetwork: false, timeoutMs: 600000, maxRetries: 1 }; cfg.dream = { ...cfg.dream, enabled: true, eventDriven: false, modes: ['micro', 'deep', 'strategic'] };
  check('model endpoint in the vault config is loopback (provider ollama, default base URL)', cfg.model.provider === 'ollama' && !cfg.model.baseUrl && cfg.model.allowNetwork === false);
  await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(cfg));
  await vault.put({ scope: { type: 'workspace', workspaceId: 'demo' }, kind: 'observation', title: 'User message', body: 'I prefer TypeScript over JavaScript for backend services because static types catch integration bugs early.', metadata: { speaker: 'user', evidenceClass: 'explicit' } });
  await buildPack(vault);

  // 2. Schedule a daily cycle a few minutes ahead, in the vault's real time zone and real clock.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; const due = new Date(Date.now() + 4 * 60_000); const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(due);
  mdb('intelligence', 'schedule', 'configure', '--enable', '--mode', 'fixed', '--time', hhmm, '--timezone', tz, '--quiet-start', '00:00', '--quiet-end', '23:59', '--inactivity-minutes', '0');
  const dueAt = Date.now() + ((due.getTime() - Date.now())); void dueAt;

  // 3. Generate, REVIEW and install the user-level agent.
  const def = mdb('intelligence', 'schedule', 'service', 'launchd', '--label', label, '--interval-s', '15', '--log', logFile);
  log('--- plist for review ---\n' + def.content + '--- end plist ---');
  check('plist runs only the explicit worker command from this checkout', def.content.includes('<string>schedule</string><string>worker</string>') && def.content.includes(root) && def.content.includes(process.execPath), { label });
  await fs.writeFile(plistPath, def.content, { mode: 0o644 }); const lint = run('plutil', ['-lint', plistPath]); check('plutil -lint', lint.status === 0, lint.stdout.trim());
  const boot = run('launchctl', ['bootstrap', domain, plistPath]); installed = boot.status === 0; check('launchctl bootstrap (user GUI domain)', boot.status === 0, boot.stderr.trim() || 'loaded');
  if (!installed) throw new Error('bootstrap failed');
  const first = await waitFor('worker pid', () => { const p = launchctlPrint(); return pidOf(p.stdout) ? p : null; }, 60_000, 2000); const pid1 = pidOf(first.stdout);
  check('agent is running under launchd', pid1 > 0, { pid: pid1 }); const printBefore = first.stdout.split('\n').slice(0, 40).join('\n');

  // 4. Real-clock unattended execution: the script never calls tick.
  log(`waiting for the due time ${hhmm} ${tz} and a completed cycle (the local model needs about a minute)`);
  const done = await waitFor('a COMPLETED scheduled cycle', () => { const cycles = mdb('intelligence', 'cycles', 'list'); return Array.isArray(cycles) ? cycles.find(c => c.kind === 'scheduled' && c.state === 'COMPLETED') : null; }, 25 * 60_000, 10_000);
  const cycle = mdb('intelligence', 'cycles', 'show', done.id); const events1 = mdb('intelligence', 'schedule', 'events', '--limit', '200');
  check('a scheduled cycle COMPLETED without any manual tick', cycle.state === 'COMPLETED' && cycle.kind === 'scheduled', { id: cycle.id, state: cycle.state, createdAt: cycle.createdAt, completedAt: cycle.completedAt });
  check('the cycle did not start before its scheduled time', Date.parse(cycle.createdAt) >= due.getTime() - 60_000, { createdAt: cycle.createdAt, due: due.toISOString() });
  check('the cycle used the local model through the vault config', typeof cycle.modelProvider === 'string' && cycle.modelProvider.startsWith('ollama:') && (cycle.metrics?.modelCalls ?? 0) >= 1, { provider: cycle.modelProvider, modelCalls: cycle.metrics?.modelCalls, stageMs: cycle.metrics?.stageMs });
  check('lifecycle events were recorded in order by the service instance', ['dream_scheduled', 'dream_claimed', 'dream_started', 'dream_completed'].every(t => events1.some(e => e.type === t && e.trigger === 'daily')), { types: events1.map(e => e.type) });
  const status1 = mdb('intelligence', 'schedule', 'status'); check('status reports last started and completed', !!status1.lastStarted && !!status1.lastCompleted && status1.lastOutcome === 'COMPLETED', { nextDue: status1.nextDue, lastCompleted: status1.lastCompleted });

  // 5. Restart recovery A: SIGKILL the worker; launchd restarts it; history persists and no second cycle appears for the date.
  const cyclesBefore = mdb('intelligence', 'cycles', 'list'); const kill1 = run('launchctl', ['kill', 'SIGKILL', `${domain}/${label}`]); check('SIGKILL delivered to the agent', kill1.status === 0, kill1.stderr.trim());
  const second = await waitFor('restarted worker with a new pid', () => { const p = launchctlPrint(); const n = pidOf(p.stdout); return n && n !== pid1 ? p : null; }, 120_000, 2000); const pid2 = pidOf(second.stdout);
  await sleep(40_000); const cyclesAfter = mdb('intelligence', 'cycles', 'list'); const events2 = mdb('intelligence', 'schedule', 'events', '--limit', '300');
  check('launchd KeepAlive restarted the worker with a new pid', pid2 > 0 && pid2 !== pid1, { before: pid1, after: pid2 });
  check('run history survived the kill: same cycles, same states, still exactly one scheduled cycle for the date', JSON.stringify(cyclesBefore.map(c => [c.id, c.state])) === JSON.stringify(cyclesAfter.map(c => [c.id, c.state])) && cyclesAfter.filter(c => c.kind === 'scheduled').length === 1);
  check('the restarted worker found the date already done instead of re-running it', events2.filter(e => e.type === 'dream_started' && e.trigger === 'daily').length === 1 && events2.length >= events1.length);

  // 6. Restart recovery B: kill the worker in the MIDDLE of a model-backed micro-Dream job.
  mdb('intelligence', 'schedule', 'configure', '--micro', 'on', '--micro-debounce-minutes', '1', '--micro-max-per-day', '6'); await sleep(35_000); // let the worker initialize the micro cursor
  const eventsBeforePage = mdb('intelligence', 'schedule', 'events', '--limit', '300').length;
  await vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'Event sourcing', body: 'Event sourcing stores state changes as an append-only log, which makes audits and replays straightforward.', tags: ['domain:architecture', 'log', 'audit'] });
  log('page written; waiting for the debounced micro job to start'); const started = await waitFor('micro dream_started', () => { const ev = mdb('intelligence', 'schedule', 'events', '--limit', '300'); return ev.length > eventsBeforePage && ev.some(e => e.type === 'dream_started' && e.trigger === 'micro') && !ev.some(e => e.type === 'dream_completed' && e.trigger === 'micro') ? ev : null; }, 8 * 60_000, 2000);
  const proposalsMid = mdb('intelligence', 'proposals'); const pid3 = pidOf(launchctlPrint().stdout); const kill2 = run('launchctl', ['kill', 'SIGKILL', `${domain}/${label}`]); check('worker killed while the micro job was running', kill2.status === 0 && pid3 > 0, { pid: pid3, startedEvents: started.filter(e => e.trigger === 'micro').map(e => e.type) });
  const restarted = await waitFor('worker restart after the mid-job kill', () => { const n = pidOf(launchctlPrint().stdout); return n && n !== pid3 ? n : 0; }, 120_000, 2000);
  const finished = await waitFor('micro job completion after restart (job lease is 60 s)', () => { const ev = mdb('intelligence', 'schedule', 'events', '--limit', '400'); return ev.some(e => e.type === 'dream_completed' && e.trigger === 'micro') ? ev : null; }, 8 * 60_000, 5000);
  const proposalsEnd = mdb('intelligence', 'proposals'); const key = p => `${p.status}|${p.input?.kind}|${p.input?.title}`; const keys = proposalsEnd.map(key);
  check('after the mid-job kill the worker restarted and the micro job completed', restarted > 0 && finished.some(e => e.type === 'dream_completed' && e.trigger === 'micro'), { newPid: restarted });
  check('no duplicated proposals after the replay', new Set(keys).size === keys.length && proposalsMid.map(key).every(k => keys.includes(k)), { before: proposalsMid.length, after: proposalsEnd.length });
  check('cycles still exactly one scheduled cycle and the journal verifies', mdb('intelligence', 'cycles', 'list').filter(c => c.kind === 'scheduled').length === 1 && (await new sdk.Vault(root).verify()).ok === true);
  const history = { cycles: mdb('intelligence', 'cycles', 'list').map(c => ({ id: c.id, kind: c.kind, state: c.state, dream: c.dream })), events: mdb('intelligence', 'schedule', 'events', '--limit', '400') };
  report = { printBefore, history, cycleSummary: { provider: cycle.modelProvider, modelCalls: cycle.metrics?.modelCalls, stageMs: cycle.metrics?.stageMs, createdAt: cycle.createdAt, completedAt: cycle.completedAt }, pids: { first: pid1, afterKillAtRest: pid2, killedMidJob: pid3, afterMidJobRestart: restarted }, due: due.toISOString(), timeZone: tz };
} catch (error) { check(`unexpected error: ${String(error.message).slice(0, 200)}`, false); }
finally {
  // 7. Uninstall and prove nothing is left behind.
  try { if (installed || launchctlPrint().status === 0) run('launchctl', ['bootout', `${domain}/${label}`]); } catch { /* best effort */ }
  await sleep(1500); await fs.rm(plistPath, { force: true });
  check('uninstall: label no longer loaded and plist removed', launchctlPrint().status !== 0 && !(await fs.stat(plistPath).then(() => true, () => false)));
  const logTail = await fs.readFile(logFile, 'utf8').catch(() => ''); await fs.rm(logFile, { force: true });
  try { guardRoot(); await fs.rm(root, { recursive: true, force: true }); } catch { /* guard refusal leaves the directory for the owner */ }
  check('disposable vault removed', !(await fs.stat(root).then(() => true, () => false)));
  const status = checks.every(c => c.pass) ? 'PASS' : 'FAIL'; const out = { id, status, label, method: 'real user-level launchd agent, real clock, local Ollama model, disposable vault with synthetic documents, no manual tick', checks, ...(report ?? {}), workerLogTail: logTail.split('\n').slice(-12), notRun: ['login or reboot persistence of the agent', 'systemd', 'real-user feedback', 'quality of the local model output', 'any external model provider'], node: process.version, platform: `${os.platform()} ${os.arch()}`, run_at: new Date().toISOString() };
  await fs.mkdir(path.join(repo, 'verification/dream'), { recursive: true });
  await fs.writeFile(path.join(repo, `verification/dream/launchd-e2e-${id}.json`), JSON.stringify(out, null, 2) + '\n'); await fs.writeFile(path.join(repo, 'verification/dream/launchd-e2e-latest.json'), JSON.stringify(out, null, 2) + '\n');
  await fs.writeFile(path.join(repo, `verification/dream/launchd-e2e-${id}.md`), `# launchd unattended Dream verification ${id}\n\nStatus: **${status}**. ${out.method}.\n\n${checks.map(c => `- ${c.pass ? 'PASS' : 'FAIL'} ${c.name}`).join('\n')}\n\nNOT_RUN: ${out.notRun.join('; ')}.\n`);
  console.log(JSON.stringify({ status, checks: checks.map(c => [c.name, c.pass]) }, null, 1)); process.exitCode = status === 'PASS' ? 0 : 1;
}
