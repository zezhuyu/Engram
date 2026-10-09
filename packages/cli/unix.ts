import { OWNER, Engram, resolveRoot } from '../sdk/index.js';
import { UNIX_COMMANDS, DEFAULT_LIMITS, runUnix, toolStatus, type UnixCommand } from '../unix/index.js';
import { outputOf } from '../unix/io.js';

/** Decides whether argv is a Unix-style text command. `grep` and `diff` keep their older meanings (index search; vault revision diff) unless the call is clearly Unix-style. */
export function detectUnix(argv: string[]): { command: UnixCommand; rest: string[]; root: string | undefined } | undefined {
  let root: string | undefined; const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]!; if (a === '--root') { root = argv[++i]; continue; } if (a.startsWith('--root=')) { root = a.slice(7); continue; } rest.push(a); }
  const at = rest.findIndex(a => !a.startsWith('-')); if (at < 0) return undefined;
  const command = rest[at] as UnixCommand; if (command === ('filter' as string) || command === ('tools' as string)) return { command, rest: [...rest.slice(0, at), ...rest.slice(at + 1)], root }; if (!UNIX_COMMANDS.includes(command)) return undefined;
  const args = [...rest.slice(0, at), ...rest.slice(at + 1)];
  const positional = args.filter(a => !a.startsWith('-'));
  if (command === 'grep') {
    const unixStyle = args.some(a => /^-[A-Za-z]/.test(a) || ['--vault', '--stdin', '--ignore-case', '--invert-match', '--line-number', '--count', '--files-with-matches', '--only-matching', '--fixed-strings', '--extended-regexp', '--word-regexp', '--line-regexp', '--max-count', '--regexp', '--null', '--no-filename', '--with-filename'].includes(a.split('=')[0]!)) || args.includes('-') || positional.length >= 2;
    const legacyFlags = args.some(a => ['--scope', '--mode', '--kinds', '--tags', '--since', '--until', '--limit', '--cursor', '--regex', '--case-sensitive', '--allow-fallback', '--include-history', '--json'].includes(a.split('=')[0]!));
    // a lone pattern with piped (non-terminal) stdin and no search flags is Unix grep over stdin; at a terminal it is the vault index search
    const piped = !process.stdin.isTTY && positional.length === 1 && !legacyFlags && !args.includes('--path');
    if ((!unixStyle && !piped) || args.includes('--path') || legacyFlags && !args.includes('--vault')) return undefined; // `--path ID` stays the older line-grep alias handled by the query CLI
  }
  if (command === 'diff') { const legacy = positional.length === 3 && !args.some(a => /^-[A-Za-z]/.test(a)) && !args.some(a => a.startsWith('--label')); if (legacy || positional.length < 2 && !args.some(a => /^-[A-Za-z]/.test(a))) return undefined; }
  return { command, rest: args, root };
}
export async function unixMain(command: UnixCommand, args: string[], rootArg: string | undefined): Promise<number> {
  const root = resolveRoot(rootArg); const abort = new AbortController(); const stop = () => abort.abort(); process.once('SIGINT', stop);
  if ((command as string) === 'tools') { process.stdout.write(JSON.stringify({ interop: toolStatus(), nativeCommands: UNIX_COMMANDS }, null, 2) + '\n'); return 0; }
  const client = new Engram(root, OWNER);
  try {
    return await runUnix(command as UnixCommand | 'filter', args, { stdin: process.stdin as unknown as AsyncIterable<Buffer>, out: outputOf(process.stdout), err: m => { process.stderr.write(m); }, client, limits: limitsFromEnv(), vaultRoots: [root], allowLocalFiles: true, allowTee: true, signal: abort.signal });
  } finally { process.removeListener('SIGINT', stop); }
}

/** Bounded by default; the host may tighten or raise the limits through the environment (documented in docs/unix.md). */
function limitsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const n = (k: string, d: number) => { const v = Number(env[k]); return Number.isSafeInteger(v) && v > 0 ? v : d; };
  return { maxLineBytes: n('MDB_UNIX_MAX_LINE_BYTES', DEFAULT_LIMITS.maxLineBytes), maxBufferLines: n('MDB_UNIX_MAX_BUFFER_LINES', DEFAULT_LIMITS.maxBufferLines), maxInputBytes: n('MDB_UNIX_MAX_INPUT_BYTES', DEFAULT_LIMITS.maxInputBytes), deadlineMs: n('MDB_UNIX_DEADLINE_MS', DEFAULT_LIMITS.deadlineMs) };
}
