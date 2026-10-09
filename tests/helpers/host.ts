import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MDB = fileURLToPath(new URL('../../../bin/mdb.js', import.meta.url));
export const MCP_BIN = fileURLToPath(new URL('../../../bin/mdb-mcp.js', import.meta.url));
type T = { after(fn: () => void | Promise<void>): void };
export interface RunResult { code: number | null; stdout: string; stderr: string }
export function run(args: string[], options: { input?: string; env?: Record<string, string | undefined>; cwd?: string; bin?: string } = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [options.bin ?? MDB, ...args], { env: { ...process.env, ...options.env } as NodeJS.ProcessEnv, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.stdin.on('error', () => undefined); child.stdin.end(options.input ?? '');
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
export async function tempDir(t: T, name: string): Promise<string> { const d = await fs.mkdtemp(path.join(os.tmpdir(), `engram-${name}-`)); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; }
export async function claudePayloads(): Promise<Record<string, Record<string, unknown>>> {
  return (JSON.parse(await fs.readFile(fileURLToPath(new URL('../../../tests/fixtures/hook-payloads/claude-code.json', import.meta.url)), 'utf8')) as { payloads: Record<string, Record<string, unknown>> }).payloads;
}
const FAKE_AGENT = `#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.FAKE_AGENT_LOG,'called '+process.argv.slice(2).join(' ')+'\\n');process.stdout.write('{}');\n`;
/** Executables named claude and codex that only record that they were called: proves a path makes no model call. */
export async function fakeAgents(t: T): Promise<{ dir: string; log: string; calls: () => Promise<string[]>; env: Record<string, string> }> {
  const dir = await tempDir(t, 'agents'); const log = path.join(dir, 'calls.log');
  for (const name of ['claude', 'codex']) { await fs.writeFile(path.join(dir, name), FAKE_AGENT); await fs.chmod(path.join(dir, name), 0o755); }
  return { dir, log, calls: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean), env: { PATH: `${dir}:${process.env.PATH}`, FAKE_AGENT_LOG: log } };
}
