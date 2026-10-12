// Repeatable before/after benchmark. Usage: node scripts/profiling/bench-compare.mjs <label> [--cli-runs N] [--steady N] [--first-index N]
// Corpus: the APFS clones named in verification/performance/raw/next-phase/workdir.txt (fresh/ = Markdown+FS indexes, sqlite100k/ = SQLite). Warm page cache: NOT OS-cold.
import { spawnSync, execSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const [label, ...rest] = process.argv.slice(2); if (!label) throw new Error('label required');
const opt = (name, d) => { const i = rest.indexOf(name); return i >= 0 ? Number(rest[i + 1]) : d; };
const cliRuns = opt('--cli-runs', 20), steady = opt('--steady', 300), firstIndexRuns = opt('--first-index', 0);
const repo = path.resolve(import.meta.dirname, '../..'); const W = fs.readFileSync(path.join(repo, 'verification/performance/raw/next-phase/workdir.txt'), 'utf8').trim();
const out = path.join(repo, 'verification/performance/raw/opt', label); fs.mkdirSync(out, { recursive: true });
const stats = xs => { const s = [...xs].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))], mean = s.reduce((a, b) => a + b, 0) / s.length; return { n: s.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), min: +s[0].toFixed(1), max: +s.at(-1).toFixed(1), stddev: +Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length).toFixed(1) }; };
const timed = (cmd) => { const t = process.hrtime.bigint(); const r = spawnSync('/usr/bin/time', ['-l', ...cmd], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 }); const ms = Number(process.hrtime.bigint() - t) / 1e6; const rss = Number(/(\d+)\s+maximum resident set size/.exec(r.stderr)?.[1] ?? 0) / 2 ** 20; return { ms, rssMiB: rss, status: r.status, stdout: r.stdout }; };
const env = { label, date: new Date().toISOString(), os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, v8: process.versions.v8, cpus: os.cpus().length, loadavg: os.loadavg().map(x => +x.toFixed(2)), backupdActive: /backupd/.test(execSync('ps -axo comm', { encoding: 'utf8' })), cache: 'warm page cache, fresh process per CLI run; NOT OS-cold' };
const result = { env, cli: {}, inProcess: {}, firstIndex: null };
const cli = {
  'help': ['node', 'bin/mdb.js', 'help'],
  'fs grep no-hit': ['node', 'bin/mdb.js', '--root', `${W}/fresh`, 'search', 'zz-no-such-token-zz', '--mode', 'grep', '--limit', '50', '--json'],
  'fs grep CJK': ['node', 'bin/mdb.js', '--root', `${W}/fresh`, 'search', '知识库', '--mode', 'grep', '--limit', '1000', '--json'],
  'fs grep rare': ['node', 'bin/mdb.js', '--root', `${W}/fresh`, 'search', 'rare-marker-20261008', '--mode', 'grep', '--limit', '1000', '--json'],
  'sqlite keyword no-hit': ['node', 'bin/mdb.js', '--root', `${W}/sqlite100k`, 'search', 'zz-no-such-token-zz', '--mode', 'keyword', '--limit', '50', '--json'],
  'sqlite keyword CJK': ['node', 'bin/mdb.js', '--root', `${W}/sqlite100k`, 'search', '知识库', '--mode', 'keyword', '--limit', '50', '--json'],
};
for (const [name, cmd] of Object.entries(cli)) { timed(cmd); const runs = Array.from({ length: cliRuns }, () => timed(cmd)); result.cli[name] = { ms: stats(runs.map(r => r.ms)), peakRssMiB: stats(runs.map(r => r.rssMiB)), failures: runs.filter(r => r.status !== 0).length, firstStdoutHash: runs[0].stdout.length }; console.error('cli', name, result.cli[name].ms.p50); }
for (const name of ['grep-nonexistent', 'grep-cjk', 'grep-rare']) {
  const runs = Array.from({ length: 3 }, () => JSON.parse(timed(['node', 'scripts/profiling/stage-queries.mjs', `${W}/fresh`, name, String(steady)]).stdout));
  result.inProcess[name] = { importMs: stats(runs.map(r => r.moduleImportMs)), vaultMs: stats(runs.map(r => r.vaultAndEngineMs)), firstQueryMs: stats(runs.map(r => r.firstQueryMs)), steadyP50: stats(runs.map(r => r.steady.p50)), steadyP95: stats(runs.map(r => r.steady.p95)), steadyP99: stats(runs.map(r => r.steady.p99)), rssMiB: stats(runs.map(r => r.rssMiB)), hits: runs[0].hits, index: runs[0].index }; console.error('in-process', name, result.inProcess[name].steadyP50.p50);
}
if (firstIndexRuns) {
  const clone = `${W}/firstindex`; if (!fs.existsSync(clone)) { console.error('cloning corpus for first-index (APFS clone, slow with Time Machine)'); execSync(`cp -cR '${W}/fresh' '${clone}'`); }
  const runs = []; for (let i = 0; i < firstIndexRuns; i++) { fs.rmSync(`${clone}/.mdb/indexes`, { recursive: true, force: true }); const r = timed(['node', 'scripts/profiling/stage-first-index.mjs', clone]); runs.push({ ...JSON.parse(r.stdout), wallMs: r.ms, peakRssMiB: r.rssMiB }); console.error('first-index', runs.at(-1).totalMs); }
  result.firstIndex = { runs, totalMs: stats(runs.map(r => r.totalMs)), manifestBuildMs: stats(runs.map(r => r.manifestBuildMs)), trigramBuildMs: stats(runs.map(r => r.trigramBuildMs)), peakRssMiB: stats(runs.map(r => r.peakRssMiB)) };
  // leave the clone with its indexes rebuilt so later CLI runs on it (if any) are not cold-built
}
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(path.join(out, 'result.json'));
