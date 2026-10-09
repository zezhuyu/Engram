import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MDBError } from '../core/types.js';
import { UsageError } from './args.js';
import type { Ctx } from './ctx.js';
import { Quiet, ResourceError } from './io.js';

/**
 * Controlled interoperability with INSTALLED programmable tools. There is no shell: the program is started with an argument vector, a scrubbed environment and a
 * neutral working directory; data flows only through stdin/stdout. Only tools that can be run without file or process access are allowed:
 *   jq          (module/file options refused)        gawk --sandbox        GNU sed --sandbox
 * BSD awk, mawk and BSD sed cannot be sandboxed and are refused: use the native subsets (mdb query, mdb sed, mdb cut) or run them yourself in a shell pipeline.
 * Every other GNU/BSD tool (sort, uniq, cut, tr, paste, comm, wc, grep, ...) is available natively; interoperate with any tool through pipes (-z, ndjson, text).
 */
const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
export function which(name: string): string | undefined { for (const d of dirs) { const f = path.join(d, name); try { accessSync(f, constants.X_OK); return f; } catch { /* next */ } } return undefined; }
const versionOf = (bin: string): string => { const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 }); return `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n')[0] ?? ''; };

export interface ToolInfo { tool: string; path?: string; version?: string; usable: boolean; reason?: string }
export function toolStatus(): ToolInfo[] {
  const out: ToolInfo[] = [];
  const jq = which('jq'); out.push({ tool: 'jq', ...(jq ? { path: jq, version: versionOf(jq), usable: true } : { usable: false, reason: 'not installed' }) });
  const pick = (names: string[], marker: RegExp) => { for (const n of names) { const b = which(n); if (b && marker.test(versionOf(b))) return b; } return undefined; };
  const gawk = pick(['gawk', 'awk'], /GNU Awk/i); out.push({ tool: 'awk', ...(gawk ? { path: gawk, version: versionOf(gawk), usable: true } : { usable: false, reason: `no GNU awk with --sandbox (found: ${which('awk') ?? 'none'}); install gawk` }) });
  const gsed = pick(['gsed', 'sed'], /GNU sed/i); out.push({ tool: 'sed', ...(gsed ? { path: gsed, version: versionOf(gsed), usable: true } : { usable: false, reason: `no GNU sed with --sandbox (found: ${which('sed') ?? 'none'}); install gnu-sed or use mdb sed` }) });
  return out;
}

interface Plan { bin: string; args: string[] }
const JQ_FLAGS = new Set(['-r', '-c', '-s', '-n', '-e', '-S', '-R', '-j', '-a', '-M', '--tab', '--raw-output', '--compact-output', '--slurp', '--null-input', '--exit-status', '--sort-keys', '--raw-input', '--join-output', '--ascii-output', '--monochrome-output', '-0', '--raw-output0']);
const JQ_VALUE_FLAGS = new Set(['--arg', '--argjson', '--indent']);
export function planFor(tool: string, argv: string[]): Plan {
  const st = toolStatus().find(t => t.tool === tool);
  if (!st) throw new UsageError(`unsupported tool '${tool}' (supported: jq, awk (gawk --sandbox), sed (GNU sed --sandbox))`);
  if (!st.usable || !st.path) throw new MDBError('CAPABILITY_UNAVAILABLE', `${tool}: ${st.reason}`);
  const fail = (m: string): never => { throw new UsageError(m); };
  if (tool === 'jq') {
    const args: string[] = []; let program: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (JQ_FLAGS.has(a)) args.push(a);
      else if (JQ_VALUE_FLAGS.has(a)) { const v1 = argv[++i], v2 = a === '--indent' ? '' : argv[++i]; if (v1 === undefined || (a !== '--indent' && v2 === undefined)) fail(`${a} needs ${a === '--indent' ? 'a number' : 'a name and a value'}`); args.push(a, v1!, ...(a === '--indent' ? [] : [v2!])); }
      else if (a.startsWith('-') && a !== '-') fail(`jq option '${a}' is not allowed (file, module and program-file options are refused)`);
      else if (program === undefined) program = a; else fail(`jq input files are not allowed ('${a}'): pipe data on stdin`);
    }
    if (program === undefined) fail('jq needs a filter'); if (/(^|[^\w$.])(import|include|input_filename|env|\$ENV|\$__prog_args|get_search_list)\b/.test(program!)) fail('jq filter uses import/include/env/filename features that are not allowed');
    return { bin: st.path, args: [...args, program!] };
  }
  const args: string[] = ['--sandbox']; const scripts: string[] = [];
  if (tool === 'awk') {
    let program: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === '-F') { const v = argv[++i]; if (v === undefined) fail('-F needs a separator'); args.push('-F', v!); }
      else if (a.startsWith('-F') && a.length > 2) args.push(a);
      else if (a === '-v') { const v = argv[++i]; if (v === undefined || !/^[A-Za-z_]\w*=/.test(v)) fail('-v needs var=value'); args.push('-v', v!); }
      else if (a.startsWith('-') && a !== '-') fail(`awk option '${a}' is not allowed (program files, includes and extensions are refused)`);
      else if (program === undefined) program = a; else fail(`awk input files are not allowed ('${a}'): pipe data on stdin`);
    }
    if (program === undefined) fail('awk needs a program'); return { bin: st.path, args: [...args, '--', program!] };
  }
  for (let i = 0; i < argv.length; i++) { // sed
    const a = argv[i]!;
    if (['-n', '-E', '-r', '-z', '--quiet', '--silent', '--regexp-extended', '--null-data'].includes(a)) args.push(a);
    else if (a === '-e') { const v = argv[++i]; if (v === undefined) fail('-e needs a script'); scripts.push(v!); }
    else if (a.startsWith('-') && a !== '-') fail(`sed option '${a}' is not allowed (-i, -f, -s and file options are refused)`);
    else if (!scripts.length) scripts.push(a); else fail(`sed input files are not allowed ('${a}'): pipe data on stdin`);
  }
  if (!scripts.length) fail('sed needs a script'); for (const s of scripts) args.push('-e', s); return { bin: st.path, args };
}

export async function filter(ctx: Ctx, argv: string[]): Promise<number> {
  const [tool, ...rest] = argv; if (!tool) throw new UsageError('filter needs a tool: jq | awk | sed');
  const plan = planFor(tool, rest);
  const child = spawn(plan.bin, plan.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir(), env: { PATH: '/usr/bin:/bin', LC_ALL: process.env.LC_ALL ?? 'C', LANG: process.env.LANG ?? 'C' }, detached: false });
  const kill = () => child.kill('SIGKILL'); ctx.signal?.addEventListener('abort', kill, { once: true });
  let outBytes = 0; let stderr = ''; let overflow = false;
  child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d; });
  const done = new Promise<number>(resolve => { child.on('close', code => resolve(code ?? 1)); child.on('error', () => resolve(127)); });
  child.stdin.on('error', () => undefined);
  const feed = (async () => { try { for await (const chunk of ctx.stdin) { if (!child.stdin.write(chunk)) await new Promise<void>(r => child.stdin.once('drain', r)); } } finally { child.stdin.end(); } })();
  try {
    for await (const chunk of child.stdout) { outBytes += (chunk as Buffer).length; if (outBytes > ctx.limits.maxInputBytes) { overflow = true; kill(); break; } await ctx.out.write(chunk as Buffer); }
  } catch (e) { kill(); if (e instanceof Quiet) throw e; throw e; }
  await feed.catch(() => undefined); const code = await done; ctx.signal?.removeEventListener('abort', kill);
  if (overflow) throw new ResourceError(`${tool} produced more than ${ctx.limits.maxInputBytes} bytes`);
  if (stderr) ctx.err(stderr.endsWith('\n') ? stderr : stderr + '\n');
  return code;
}
