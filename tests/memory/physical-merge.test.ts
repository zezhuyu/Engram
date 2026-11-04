import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';

const REQUIRED = ['tls-certificate-verified', 'unauthorized-rejected', 'online-delivery', 'network-interruption', 'offline-buffering-fail-open', 'duplicate-reorder-injected', 'network-restored', 'backlog-drained'];
const host = (id: string, extra: Record<string, unknown> = {}) => ({ hostId: id, hostname: `h-${id}`, platform: 'test', addresses: ['10.0.0.1'], containerDetected: false, ...extra });
const client = (id: string, markers: string[], over: Record<string, string> = {}, hostExtra: Record<string, unknown> = {}) => ({ role: 'client', runId: 'r1', markers, host: host(id, hostExtra), steps: REQUIRED.map(s => ({ id: s, status: over[s] ?? 'PASS' })) });
const server = (id: string, markers: string[], extra: Record<string, unknown> = {}) => ({ role: 'server', runId: 'r1', markers, duplicates: [], journalVerifyOk: true, host: host(id), ...extra });
async function merge(t: Parameters<typeof tempDir>[0], reports: unknown[]): Promise<{ code: number | null; verified: boolean; problems: string[] }> {
  const dir = await tempDir(t, 'physical-merge'); const files: string[] = [];
  for (const [i, r] of reports.entries()) { const f = path.join(dir, `r${i}.json`); await fs.writeFile(f, JSON.stringify(r)); files.push(f); }
  const out = path.join(dir, 'out.json'); const run = spawnSync(process.execPath, ['scripts/xhost/physical.mjs', 'merge', ...files, '--out', out], { encoding: 'utf8' });
  const report = JSON.parse(await fs.readFile(out, 'utf8')) as { physicalHostVerified: boolean; problems: string[] }; return { code: run.status, verified: report.physicalHostVerified, problems: report.problems };
}
test('the physical-host acceptance rule passes only genuine multi-machine evidence', async t => {
  const m = ['PHYS-r1-online-1', 'PHYS-r1-offline-1'];
  const good = await merge(t, [client('aaa', m), server('bbb', m)]); assert.equal(good.verified, true, good.problems.join(';')); assert.equal(good.code, 0);
  const same = await merge(t, [client('aaa', m), server('aaa', m)]); assert.equal(same.verified, false, 'one machine playing both roles is rejected'); assert.ok(same.problems.some(p => /distinct machine/.test(p)));
  const container = await merge(t, [client('aaa', m, {}, { containerDetected: true }), server('bbb', m)]); assert.equal(container.verified, false); assert.ok(container.problems.some(p => /container/.test(p)));
  const lost = await merge(t, [client('aaa', m), server('bbb', m.slice(0, 1))]); assert.equal(lost.verified, false); assert.ok(lost.problems.some(p => /never committed/.test(p)));
  const dup = await merge(t, [client('aaa', m), server('bbb', m, { duplicates: ['PHYS-r1-online-1'] })]); assert.equal(dup.verified, false); assert.ok(dup.problems.some(p => /duplicates/.test(p)));
  const notRun = await merge(t, [client('aaa', m, { 'network-interruption': 'NOT_RUN' }), server('bbb', m)]); assert.equal(notRun.verified, false, 'a step that was not run is not a pass'); assert.ok(notRun.problems.some(p => /network-interruption is NOT_RUN/.test(p)));
  const unknown = await merge(t, [client('unknown', m), server('bbb', m)]); assert.equal(unknown.verified, false);
  recordCase({ suite: 'memory', name: 'physical-host-acceptance-rule', status: 'PASS' });
});

test('physical evidence merge rejects duplicate JSON keys in host reports', async t => {
  const dir = await tempDir(t, 'physical-merge-duplicate');
  const clientFile = path.join(dir, 'client.json');
  const serverFile = path.join(dir, 'server.json');
  await fs.writeFile(clientFile, '{"role":"client","role":"server"}');
  await fs.writeFile(serverFile, JSON.stringify(server('bbb', ['marker'])));
  const run = spawnSync(process.execPath, ['scripts/xhost/physical.mjs', 'merge', clientFile, serverFile, '--out', path.join(dir, 'out.json')], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /duplicate JSON key|client\.json/);
});

test('tailnet mode: TLS is accepted as NOT_APPLICABLE only with the tailscale label and a tailnet client address, and the report says TLS was not tested', async t => {
  const m = ['PHYS-r1-online-1'];
  const tailnet = (id: string, detail: Record<string, unknown>) => { const c = client(id, m); c.steps = c.steps.map(s => s.id === 'tls-certificate-verified' ? { ...s, status: 'NOT_APPLICABLE', detail } : s); return c; };
  const labelled = { transport: 'tailscale-wireguard', tlsTested: false, clientHasTailnetAddress: true };
  const dir = await tempDir(t, 'physical-merge-tailnet'); const files = [tailnet('aaa', labelled), server('bbb', m)];
  const paths: string[] = []; for (const [i, r] of files.entries()) { const f = path.join(dir, `r${i}.json`); await fs.writeFile(f, JSON.stringify(r)); paths.push(f); }
  const out = path.join(dir, 'out.json'); const run = spawnSync(process.execPath, ['scripts/xhost/physical.mjs', 'merge', ...paths, '--out', out], { encoding: 'utf8' });
  const report = JSON.parse(await fs.readFile(out, 'utf8')) as { physicalHostVerified: boolean; transport: string; tlsVerified: boolean; problems: string[] };
  assert.equal(run.status, 0, report.problems.join(';')); assert.equal(report.transport, 'tailscale-wireguard'); assert.equal(report.tlsVerified, false);
  for (const bad of [{ transport: 'lan', tlsTested: false, clientHasTailnetAddress: true }, { transport: 'tailscale-wireguard', tlsTested: false, clientHasTailnetAddress: false }, {}]) {
    const r = await merge(t, [tailnet('aaa', bad), server('bbb', m)]); assert.equal(r.verified, false, JSON.stringify(bad)); assert.ok(r.problems.some(p => /tls-certificate-verified is NOT_APPLICABLE/.test(p)));
  }
  recordCase({ suite: 'memory', name: 'physical-host-tailnet-transport-label', status: 'PASS' });
});
