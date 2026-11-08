// Fault tests for remote capture (run on the CLIENT machine; the server runs deep-server.mjs and fault-proxy.mjs on another machine).
//   lossy path (no root, connection level): resets, replies lost after the server committed, delay, black hole, truncated replies, and random mixes
//   clock skew (libfaketime on the client process and on the server process): small skew, large skew, expired and not-yet-valid certificates, server clock moved and moved back
//   cable: SCENARIO=cable waits for the owner to physically unplug and replug the cable while it keeps writing
// Environment: URL REG_A TOKEN_A HOOK (server control URL with token) PROXY_CTL (fault proxy control URL with token) FAKETIME_LIB, NODE_EXTRA_CA_CERTS (set at launch), OUT, SCENARIO (all|loss|skew|cable)
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const E = process.env, root = new URL('../../', import.meta.url).pathname;
const { queueRemoteCapture, drainRemoteCaptureSpool } = await import(new URL('dist/packages/memory/remote-spool.js', `file://${root}`).href);
for (const k of ['URL', 'REG_A', 'TOKEN_A', 'HOOK', 'PROXY_CTL']) if (!E[k]) throw new Error(`${k} is required`);
const sleep = ms => new Promise(r => setTimeout(r, ms)); const results = []; const stamp = Date.now().toString(36).slice(-4).toUpperCase(); const base = new URL(E.URL); const capture = `${base.origin}/capture`;
const rec = (id, desc, ok, detail = '') => { results.push({ id, desc, status: ok ? 'PASS' : 'FAIL', detail: String(detail).slice(0, 220) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${desc} | ${String(detail).slice(0, 150)}`); };
const hook = async p => (await fetch(`${E.HOOK}/${p}`, { signal: AbortSignal.timeout(130_000) })).json();
const proxy = async mode => (await fetch(`${E.PROXY_CTL}/mode/${mode}`)).json();
const probe = async () => { try { return (await fetch(capture, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })).status; } catch (e) { return `error:${e.cause?.code ?? e.code ?? e.name}`; } };
const marker = (run, kind, n) => `PHYS-${run}-${kind}-${n}`;
const payload = (run, kind, n) => ({ hook_event_name: 'UserPromptSubmit', session_id: `fault-${run}`, cwd: '/w', prompt_id: marker(run, kind, n), prompt: `${marker(run, kind, n)} fault test` });
const queue = (run, kind, n, dir, tok = E.TOKEN_A) => queueRemoteCapture({ url: E.URL, registrationId: E.REG_A, token: tok, payload: payload(run, kind, n), directory: dir });
const spoolCount = async dir => (await fs.readdir(dir).catch(() => [])).filter(n => n.endsWith('.json')).length;
const dirFor = n => fs.mkdtemp(path.join(os.tmpdir(), `fault-${n}-`)); const run = id => `${id}${stamp}`;
async function drainAll(dir, { limit = 100, budgetMs = 300_000 } = {}) { let delivered = 0, left = 1; const end = Date.now() + budgetMs; while (left && Date.now() < end) { const d = await drainRemoteCaptureSpool({ token: E.TOKEN_A, directory: dir, limit }); delivered += d.delivered; left = d.queued; if (left) await sleep(500); } return { delivered, left }; }
// The server acknowledges before it commits, so a count is final only when it stops changing.
const server = async r => { let last = -1, stable = 0, s; for (let i = 0; i < 60; i++) { s = await hook(`markers?run=${r}`); if (s.committed === last) { if (++stable >= 3) return s; } else stable = 0; last = s.committed; await sleep(3000); } return s; };
// A client process whose clock is skewed by libfaketime: queue n events, then drain for a while; prints a JSON line.
function skewedClient(offset, r, n, dir) {
  const code = `const { queueRemoteCapture, drainRemoteCaptureSpool } = await import(${JSON.stringify(new URL('dist/packages/memory/remote-spool.js', `file://${root}`).href)}); const E = process.env; let last = {};
for (let i = 1; i <= ${n}; i++) last = await queueRemoteCapture({ url: E.URL, registrationId: E.REG_A, token: E.TOKEN_A, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'skew-${r}', cwd: '/w', prompt_id: 'PHYS-${r}-skew-' + i, prompt: 'PHYS-${r}-skew-' + i + ' skew test' }, directory: ${JSON.stringify(dir)} }).catch(e => ({ error: String(e.message).slice(0, 80) }));
for (let k = 0; k < 6; k++) { last = await drainRemoteCaptureSpool({ token: E.TOKEN_A, directory: ${JSON.stringify(dir)} }); if (!last.queued) break; await new Promise(r => setTimeout(r, 500)); }
console.log(JSON.stringify({ now: new Date().toISOString(), ...last }));`;
  const env = { ...E, ...(offset ? { DYLD_INSERT_LIBRARIES: E.FAKETIME_LIB, DYLD_FORCE_FLAT_NAMESPACE: '1', FAKETIME: offset } : {}) };
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 240_000 });
  try { return JSON.parse(p.stdout.trim().split('\n').pop()); } catch { return { error: (p.stderr || p.stdout).slice(0, 160) }; }
}
const scenario = E.SCENARIO ?? 'all';

if (scenario === 'all' || scenario === 'loss') {
  for (const [mode, n] of [['reset', 60], ['lose-response', 60], ['delay', 25], ['blackhole', 25], ['truncate', 60]]) {
    const r = run(`L${mode.replace('-', '').slice(0, 3).toUpperCase()}`), dir = await dirFor(mode); await proxy(mode); let maxMs = 0;
    for (let i = 1; i <= n; i++) { const t = Date.now(); await queue(r, mode, i, dir).catch(() => undefined); maxMs = Math.max(maxMs, Date.now() - t); }
    const buffered = await spoolCount(dir); await proxy('ok'); const out = await drainAll(dir); const s = await server(r);
    rec(`F-${mode}`, `path mode "${mode}": ${n} writes never block longer than the hook budget, and after recovery every event is committed exactly once`, maxMs < 5000 && out.left === 0 && s.unique === n && !s.duplicates.length, `maxWriteMs=${maxMs} bufferedDuringFault=${buffered} unique=${s.unique}/${n} dup=${s.duplicates.length}`);
  }
  { const r = run('LMIX'), dir = await dirFor('mix'); const modes = ['ok', 'reset', 'lose-response', 'delay', 'blackhole', 'truncate']; let written = 0, next = Date.now(), maxMs = 0; const end = Date.now() + 90_000;
    while (Date.now() < end) { if (Date.now() >= next) { await proxy(modes[Math.floor(Math.random() * modes.length)]); next = Date.now() + 3000; } const t = Date.now(); written++; await queue(r, 'mix', written, dir).catch(() => undefined); maxMs = Math.max(maxMs, Date.now() - t); await sleep(300); }
    await proxy('ok'); const out = await drainAll(dir); const s = await server(r); const stats = await (await fetch(`${E.PROXY_CTL}/stats`)).json();
    rec('F-mixed', `90 s of randomly changing path faults with ${written} writes: all committed exactly once`, maxMs < 5000 && out.left === 0 && s.unique === written && !s.duplicates.length, `unique=${s.unique}/${written} dup=${s.duplicates.length} maxWriteMs=${maxMs} proxy=${JSON.stringify(stats.stats)}`); }
}

if (scenario === 'all' || scenario === 'skew') {
  await proxy('ok');
  // The test certificate is valid for two days from the moment it was issued, so the offsets are chosen around that window.
  // CS3 and CS8 are expected to show a known limitation: the server rejects events stamped more than 24 hours in the future (packages/memory/capture.ts), after it has already acknowledged them.
  for (const [id, offset, expectDelivered, why] of [['CS1', '+10m', true, 'client clock 10 minutes ahead'], ['CS2', '-5m', true, 'client clock 5 minutes behind'], ['CS9', '+20h', true, 'client clock 20 hours ahead (inside the server 24 h future tolerance)'], ['CS8', '+30h', true, 'client clock 30 hours ahead (outside the server 24 h future tolerance, certificate still valid)'], ['CS3', '+3d', false, 'client clock 3 days ahead: the server certificate has expired from its point of view'], ['CS4', '-3d', false, 'client clock 3 days behind: the certificate is not yet valid']]) {
    const r = run(id), dir = await dirFor(id); const first = skewedClient(offset, r, 8, dir);
    let ok, detail;
    if (expectDelivered) { const s = await server(r); ok = (await spoolCount(dir)) === 0 && s.unique === 8 && !s.duplicates.length; detail = `skewed client: ${JSON.stringify(first)} | committed ${s.unique}/8 dup ${s.duplicates.length}`; const t = await hook(`times?run=${r}`); const ahead = t.map(x => Date.parse(x.createdAt) - Date.now()); detail += ` | server createdAt minus now: ${Math.round(Math.min(...ahead) / 1000)}..${Math.round(Math.max(...ahead) / 1000)} s`; }
    else { const held = await spoolCount(dir); const s0 = await server(r); const out = await drainAll(dir); const s = await server(r); ok = held === 8 && s0.unique === 0 && out.left === 0 && s.unique === 8 && !s.duplicates.length; detail = `skewed client delivered ${first.delivered ?? 0}, held ${held}/8 (fail-open, nothing sent); after the clock is right: committed ${s.unique}/8 dup ${s.duplicates.length}`; }
    const rej = await hook('rejected'); detail += ` | server-side rejected so far: ${rej.total} ${JSON.stringify(rej.reasons)}`;
    rec(id, why + (expectDelivered ? ': delivered, committed exactly once' : ': refused by TLS, events kept, delivered exactly once afterwards'), ok, detail);
  }
  // server clock
  if (E.FAKETIME_SERVER !== '0') {
    const r5 = run('CS5'), dir5 = await dirFor('cs5'); const set = await hook('faketime?value=%2B1d'); await sleep(4000); for (let i = 0; i < 20 && (await probe()) !== 401; i++) await sleep(1000);
    for (let i = 1; i <= 10; i++) await queue(r5, 'srvahead', i, dir5).catch(() => undefined); const o5 = await drainAll(dir5); const s5 = await server(r5); const t5 = await hook(`times?run=${r5}`);
    const aheadMs = t5.length ? Math.round((Math.min(...t5.map(x => Date.parse(x.createdAt))) - Date.now()) / 3_600_000) : null;
    rec('CS5', 'server clock a day ahead: events accepted and committed exactly once', set.enabled && o5.left === 0 && s5.unique === 10 && !s5.duplicates.length, `faketime=${set.faketime} enabled=${set.enabled} committed ${s5.unique}/10 dup ${s5.duplicates.length} server createdAt ~${aheadMs} h ahead of real time`);
    await hook('faketime?value='); await sleep(4000); for (let i = 0; i < 20 && (await probe()) !== 401; i++) await sleep(1000);
    const r6 = run('CS6'), dir6 = await dirFor('cs6'); for (let i = 1; i <= 10; i++) await queue(r6, 'srvback', i, dir6).catch(() => undefined); const o6 = await drainAll(dir6); const s6 = await server(r6); const v = await hook('verify');
    rec('CS6', 'server clock moved back to real time after writing in the future: new events committed, journal still verifies', o6.left === 0 && s6.unique === 10 && !s6.duplicates.length && v.ok === true && !(v.issues ?? []).length, `committed ${s6.unique}/10 dup ${s6.duplicates.length} verify=${JSON.stringify(v).slice(0, 80)}`);
    const sAll = await Promise.all([hook(`markers?run=${r5}`), hook(`markers?run=${r6}`)]); rec('CS7', 'events written while the server clock was ahead are still readable after it moved back', sAll[0].unique === 10, `ahead-run still ${sAll[0].unique}/10`);
  }
}

if (scenario === 'cable') {
  const r = run('CAB'), dir = await dirFor('cab'); await proxy('ok'); const markers = []; let i = 0, downSince = null, upAgain = null, downMs = 0; const t0 = Date.now(); const down = () => String(lastProbe).startsWith('error:'); let lastProbe = await probe();
  console.log('READY: writing one event every 2 s. UNPLUG the cable now, wait about 30 seconds, then plug it back in.');
  const hardStop = Date.now() + Number(E.CABLE_WINDOW_MIN ?? 45) * 60_000; // the owner may take a while to reach the cable
  while (Date.now() < hardStop) {
    lastProbe = await probe(); const isDown = down();
    if (isDown && downSince === null && Date.now() - t0 > 5000) { downSince = Date.now(); console.log(`LINK DOWN detected after ${Math.round((downSince - t0) / 1000)} s`); }
    if (!isDown && downSince !== null && upAgain === null) { upAgain = Date.now(); downMs = upAgain - downSince; console.log(`LINK UP again after ${Math.round(downMs / 1000)} s down`); }
    i++; markers.push(marker(r, 'cable', i)); await queue(r, 'cable', i, dir).catch(() => undefined);
    if (upAgain !== null && Date.now() - upAgain > 10_000) break;
    await sleep(2000);
  }
  const buffered = await spoolCount(dir); const out = await drainAll(dir); const s = await server(r);
  rec('CAB', `a physically pulled cable (${Math.round(downMs / 1000)} s down) with ${i} writes: nothing blocked, all committed exactly once after replugging`, downSince !== null && upAgain !== null && out.left === 0 && s.unique === i && !s.duplicates.length, `writes=${i} bufferedAtReconnect=${buffered} committed=${s.unique} dup=${s.duplicates.length}`);
}

const v = await hook('verify'); rec('J1', 'the server journal verifies after the whole run', v.ok === true && !(v.issues ?? []).length, JSON.stringify(v).slice(0, 100));
const fails = results.filter(x => x.status !== 'PASS'); console.log(`TOTAL ${results.length} checks, ${results.length - fails.length} pass, ${fails.length} fail`);
await fs.writeFile(E.OUT ?? 'faults-report.json', JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), scenario, results }, null, 2));
