import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watcherServiceText } from '../memory/outbox-watch.js';
import { watchOutbox } from '../memory/outbox-watch.js';
import { defaultOutboxDirectory } from '../memory/outbox.js';
import { readBinding } from '../core/project-binding.js';
import { isTrusted } from '../core/project-trust.js';
import { reconcile, remoteSink } from '../memory/file-sync.js';

const exec = promisify(execFile);
const LABEL = 'dev.engram.outbox-watch';
type Options = { action: string; platform?: 'macos' | 'linux'; home?: string; uid?: number; url?: string; tokenFile?: string; workspace?: string; outbox?: string; projectDir?: string; dryRun?: boolean; allowRoot?: boolean };
function fail(message: string): never { throw new Error(message); }

export async function manageClientService(o: Options, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const platform = o.platform ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined);
  if (!platform) fail('service is supported on macOS and Linux');
  const home = path.resolve(o.home ?? env.HOME ?? ''); if (!home || home === '.') fail('HOME is unavailable');
  const uid = o.uid ?? process.getuid?.() ?? 1;
  if (uid === 0 && !o.allowRoot) fail('refusing to manage a user service as root (pass --allow-root only for an isolated account)');
  const directory = platform === 'macos' ? path.join(home, 'Library/LaunchAgents') : path.join(home, '.config/systemd/user');
  const unitFile = path.join(directory, platform === 'macos' ? `${LABEL}.plist` : 'engram-outbox-watch.service');
  const metadataFile = path.join(directory, platform === 'macos' ? `${LABEL}.json` : 'engram-outbox-watch.json');
  const logFile = platform === 'macos' ? path.join(home, 'Library/Logs/Engram/client-daemon.log') : undefined;
  const unitName = platform === 'macos' ? LABEL : 'engram-outbox-watch.service';
  const domain = `gui/${uid}`;
  const call = async (bin: string, args: string[]) => {
    try { const result = await exec(bin, args, { env, timeout: 10_000 }); return { code: 0, output: `${result.stdout}${result.stderr}` }; }
    catch (error) { const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string }; return { code: typeof e.code === 'number' ? e.code : 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` }; }
  };
  const systemctl = async (...args: string[]) => call('systemctl', ['--user', ...args]);
  const launchctl = async (...args: string[]) => call('launchctl', args);
  const rotateLog = async () => {
    if (!logFile) return;
    const size = await fs.stat(logFile).then(s => s.size).catch(() => 0);
    if (size < 5 * 1024 * 1024) return;
    await fs.rm(`${logFile}.1`, { force: true }); await fs.rename(logFile, `${logFile}.1`);
  };
  const runningInfo = async () => {
    if (platform === 'linux') {
      const r = await systemctl('show', unitName, '--property=LoadState,ActiveState,MainPID,ExecMainStatus,Result', '--no-pager');
      const props = Object.fromEntries(r.output.split('\n').filter(x => x.includes('=')).map(x => { const i=x.indexOf('='); return [x.slice(0,i), x.slice(i+1)]; }));
      return { installed: (await fs.access(unitFile).then(() => true, () => false)), loaded: props.LoadState === 'loaded', running: props.ActiveState === 'active', pid: Number(props.MainPID) || null, lastExit: props.ExecMainStatus ?? props.Result ?? null };
    }
    const installed = await fs.access(unitFile).then(() => true, () => false);
    const r = await launchctl('print', `${domain}/${LABEL}`);
    const match = r.output.match(/\bpid\s*=\s*(\d+)/); const exit = r.output.match(/last exit code\s*=\s*(-?\d+)/i);
    return { installed, loaded: r.code === 0, running: r.code === 0 && /state\s*=\s*running/.test(r.output), pid: match ? Number(match[1]) : null, lastExit: exit ? Number(exit[1]) : null };
  };
  if (o.action === 'status') {
    const status = await runningInfo(); let host: string | null = null;
    const stored = await fs.readFile(metadataFile, 'utf8').then(JSON.parse).catch(() => undefined) as { url?: string } | undefined;
    const urlValue = o.url ?? stored?.url;
    if (urlValue) { try { host = new URL(urlValue).host; } catch { fail('--url must be a valid URL'); } }
    return { ...status, serverHost: host };
  }
  if (o.action === 'logs') {
    if (platform === 'linux') { const r = await call('journalctl', ['--user', '-u', unitName, '-n', '200', '--no-pager']); return r.output || 'No service journal entries yet.'; }
    if (!logFile) return '';
    return await fs.readFile(logFile, 'utf8').catch(() => 'No service log yet.');
  }
  if (!['install','uninstall','start','stop'].includes(o.action)) fail('usage: mdb service install|uninstall|status|start|stop|logs');
  if (['install','start'].includes(o.action) && env.ENGRAM_AUTO_RECONNECT === '0') fail('client service is disabled by ENGRAM_AUTO_RECONNECT=0');
  if (o.action === 'install') {
    const urlText = o.url ?? env.ENGRAM_MCP_URL;
    if (!urlText) fail('--url is required (or set ENGRAM_MCP_URL)');
    let url: URL; try { url = new URL(urlText); } catch { fail('--url must be an absolute HTTP(S) URL'); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('--url must be HTTP(S) without embedded credentials, query, or fragment');
    const tokenFile = path.resolve(o.tokenFile ?? env.ENGRAM_TOKEN_FILE ?? '');
    if (!tokenFile || tokenFile === path.resolve('.')) fail('--token-file is required (or set ENGRAM_TOKEN_FILE)');
    const token = await fs.stat(tokenFile).catch(() => undefined);
    if (!token?.isFile() || (token.mode & 0o777) !== 0o600) fail('token file must exist and have mode 0600');
    const outbox = path.resolve(o.outbox ?? env.ENGRAM_OUTBOX ?? path.join(home, '.local/share/engram/outbox'));
    const mdb = process.argv[1] ?? 'mdb';
    const text = watcherServiceText(platform, { node: process.execPath, mdb, url: url.toString(), tokenFile, ...(o.workspace ? { workspaceId: o.workspace } : {}), outbox, ...(o.projectDir ? { projectDir: path.resolve(o.projectDir) } : {}), ...(logFile ? { logFile } : {}), daemon: true, allowRoot: uid === 0 && !!o.allowRoot });
    if (o.dryRun) return text;
    const existing = await runningInfo();
    if (existing.installed) {
      const current = await fs.readFile(unitFile, 'utf8');
      if (current !== text) fail('service is already installed with different settings; uninstall before changing configuration');
      if (platform === 'linux') { const enabled = await systemctl('enable', '--now', unitName); if (enabled.code) fail(enabled.output); }
      else if (!existing.loaded) { const result = await launchctl('bootstrap', domain, unitFile); if (result.code) fail(result.output); }
      return { installed: true, changed: false, unitFile };
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 }); if (logFile) { await fs.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 }); await rotateLog(); }
    await fs.writeFile(unitFile, text, { mode: 0o600, flag: 'wx' });
    let metadataCreated = false;
    try {
      await fs.writeFile(metadataFile, JSON.stringify({ url: url.toString() }), { mode: 0o600, flag: 'wx' });
      metadataCreated = true;
      if (platform === 'linux') { const reload = await systemctl('daemon-reload'); if (reload.code) fail(reload.output); const enable = await systemctl('enable', '--now', unitName); if (enable.code) fail(enable.output); }
      else { const load = await launchctl('bootstrap', domain, unitFile); if (load.code) fail(load.output); }
    } catch (error) { await fs.rm(unitFile, { force: true }); if (metadataCreated) await fs.rm(metadataFile, { force: true }); if (platform === 'linux') await systemctl('daemon-reload'); throw error; }
    return { installed: true, changed: true, unitFile, serverHost: url.host };
  }
  const status = await runningInfo();
  if (o.action === 'start') {
    if (!status.installed) fail('service is not installed; run mdb service install first');
    await rotateLog();
    if (platform === 'linux') { const r = await systemctl('start', unitName); if (r.code) fail(r.output); }
    else if (status.loaded) { const r = await launchctl('kickstart', '-k', `${domain}/${LABEL}`); if (r.code) fail(r.output); }
    else { const r = await launchctl('bootstrap', domain, unitFile); if (r.code) fail(r.output); }
    return { started: true };
  }
  if (o.action === 'stop') {
    if (!status.installed) return { stopped: true, installed: false };
    const r = platform === 'linux' ? await systemctl('stop', unitName) : await launchctl('bootout', `${domain}/${LABEL}`);
    if (r.code && status.loaded) fail(r.output); return { stopped: true, installed: true };
  }
  if (!status.installed) return { installed: false, removed: false };
  if (platform === 'linux') {
    const disabled = await systemctl('disable', '--now', unitName); if (disabled.code) fail(disabled.output);
    const reload = await systemctl('daemon-reload'); if (reload.code) fail(reload.output);
  }
  else if (status.loaded) { const r = await launchctl('bootout', `${domain}/${LABEL}`); if (r.code) fail(r.output); }
  await fs.rm(unitFile, { force: true }); await fs.rm(metadataFile, { force: true }); return { installed: false, removed: true };
}

export async function runClientDaemon(options: { url: string; tokenFile: string; workspace?: string; outbox?: string; projectDir?: string; logFile?: string; allowRoot?: boolean }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if ((process.getuid?.() ?? 1) === 0 && !options.allowRoot) fail('refusing to run client service as root');
  if (env.ENGRAM_AUTO_RECONNECT === '0') fail('client service is disabled by ENGRAM_AUTO_RECONNECT=0');
  const info = await fs.stat(options.tokenFile).catch(() => undefined);
  if (!info?.isFile() || (info.mode & 0o777) !== 0o600) fail('token file must exist and have mode 0600');
  const token = (await fs.readFile(options.tokenFile, 'utf8')).trim();
  if (!token) fail('token file is empty');
  const outbox = path.resolve(options.outbox ?? defaultOutboxDirectory());
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : undefined;
  let pending = Promise.resolve();
  const log = (entry: unknown) => {
    pending = pending.then(async () => {
      if (!options.logFile) { process.stderr.write(`${JSON.stringify(entry)}\n`); return; }
      const logFile = path.resolve(options.logFile);
      await fs.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
      const size = await fs.stat(logFile).then(s => s.size).catch(() => 0);
      if (size >= 1024 * 1024) {
        await fs.rm(`${logFile}.2`, { force: true });
        await fs.rename(`${logFile}.1`, `${logFile}.2`).catch(() => undefined);
        await fs.rename(logFile, `${logFile}.1`).catch(() => undefined);
      }
      await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }).catch(() => undefined);
  };
  const abort = new AbortController(); const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await watchOutbox({ url: options.url, token, ...(options.workspace ? { workspaceId: options.workspace } : {}), outbox, ...(projectDir ? { projectDir, syncProject: async () => { const binding = await readBinding(projectDir); if (binding.serverUrl && await isTrusted(projectDir, binding)) await reconcile({ projectDir, binding, sink: remoteSink(binding) }); } } : {}), signal: abort.signal, onEvent: log });
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await pending; }
}
