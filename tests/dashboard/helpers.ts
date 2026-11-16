import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { Engram } from '../../packages/sdk/index.js';

// Test vaults live on the data volume when it exists (the system temp directory is subject to the tmp-trust rules); elsewhere they fall back to the system temp directory.
const testParent = process.env.ENGRAM_DASHBOARD_TEST_DIR ?? (existsSync('/Volumes/sambigdisk1') ? '/Volumes/sambigdisk1' : tmpdir());

export async function disposableVault() {
  const root = await mkdtemp(path.join(testParent, 'engram-dashboard-test-'));
  const priorAuthFile = process.env.MDB_DASHBOARD_AUTH_FILE;
  process.env.MDB_DASHBOARD_AUTH_FILE = path.join(root, '.test-auth', 'auth.json');
  // A dashboard writes connector files (tunnel ID, API key, launcher scripts) under HOME and XDG_CONFIG_HOME. Point both at the test vault so no test can ever touch the
  // developer's real ~/.config/engram (a browser test once overwrote a real ChatGPT tunnel key that way).
  // A test that already pointed HOME somewhere else keeps its own location.
  const priorHome = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const touchesRealHome = !process.env.HOME || path.resolve(process.env.HOME) === path.resolve(userInfo().homedir);
  if (touchesRealHome) {
    process.env.HOME = path.join(root, '.test-home'); process.env.XDG_CONFIG_HOME = path.join(root, '.test-home', '.config');
    await mkdir(process.env.XDG_CONFIG_HOME, { recursive: true });
  }
  const engram = new Engram(root);
  await engram.init({ sqlite: false });
  // A dashboard timer or audit write can still be in flight when the server has just closed; retry the removal instead of failing the test with ENOTEMPTY.
  return { root, engram, cleanup: async () => { await engram.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); if (priorAuthFile === undefined) delete process.env.MDB_DASHBOARD_AUTH_FILE; else process.env.MDB_DASHBOARD_AUTH_FILE = priorAuthFile; for (const [name, value] of Object.entries(priorHome)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } } };
}
export const tempPath = (root: string, ...parts: string[]) => path.join(root, ...parts);

/**
 * The served script is readable, formatted source. Several tests assert on exact statement text written for the old minified output,
 * so they compare against this normalised form: one top-level statement per line, whitespace removed around punctuation and string
 * literals inside a statement (never inside a string), and the last semicolon before a closing brace dropped.
 */
export function compactScript(source: string): string {
  const statements: string[] = [];
  for (const line of source.split('\n')) {
    if ((/^\S/.test(line) && !/^(\}|\)|\]|else\b|catch\b|finally\b|,)/.test(line)) || statements.length === 0) statements.push(line);
    else statements[statements.length - 1] += ' ' + line;
  }
  const squeeze = (text: string): string => {
    const parts = text.split(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/);
    return parts.map((part, index) => {
      if (index % 2 === 1) return part;
      let out = part.replace(/\s+/g, ' ').replace(/\s*([,;(){}:?=+\-*<>!&|])\s*/g, '$1').replace(/\s*\]\s*/g, ']').replace(/(?<!\b(?:of|in|return|typeof|await|case|new|void|delete|yield))\s+\[/g, '[');
      if (index > 0) out = out.replace(/^\s+/, '');
      if (index < parts.length - 1) out = out.replace(/\s+$/, '');
      return out;
    }).join('').replace(/;\}/g, '}').trim();
  };
  return statements.map(squeeze).filter(Boolean).join('\n');
}
