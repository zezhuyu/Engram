// Deep physical-host remote-capture verification (run on the CLIENT machine; the server runs scripts/xhost/deep-server.mjs on another machine).
// Extends scripts/xhost/physical.mjs: repeated real network cuts, server SIGKILL during an outage and during a drain, a long outage with a trickle of events,
// the 1000-entry spool cap, credential isolation, rotate and revoke while offline, client SIGKILL mid-drain, payload sizes, and TLS negatives.
// Environment: URL (https://HOST:PORT/mcp), REG_A, TOKEN_A, CRED_A, REG_B, TOKEN_B, HOOK (http://SERVER_LAN:8450/HOOKTOKEN), CUT, RESTORE,
//   BAD_NAME_URL (a server endpoint whose certificate does NOT cover the name used), OUTAGE_SECONDS (default 240), NODE_EXTRA_CA_CERTS (private CA, set at launch).
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const E = process.env, root = new URL('../../', import.meta.url).pathname;
const { queueRemoteCapture, drainRemoteCaptureSpool } = await import(new URL('dist/packages/memory/remote-spool.js', `file://${root}`).href);
for (const k of ['URL', 'REG_A', 'TOKEN_A', 'CRED_A', 'REG_B', 'TOKEN_B', 'HOOK', 'CUT', 'RESTORE']) if (!E[k]) throw new Error(`${k} is required`);
const sleep = ms => new Promise(r => setTimeout(r, ms)); const results = []; const base = new URL(E.URL); const capture = `${base.origin}/capture`;
// Rotating a credential creates a NEW credential id, so the current id is tracked.
let tokenA = E.TOKEN_A, credA = E.CRED_A; const stamp = Date.now().toString(36).slice(-4).toUpperCase();
const rec = (id, desc, ok, detail = '') => { results.push({ id, desc, status: ok ? 'PASS' : 'FAIL', detail: String(detail).slice(0, 200) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${desc} | ${String(detail).slice(0, 120)}`); };
const sh = cmd => spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 60_000 });
const probe = async (tok = '', url = capture, reg = E.REG_A) => { try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify({ registrationId: reg, payload: { hook_event_name: 'SessionStart', session_id: 'probe', cwd: '/w' } }), signal: AbortSignal.timeout(6000) }); return r.status; } catch (e) { return `error:${e.cause?.code ?? e.code ?? e.name}`; } };
const hook = async p => { const r = await fetch(`${E.HOOK}/${p}`, { signal: AbortSignal.timeout(130_000) }); return r.json(); };
const cut = async () => { const r = sh(E.CUT); await sleep(1500); return r.status === 0 && String(await probe()).startsWith('error:'); };
const restore = async () => { sh(E.RESTORE); await sleep(2000); for (let i = 0; i < 45; i++) { if ((await probe()) === 401) return true; await sleep(1000); } return false; };
const dirFor = async n => fs.mkdtemp(path.join(os.tmpdir(), `deep-${n}-`));
const marker = (run, kind, n) => `PHYS-${run}-${kind}-${n}`;
const payload = (run, kind, n, size = 0) => ({ hook_event_name: 'UserPromptSubmit', session_id: `deep-${run}`, cwd: '/w', prompt_id: marker(run, kind, n), prompt: `${marker(run, kind, n)} ${'x'.repeat(size)}` });
const queue = (run, kind, n, dir, tok, size) => queueRemoteCapture({ url: E.URL, registrationId: E.REG_A, token: tok, payload: payload(run, kind, n, size), directory: dir });
const spoolCount = async dir => (await fs.readdir(dir).catch(() => [])).filter(n => n.endsWith('.json')).length;
async function drainAll(tok, dir, { limit = 100, budgetMs = 600_000, between } = {}) { let delivered = 0, rejected = 0, left = 1; const end = Date.now() + budgetMs; while (left && Date.now() < end) { const d = await drainRemoteCaptureSpool({ token: tok, directory: dir, limit }); delivered += d.delivered; rejected += d.rejected; left = d.queued; if (between) await between(d); if (left) await sleep(500); } return { delivered, rejected, left }; }
// The server acknowledges an event once it is in its durable spool and commits it asynchronously, so "delivered" is final only when the committed count stops changing.
const server = async run => { let last = -1, stable = 0, s; for (let i = 0; i < 60; i++) { s = await hook(`markers?run=${run}`); if (s.committed === last) { if (++stable >= 3) return s; } else stable = 0; last = s.committed; await sleep(3000); } return s; };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const run = id => `${id}${stamp}`;
// SKIP=D1,D2 skips scenarios that already passed in an earlier part of the same campaign.
const skip = id => (E.SKIP ?? '').split(',').includes(id);

// D1: three real cuts with writes during each
if (!skip('D1')) { const r = run('D1'), dir = await dirFor('d1'); const expected = []; let allCut = true, allUp = true;
  for (let c = 1; c <= 3; c++) { allCut &&= await cut(); for (let i = 1; i <= 20; i++) { expected.push(marker(r, `c${c}`, i)); await queue(r, `c${c}`, i, dir, tokenA); } allUp &&= await restore(); await drainAll(tokenA, dir); }
  const s = await server(r); rec('D1', 'three cut/restore cycles with 20 writes each: all 60 delivered exactly once', allCut && allUp && (await spoolCount(dir)) === 0 && s.unique === 60 && !s.duplicates.length && same([...expected].sort(), s.markers), `cut=${allCut} up=${allUp} unique=${s.unique} dup=${s.duplicates.length}`); }

// D2: server SIGKILL during the outage and again in the middle of the drain
if (!skip('D2')) { const r = run('D2'), dir = await dirFor('d2'); await cut(); for (let i = 1; i <= 40; i++) await queue(r, 'off', i, dir, tokenA); await hook('kill9'); await sleep(2500); await restore();
  let killed = false; const out = await drainAll(tokenA, dir, { limit: 10, between: async d => { if (!killed && d.delivered > 0) { killed = true; await hook('kill9'); await sleep(300); } } });
  const s = await server(r); rec('D2', 'server SIGKILL during the outage and mid-drain: all 40 delivered exactly once', killed && out.left === 0 && s.unique === 40 && !s.duplicates.length, `unique=${s.unique} dup=${s.duplicates.length} killedMidDrain=${killed}`); }

// D3: long outage with a trickle of events
if (!skip('D3')) { const r = run('D3'), dir = await dirFor('d3'), seconds = Number(E.OUTAGE_SECONDS ?? 240), n = Math.floor(seconds / 2); await cut(); const t0 = Date.now(); let maxMs = 0;
  for (let i = 1; i <= n; i++) { const t = Date.now(); await queue(r, 'trickle', i, dir, tokenA); maxMs = Math.max(maxMs, Date.now() - t); await sleep(Math.max(0, 2000 - (Date.now() - t))); }
  const up = await restore(); const out = await drainAll(tokenA, dir); const s = await server(r);
  rec('D3', `${Math.round((Date.now() - t0) / 1000)} s outage with ${n} buffered events: all delivered exactly once, no write ever blocked`, up && out.left === 0 && s.unique === n && !s.duplicates.length && maxMs < 5000, `unique=${s.unique}/${n} dup=${s.duplicates.length} maxWriteMs=${maxMs}`); }

// D4: spool cap
if (!skip('D4')) { const r = run('D4'), dir = await dirFor('d4'); await cut(); let full = 0, ok = 0; for (let i = 1; i <= 1100; i++) { try { await queue(r, 'cap', i, dir, undefined); ok++; } catch (e) { if (/full/i.test(e.message)) full++; else throw e; } }
  const buffered = await spoolCount(dir); await restore(); const out = await drainAll(tokenA, dir, { budgetMs: 900_000 }); const s = await server(r);
  rec('D4', 'spool cap: 1100 offline writes keep exactly 1000, refuse 100 cleanly, and deliver the 1000 exactly once', buffered === 1000 && full === 100 && out.left === 0 && s.unique === 1000 && !s.duplicates.length, `buffered=${buffered} refused=${full} unique=${s.unique} dup=${s.duplicates.length}`); }

// D5: isolation and no secret in the spool
if (!skip('D5')) { const bOnA = await probe(E.TOKEN_B, capture, E.REG_A), aOnB = await probe(tokenA, capture, E.REG_B), none = await probe('', capture, E.REG_A), bogus = await probe('engram_invalid_token_for_deep_check_0000000000', capture, E.REG_A);
  rec('D5', 'credentials are bound to their registration: B on A and A on B are refused, no token and a bogus token give 401', [bOnA, aOnB].every(c => [403, 404].includes(c)) && none === 401 && bogus === 401, `B->A=${bOnA} A->B=${aOnB} none=${none} bogus=${bogus}`);
  const dir = await dirFor('d5'), r = run('D5'); await cut(); for (let i = 1; i <= 3; i++) await queue(r, 'sec', i, dir, tokenA); const files = await fs.readdir(dir); const blob = (await Promise.all(files.map(f => fs.readFile(path.join(dir, f), 'utf8').catch(() => '')))).join('');
  await restore(); rec('D5b', 'the offline spool never contains a bearer token', !blob.includes(tokenA) && !blob.includes(E.TOKEN_B), `${files.length} files`); await drainAll(tokenA, dir); }

// D6: rotate the credential while the client is offline
if (!skip('D6')) { const r = run('D6'), dir = await dirFor('d6'); await cut(); for (let i = 1; i <= 10; i++) await queue(r, 'rot', i, dir, tokenA); const rot = await hook(`rotate?id=${credA}`); const newToken = rot.token; await restore();
  const old = await drainRemoteCaptureSpool({ token: tokenA, directory: dir }); const fresh = newToken ? await drainAll(newToken, dir) : { delivered: 0, left: 10 }; const s = await server(r);
  rec('D6', 'credential rotated while offline: the old token keeps the backlog (no loss, no quarantine), the new token delivers all 10 once', !!newToken && old.delivered === 0 && old.queued === 10 && old.rejected === 0 && fresh.left === 0 && s.unique === 10 && !s.duplicates.length, `old=${JSON.stringify(old)} fresh=${fresh.delivered} unique=${s.unique}`); if (newToken) { tokenA = newToken; credA = rot.id; } }

// D7: client process SIGKILL in the middle of a drain
if (!skip('D7')) { const r = run('D7'), dir = await dirFor('d7'); for (let i = 1; i <= 200; i++) await queue(r, 'kill', i, dir, undefined);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { drainRemoteCaptureSpool } from ${JSON.stringify(new URL('dist/packages/memory/remote-spool.js', `file://${root}`).href)}; while (true) { const d = await drainRemoteCaptureSpool({ token: process.env.TK, directory: ${JSON.stringify(dir)}, limit: 3 }); if (!d.queued) break; }`], { env: { ...E, TK: tokenA }, stdio: 'ignore' }); await sleep(2500); child.kill('SIGKILL'); await sleep(300);
  const leftAtKill = await spoolCount(dir); const out = await drainAll(tokenA, dir); const s = await server(r);
  rec('D7', 'client SIGKILL mid-drain, then a fresh drain: all 200 delivered with no loss', leftAtKill > 0 && leftAtKill < 200 && out.left === 0 && s.unique === 200, `leftAtKill=${leftAtKill} unique=${s.unique}`);
  rec('D7b', 'and no duplicate despite the kill (an at-least-once window would show here)', !s.duplicates.length, `duplicates=${s.duplicates.length}`); }

// D8: payload sizes (the client truncates a prompt to 20,000 characters)
if (!skip('D8')) { const sizes = [0, 5_000, 19_000, 25_000, 100_000]; const dir = await dirFor('d8'), r = run('D8'); for (const [i, size] of sizes.entries()) await queue(r, 'size', i + 1, dir, tokenA, size); const left = await spoolCount(dir); const rej = (await fs.readdir(path.join(dir, 'rejected')).catch(() => [])).filter(n => n.endsWith('.json')).length; const s = await server(r);
  rec('D8', 'payload sizes 0, 5 KB, 19 KB, 25 KB and 100 KB are all committed (large prompts truncated by the client), none lost or stuck', left === 0 && s.unique === sizes.length, `committed=${s.unique}/${sizes.length} stuck=${left} rejected=${rej}`); }

// D9: TLS negatives from the real client
if (!skip('D9')) { const child = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(capture)}, { method: 'POST', body: '{}' }).then(() => console.log('REACHED'), e => console.log('REFUSED ' + (e.cause?.code ?? e.name)))`], { env: { ...E, NODE_EXTRA_CA_CERTS: '' }, encoding: 'utf8', timeout: 30_000 });
  rec('D9', 'without the private CA the client refuses the server certificate', /REFUSED/.test(child.stdout), child.stdout.trim());
  if (E.BAD_NAME_URL) { const bad = await probe(tokenA, new URL(E.BAD_NAME_URL).origin + '/capture'); rec('D9b', 'a trusted CA but a certificate for another name is refused before any credential is sent', String(bad).startsWith('error:'), String(bad)); } }

// D10: revoke the credential while the client is offline (last: it ends this credential)
if (!skip('D10')) { const r = run('D10'), dir = await dirFor('d10'); await cut(); for (let i = 1; i <= 5; i++) await queue(r, 'rev', i, dir, tokenA); const revoked = await hook(`revoke?id=${credA}`); await restore(); const d = await drainRemoteCaptureSpool({ token: tokenA, directory: dir }); const s = await server(r);
  rec('D10', 'credential revoked while offline: nothing is delivered, nothing is lost or quarantined (the backlog waits for a new credential)', revoked.revoked === true && d.delivered === 0 && d.queued === 5 && d.rejected === 0 && s.unique === 0, `revoked=${revoked.revoked} ${JSON.stringify(d)}`); }

const v = await hook('verify'); rec('J1', 'the server journal verifies after the whole run', v.ok === true && !(v.issues ?? []).length, JSON.stringify(v).slice(0, 100));
const fails = results.filter(x => x.status !== 'PASS'); console.log(`TOTAL ${results.length} checks, ${results.length - fails.length} pass, ${fails.length} fail`);
await fs.writeFile(E.OUT ?? 'deep-report.json', JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), url: E.URL, results }, null, 2));
