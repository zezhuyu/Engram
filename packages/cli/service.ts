import { promises as fs } from 'node:fs';
import { constants, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watcherServiceText } from '../memory/outbox-watch.js';
import { watchOutbox } from '../memory/outbox-watch.js';
import { defaultOutboxDirectory } from '../memory/outbox.js';
import { readBinding } from '../core/project-binding.js';
import { isTrusted } from '../core/project-trust.js';
import { reconcile, remoteSink } from '../memory/file-sync.js';
import { remoteUrlAllowed } from '../core/private-network.js';

const exec = promisify(execFile);
const LABEL = 'dev.engram.outbox-watch';
const DASHBOARD_LABEL = 'dev.engram.client-dashboard';
const REPLICA_LABEL='dev.engram.replica-sync';
type Options = { action: string; platform?: 'macos' | 'linux'; role?: 'client' | 'server'; home?: string; noteFile?: string; uid?: number; url?: string; tokenFile?: string; workspace?: string; outbox?: string; projectDir?: string; dryRun?: boolean; allowRoot?: boolean };
function fail(message: string): never { throw new Error(message); }

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function unitSettings(text: string, platform: 'macos' | 'linux') {
  const values = platform === 'macos'
    ? [...text.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => (match[1] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    : (() => {
      const line = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? '';
      return [...line.matchAll(/'((?:[^']|'\\''|\\.)*)'|"((?:\\.|[^"\\])*)"|(\S+)/g)].map(match => (match[1] ?? match[2] ?? match[3] ?? '').replace(/'\\''/g, "'").replace(/\\([\\"'$`])/g, '$1'));
    })();
  const result: Record<string, string | undefined> = {};
  for (const flag of ['--url', '--token-file', '--workspace', '--outbox', '--project-dir']) {
    const index = values.indexOf(flag); result[flag] = index >= 0 ? values[index + 1] : undefined;
  }
  return result;
}
function sameServiceSettings(left: string, right: string, platform: 'macos' | 'linux'): boolean {
  const a = unitSettings(left, platform), b = unitSettings(right, platform);
  return ['--url', '--token-file', '--workspace', '--outbox', '--project-dir'].every(key => a[key] === b[key]);
}
function dashboardPort(env: NodeJS.ProcessEnv, home: string): number {
  const file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'engram/client.env');
  const text = (() => { try { return readFileSync(file, 'utf8'); } catch { return ''; } })();
  const configured = text.split(/\r?\n/).map(line => /^\s*(?:export\s+)?ENGRAM_CLIENT_DASHBOARD_PORT\s*=\s*(.*?)\s*$/.exec(line)?.[1]).find(Boolean)?.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');
  const value = env.ENGRAM_CLIENT_DASHBOARD_PORT ?? configured ?? '4872';
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('ENGRAM_CLIENT_DASHBOARD_PORT must be an integer between 1 and 65535');
  return port;
}

/** Read the private dashboard note without ever exposing its token outside the returned URL. */
export async function dashboardUrl(o: Pick<Options, 'role' | 'home' | 'noteFile' | 'platform'> = {}, env: NodeJS.ProcessEnv = process.env) {
  const role = o.role ?? 'client';
  const home = path.resolve(o.home ?? env.HOME ?? '');
  if (!home || home === '.') fail('HOME is unavailable');
  let serverPort: string | undefined;
  if (role === 'server' && env.ENGRAM_DASHBOARD_PORT === undefined) {
    const configDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'engram');
    for (const config of ['engram.env', 'server.env']) {
      const text = await fs.readFile(path.join(configDir, config), 'utf8').catch(() => '');
      serverPort = text.split(/\r?\n/).map(line => /^\s*(?:export\s+)?ENGRAM_DASHBOARD_PORT\s*=\s*(.*?)\s*$/.exec(line)?.[1]).find(Boolean)?.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '') ?? serverPort;
    }
  }
  const portValue = role === 'server' ? env.ENGRAM_DASHBOARD_PORT ?? serverPort ?? '4871' : String(dashboardPort(env, home));
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${role === 'server' ? 'ENGRAM_DASHBOARD_PORT' : 'ENGRAM_CLIENT_DASHBOARD_PORT'} must be an integer between 1 and 65535`);
  const plain = `http://127.0.0.1:${port}/`;
  const note = o.noteFile ?? env.MDB_DASHBOARD_NOTE ?? path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'engram', role === 'server' ? 'dashboard.txt' : 'client-dashboard.txt');
  const platform = o.platform ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined);
  const unitActive = async () => {
    if (!platform) return false;
    const uid = process.getuid?.() ?? 1;
    try {
      if (platform === 'linux') {
        const unit = role === 'server' ? 'org.engram.server.worker.service' : 'engram-client-dashboard.service';
        const result = await exec('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--no-pager'], { env, timeout: 3_000 });
        return /^ActiveState=active$/m.test(result.stdout);
      }
      const targets = role === 'server' ? [`gui/${uid}/org.engram.server.worker`, 'system/org.engram.server.boot'] : [`gui/${uid}/${DASHBOARD_LABEL}`];
      for (const target of targets) {
        try {
          const result = await exec('launchctl', ['print', target], { env, timeout: 3_000 });
          if (/\bstate\s*=\s*running\b/.test(result.stdout)) return true;
        } catch { /* Try the other supervised server target, if any. */ }
      }
      return false;
    } catch { return false; }
  };
  if (!await unitActive()) return { url: plain, firstTimeSetup: false, passwordSet: false, port, noteAvailable: false };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(note, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || ![0o600, 0o400].includes(info.mode & 0o777) || info.size > 64 * 1024) return { url: plain, firstTimeSetup: false, passwordSet: false, port, noteAvailable: false };
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) return { url: plain, firstTimeSetup: false, passwordSet: false, port, noteAvailable: false };
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const passwordLine = /^\s*Dashboard password:\s*(set|not set)\s*$/mi.exec(text)?.[1]?.toLowerCase();
    if (!passwordLine) return { url: plain, firstTimeSetup: false, passwordSet: false, port, noteAvailable: false };
    const passwordSet = passwordLine === 'set';
    const candidate = text.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('http://'));
    let setupUrl: string | undefined;
    if (candidate) {
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol === 'http:' && !parsed.username && !parsed.password && parsed.port === String(port) && parsed.pathname === '/' && !parsed.search && /^#t=[0-9a-f]{64}$/i.test(parsed.hash)) {
          if (role === 'server' || parsed.hostname === '127.0.0.1') setupUrl = `http://127.0.0.1:${port}/#t=${parsed.hash.slice(3)}`;
        }
      } catch { /* Ignore non-dashboard URLs in the note. */ }
    }
    if (!passwordSet && !setupUrl) return { url: plain, firstTimeSetup: false, passwordSet: false, port, noteAvailable: false };
    return { url: !passwordSet && setupUrl ? setupUrl : plain, firstTimeSetup: !passwordSet && !!setupUrl, passwordSet, port, noteAvailable: true };
  } catch {
    return { url: plain, firstTimeSetup: false, passwordSet: false, port, noteAvailable: false };
  } finally { await handle?.close().catch(() => undefined); }
}

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
  const dashboardUnitFile = path.join(directory, platform === 'macos' ? `${DASHBOARD_LABEL}.plist` : 'engram-client-dashboard.service');
  const dashboardWrapper = path.join(directory, 'engram-client-dashboard.sh');
  const dashboardLog = path.join(home, 'Library/Logs/Engram/client-dashboard.log');
  const dashboardNote = path.join(home, '.config/engram/client-dashboard.txt');
  const dashboardUnitName = platform === 'macos' ? DASHBOARD_LABEL : 'engram-client-dashboard.service';
  const replicaUnitFile=path.join(directory,platform==='macos'?`${REPLICA_LABEL}.plist`:'engram-replica-sync.service');
  const replicaUnitName=platform==='macos'?REPLICA_LABEL:'engram-replica-sync.service';
  const domain = `gui/${uid}`;
  const call = async (bin: string, args: string[]) => {
    try { const result = await exec(bin, args, { env, timeout: 10_000 }); return { code: 0, output: `${result.stdout}${result.stderr}` }; }
    catch (error) { const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string }; return { code: typeof e.code === 'number' ? e.code : 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` }; }
  };
  const systemctl = async (...args: string[]) => call('systemctl', ['--user', ...args]);
  const launchctl = async (...args: string[]) => call('launchctl', args);
  const replicaService=async(action:'install'|'status'|'start'|'stop'|'uninstall')=>{
    const {listReplicaConfigs}=await import('../replication/client.js');const configs=await listReplicaConfigs();
    const status=async()=>{const installed=await fs.access(replicaUnitFile).then(()=>true,()=>false);if(platform==='linux'){const r=await systemctl('show',replicaUnitName,'--property=LoadState,ActiveState,MainPID','--no-pager');return{installed,running:/ActiveState=active/.test(r.output),loaded:/LoadState=loaded/.test(r.output),output:r.output};}const r=await launchctl('print',`${domain}/${REPLICA_LABEL}`);return{installed,running:/state\s*=\s*running/.test(r.output),loaded:r.code===0,output:r.output};};
    if(!configs.length){if(action==='status')return{installed:false,configured:false,reason:'replica sync daemon is unavailable until mdb replica init creates a replica'};return{installed:false,configured:false,reason:'no initialized replica; replica sync service was not installed'};}
    if(configs.length!==1)return{installed:false,configured:true,reason:'replica sync service expects one configured replica; multiple replicas are configured'};
    const id=configs[0]!.replicaId,node=process.execPath,mdb=process.argv[1]??'mdb.js',args=[node,mdb,'replica','daemon','--id',id];const xml=(v:string)=>v.replace(/&/g,'&amp;').replace(/</g,'&lt;');const unit=platform==='macos'?`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${REPLICA_LABEL}</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer></dict></plist>\n`:`[Unit]\nDescription=Engram replica synchronization daemon\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${args.map(shellQuote).join(' ')}\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`;
    if(action==='status'){const s=await status();return{...s,unitFile:replicaUnitFile,replicaId:id};}
    if(action==='install'){await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.writeFile(replicaUnitFile,unit,{mode:0o600});await fs.chmod(replicaUnitFile,0o600);if(platform==='linux'){const reload=await systemctl('daemon-reload');if(reload.code)fail(reload.output);const r=await systemctl('enable','--now',replicaUnitName);if(r.code)fail(r.output);}else{const loaded=await launchctl('print',`${domain}/${REPLICA_LABEL}`);if(loaded.code===0)await launchctl('bootout',`${domain}/${REPLICA_LABEL}`);const r=await launchctl('bootstrap',domain,replicaUnitFile);if(r.code)fail(r.output);}return{installed:true,unitFile:replicaUnitFile,replicaId:id};}
    const s=await status();if(action==='start'){if(!s.installed)throw new Error('replica sync service is not installed');const r=platform==='linux'?await systemctl('start',replicaUnitName):s.loaded?await launchctl('kickstart','-k',`${domain}/${REPLICA_LABEL}`):await launchctl('bootstrap',domain,replicaUnitFile);if(r.code)fail(r.output);return{started:true,replicaId:id};}
    if(action==='stop'){if(!s.installed)return{stopped:true,installed:false};const r=platform==='linux'?await systemctl('stop',replicaUnitName):await launchctl('bootout',`${domain}/${REPLICA_LABEL}`);if(r.code&&s.loaded)fail(r.output);return{stopped:true,installed:true};}
    if(s.installed){const r=platform==='linux'?await systemctl('disable','--now',replicaUnitName):await launchctl('bootout',`${domain}/${REPLICA_LABEL}`);if(r.code&&s.loaded)fail(r.output);}await fs.rm(replicaUnitFile,{force:true});if(platform==='linux')await systemctl('daemon-reload');return{removed:true,installed:false};
  };
  const rotateLog = async () => {
    const rotate = async (file: string, limit: number) => {
      const size = await fs.stat(file).then(s => s.size).catch(() => 0);
      if (size < limit) return;
      await fs.rm(`${file}.1`, { force: true }); await fs.rename(file, `${file}.1`);
    };
    if (logFile) await rotate(logFile, 5 * 1024 * 1024);
    await rotate(dashboardLog, 5 * 1024 * 1024);
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
  const dashboardRunningInfo = async () => {
    const installed = await fs.access(dashboardUnitFile).then(() => true, () => false);
    const wrapperText = installed ? await fs.readFile(dashboardWrapper, 'utf8').catch(() => '') : '';
    const installedPort = Number(/--port\s+(\d+)/.exec(wrapperText)?.[1]) || dashboardPort(env, home);
    if (platform === 'linux') {
      const r = await systemctl('show', dashboardUnitName, '--property=LoadState,ActiveState,MainPID,ExecMainStatus,Result', '--no-pager');
      const props = Object.fromEntries(r.output.split('\n').filter(x => x.includes('=')).map(x => { const i=x.indexOf('='); return [x.slice(0,i), x.slice(i+1)]; }));
      return { installed, loaded: props.LoadState === 'loaded', running: props.ActiveState === 'active', pid: Number(props.MainPID) || null, lastExit: props.ExecMainStatus ?? props.Result ?? null, port: installedPort, host: '127.0.0.1' };
    }
    const r = await launchctl('print', `${domain}/${DASHBOARD_LABEL}`), match = r.output.match(/\bpid\s*=\s*(\d+)/), exit = r.output.match(/last exit code\s*=\s*(-?\d+)/i);
    return { installed, loaded: r.code === 0, running: r.code === 0 && /state\s*=\s*running/.test(r.output), pid: match ? Number(match[1]) : null, lastExit: exit ? Number(exit[1]) : null, port: installedPort, host: '127.0.0.1' };
  };
  const createDashboardDefinition = async () => {
    const port = dashboardPort(env, home), node = path.resolve(process.execPath), mdb = path.resolve(process.argv[1] ?? 'mdb');
    await fs.mkdir(path.dirname(dashboardNote), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(dashboardLog), { recursive: true, mode: 0o700 });
    const authFile = path.join(home, 'Library/Application Support/Engram/client-dashboard/auth.json');
    const xdgConfig = env.XDG_CONFIG_HOME ? `export XDG_CONFIG_HOME=${shellQuote(path.resolve(env.XDG_CONFIG_HOME))}\n` : '';
    const script = `#!/bin/sh\nset -eu\numask 077\n${xdgConfig}mkdir -p ${shellQuote(path.dirname(dashboardNote))} ${shellQuote(path.dirname(dashboardLog))}\n: > ${shellQuote(dashboardNote)}\nchmod 600 ${shellQuote(dashboardNote)}\nexport MDB_DASHBOARD_TOKEN_NOTE=${shellQuote(dashboardNote)}\nexec ${shellQuote(node)} ${shellQuote(mdb)} dashboard --client --host 127.0.0.1 --port ${port} > ${shellQuote(dashboardNote)} 2>> ${shellQuote(dashboardLog)}\n`;
    const args = ['/bin/sh', dashboardWrapper];
    const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const unit = platform === 'macos'
      ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${DASHBOARD_LABEL}</string>\n<key>ProgramArguments</key><array>${args.map(x => `<string>${xml(x)}</string>`).join('')}</array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>\n<key>StandardOutPath</key><string>${xml(dashboardLog)}</string><key>StandardErrorPath</key><string>${xml(dashboardLog)}</string>\n</dict></plist>\n`
      : `[Unit]\nDescription=Engram client dashboard (engram-client-dashboard.service, loopback only)\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${args.map(x => /^[\\w@%+=:,./-]+$/.test(x) ? x : shellQuote(x)).join(' ')}\nRestart=on-failure\nRestartSec=10\nStandardOutput=append:${dashboardLog}\nStandardError=append:${dashboardLog}\n\n[Install]\nWantedBy=default.target\n`;
    return { script, unit, port, node, mdb, authFile };
  };
  if (o.action === 'status') {
    const [status, clientDashboard] = await Promise.all([runningInfo(), dashboardRunningInfo()]); let host: string | null = null;
    const stored = await fs.readFile(metadataFile, 'utf8').then(JSON.parse).catch(() => undefined) as { url?: string; tokenFile?: string } | undefined;
    const urlValue = o.url ?? stored?.url;
    if (urlValue) { try { host = new URL(urlValue).host; } catch { fail('--url must be a valid URL'); } }
    return { ...status, serverHost: host, serverUrl: stored?.url ?? null, tokenFile: stored?.tokenFile ?? null, clientDashboard, replicaSync:await replicaService('status') };
  }
  if (o.action === 'logs') {
    if (platform === 'linux') { const r = await call('journalctl', ['--user', '-u', unitName, '-n', '200', '--no-pager']); return r.output || 'No service journal entries yet.'; }
    if (!logFile) return '';
    return await fs.readFile(logFile, 'utf8').catch(() => 'No service log yet.');
  }
  if (o.action === 'reconfigure') {
    const url = o.url; if (!url) fail('--url is required');
    let parsed: URL; try { parsed = new URL(url); } catch { fail('--url must be an absolute URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !remoteUrlAllowed(parsed, env)) fail('--url must be HTTPS, loopback, or an opted-in tailnet URL without credentials, query, or fragment');
    const tokenFile = path.resolve(o.tokenFile ?? ''); if (!o.tokenFile) fail('--token-file is required');
    const token = await fs.open(tokenFile, 'r').catch(() => undefined);
    if (!token) fail('token file is unavailable');
    try { const info = await token.stat(); if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || ![0o600, 0o400].includes(info.mode & 0o777)) fail('token file must be an owned regular file with mode 0600 or 0400'); }
    finally { await token.close(); }
    const before = await fs.readFile(unitFile, 'utf8').catch(() => undefined);
    if (before === undefined) fail('outbox service is not installed');
    const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const shell = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
    let next = before;
    if (platform === 'macos') {
      const replaceArg = (name: string, value: string) => {
        const expression = new RegExp(`(<string>${name}</string>\\s*<string>)([\\s\\S]*?)(</string>)`);
        if (!expression.test(next)) fail(`outbox service has no ${name} setting`);
        next = next.replace(expression, (_match, prefix: string, _old: string, suffix: string) => `${prefix}${xml(value)}${suffix}`);
      };
      replaceArg('--url', parsed.toString()); replaceArg('--token-file', tokenFile);
    } else {
      const replaceArg = (name: string, value: string) => {
        const expression = new RegExp(`(${name}\\s+)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s]+)`);
        if (!expression.test(next)) fail(`outbox service has no ${name} setting`);
        next = next.replace(expression, (_match, prefix: string) => `${prefix}${shell(value)}`);
      };
      replaceArg('--url', parsed.toString()); replaceArg('--token-file', tokenFile);
    }
    const metadata = await fs.readFile(metadataFile, 'utf8').then(text => JSON.parse(text) as Record<string, unknown>).catch(() => ({}));
    const metadataNext = JSON.stringify({ ...metadata, url: parsed.toString(), tokenFile });
    const oldMetadata = await fs.readFile(metadataFile, 'utf8').catch(() => undefined);
    const unitTemp = `${unitFile}.${process.pid}.tmp`, metaTemp = `${metadataFile}.${process.pid}.tmp`;
    try {
      await fs.writeFile(unitTemp, next, { mode: 0o600 }); await fs.chmod(unitTemp, 0o600); await fs.rename(unitTemp, unitFile);
      await fs.writeFile(metaTemp, metadataNext, { mode: 0o600 }); await fs.chmod(metaTemp, 0o600); await fs.rename(metaTemp, metadataFile);
      if (platform === 'linux') { const reload = await systemctl('daemon-reload'); if (reload.code) fail(reload.output); const restart = await systemctl('restart', unitName); if (restart.code) fail(restart.output); }
      else { const state = await runningInfo(); if (state.loaded) { const restart = await launchctl('kickstart', '-k', `${domain}/${LABEL}`); if (restart.code) fail(restart.output); } else { const load = await launchctl('bootstrap', domain, unitFile); if (load.code) fail(load.output); } }
    } catch (error) {
      await fs.writeFile(unitTemp, before, { mode: 0o600 }).then(() => fs.rename(unitTemp, unitFile)).catch(() => undefined);
      if (oldMetadata === undefined) await fs.rm(metadataFile, { force: true }); else await fs.writeFile(metaTemp, oldMetadata, { mode: 0o600 }).then(() => fs.rename(metaTemp, metadataFile)).catch(() => undefined);
      if (platform === 'linux') { await systemctl('daemon-reload').catch(() => undefined); await systemctl('restart', unitName).catch(() => undefined); }
      else { await launchctl('kickstart', '-k', `${domain}/${LABEL}`).catch(() => undefined); }
      throw error;
    } finally { await fs.rm(unitTemp, { force: true }); await fs.rm(metaTemp, { force: true }); }
    return { reconfigured: true, serverHost: parsed.host };
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
    const dashboard = await createDashboardDefinition();
    if (o.dryRun) return JSON.stringify({ outbox: text, clientDashboard: dashboard.unit, launcher: dashboard.script });
    const existing = await runningInfo();
    const dashboardExisting = await dashboardRunningInfo();
    if (existing.installed) {
      const current = await fs.readFile(unitFile, 'utf8');
      if (!sameServiceSettings(current, text, platform)) fail('service is already installed with different settings; uninstall before changing configuration');
      if (dashboardExisting.installed && dashboardExisting.port !== dashboard.port) fail('service is already installed with different settings; uninstall before changing configuration');
      let outboxResult: 'upgraded' | 'unchanged' = 'unchanged';
      if (current !== text) {
        await fs.writeFile(unitFile, text, { mode: 0o600 }); await fs.chmod(unitFile, 0o600);
        if (platform === 'linux') {
          const reload = await systemctl('daemon-reload'); if (reload.code) fail(reload.output);
          if (existing.running) { const restart = await systemctl('restart', unitName); if (restart.code) fail(restart.output); }
          else { const enable = await systemctl('enable', '--now', unitName); if (enable.code) fail(enable.output); }
        } else {
          if (existing.loaded) { const down = await launchctl('bootout', `${domain}/${LABEL}`); if (down.code) fail(down.output); }
          const load = await launchctl('bootstrap', domain, unitFile); if (load.code) fail(load.output);
        }
        outboxResult = 'upgraded';
      }
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.dirname(dashboardNote), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.dirname(dashboardLog), { recursive: true, mode: 0o700 }); await rotateLog();
      const dashboardCurrent = await fs.readFile(dashboardUnitFile, 'utf8').catch(() => '');
      const dashboardWrapperCurrent = await fs.readFile(dashboardWrapper, 'utf8').catch(() => '');
      let dashboardResult: 'installed' | 'upgraded' | 'unchanged';
      if (!dashboardExisting.installed) {
        await fs.writeFile(dashboardWrapper, dashboard.script, { mode: 0o700 }); await fs.chmod(dashboardWrapper, 0o700);
        await fs.writeFile(dashboardUnitFile, dashboard.unit, { mode: 0o600 }); await fs.chmod(dashboardUnitFile, 0o600);
        if (platform === 'linux') { const reload = await systemctl('daemon-reload'); if (reload.code) fail(reload.output); const enable = await systemctl('enable', '--now', dashboardUnitName); if (enable.code) fail(enable.output); }
        else { const load = await launchctl('bootstrap', domain, dashboardUnitFile); if (load.code) fail(load.output); }
        dashboardResult = 'installed';
      } else if (dashboardCurrent !== dashboard.unit || dashboardWrapperCurrent !== dashboard.script) {
        if (platform === 'linux' && dashboardExisting.running) { const stop = await systemctl('stop', dashboardUnitName); if (stop.code) fail(stop.output); }
        if (platform === 'macos' && dashboardExisting.loaded) { const down = await launchctl('bootout', `${domain}/${DASHBOARD_LABEL}`); if (down.code) fail(down.output); }
        await fs.writeFile(dashboardWrapper, dashboard.script, { mode: 0o700 }); await fs.chmod(dashboardWrapper, 0o700);
        await fs.writeFile(dashboardUnitFile, dashboard.unit, { mode: 0o600 }); await fs.chmod(dashboardUnitFile, 0o600);
        if (platform === 'linux') { const reload = await systemctl('daemon-reload'); if (reload.code) fail(reload.output); const start = await systemctl('enable', '--now', dashboardUnitName); if (start.code) fail(start.output); }
        else { const load = await launchctl('bootstrap', domain, dashboardUnitFile); if (load.code) fail(load.output); }
        dashboardResult = 'upgraded';
      } else dashboardResult = 'unchanged';
      if (platform === 'linux') {
        if (!existing.running) { const enabled = await systemctl('enable', '--now', unitName); if (enabled.code) fail(enabled.output); }
        if (dashboardResult === 'unchanged' && !dashboardExisting.running) { const enabled = await systemctl('enable', '--now', dashboardUnitName); if (enabled.code) fail(enabled.output); }
      }
      else { if (!existing.loaded) { const result = await launchctl('bootstrap', domain, unitFile); if (result.code) fail(result.output); } if (dashboardResult === 'unchanged' && !dashboardExisting.loaded) { const result = await launchctl('bootstrap', domain, dashboardUnitFile); if (result.code) fail(result.output); } }
      return { installed: true, outbox: outboxResult, dashboard: dashboardResult, clientDashboard: dashboardExisting, replicaSync:await replicaService('install'), changed: outboxResult !== 'unchanged' || dashboardResult !== 'unchanged', unitFile, dashboardUnitFile };
    }
    if (dashboardExisting.installed) fail('client dashboard is already installed without its outbox service; uninstall before reinstalling both units');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 }); if (logFile) { await fs.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 }); await rotateLog(); }
    await fs.mkdir(path.dirname(dashboardLog), { recursive: true, mode: 0o700 }); await rotateLog();
    await fs.writeFile(unitFile, text, { mode: 0o600, flag: 'wx' });
    let metadataCreated = false;
    try {
      await fs.writeFile(dashboardWrapper, dashboard.script, { mode: 0o700, flag: 'wx' });
      await fs.writeFile(dashboardUnitFile, dashboard.unit, { mode: 0o600, flag: 'wx' });
      await fs.writeFile(metadataFile, JSON.stringify({ url: url.toString(), tokenFile }), { mode: 0o600, flag: 'wx' });
      metadataCreated = true;
      if (platform === 'linux') { const reload = await systemctl('daemon-reload'); if (reload.code) fail(reload.output); const enable = await systemctl('enable', '--now', unitName); if (enable.code) fail(enable.output); const dashboardEnable = await systemctl('enable', '--now', dashboardUnitName); if (dashboardEnable.code) fail(dashboardEnable.output); }
      else { const load = await launchctl('bootstrap', domain, unitFile); if (load.code) fail(load.output); const dashboardLoad = await launchctl('bootstrap', domain, dashboardUnitFile); if (dashboardLoad.code) fail(dashboardLoad.output); }
    } catch (error) { await fs.rm(unitFile, { force: true }); await fs.rm(dashboardUnitFile, { force: true }); await fs.rm(dashboardWrapper, { force: true }); if (metadataCreated) await fs.rm(metadataFile, { force: true }); if (platform === 'linux') await systemctl('daemon-reload'); throw error; }
    return { installed: true, outbox: 'installed', dashboard: 'installed', replicaSync:await replicaService('install'), changed: true, unitFile, dashboardUnitFile, dashboardPort: dashboard.port, serverHost: url.host };
  }
  const status = await runningInfo();
  if (o.action === 'start') {
    if (!status.installed) fail('service is not installed; run mdb service install first');
    await rotateLog();
    if (platform === 'linux') { const r = await systemctl('start', unitName); if (r.code) fail(r.output); }
    else if (status.loaded) { const r = await launchctl('kickstart', '-k', `${domain}/${LABEL}`); if (r.code) fail(r.output); }
    else { const r = await launchctl('bootstrap', domain, unitFile); if (r.code) fail(r.output); }
    const dashboardStatus = await dashboardRunningInfo();
    if (!dashboardStatus.installed) fail('client dashboard is not installed; run mdb service install');
    if (platform === 'linux') { const r = await systemctl('start', dashboardUnitName); if (r.code) fail(r.output); }
    else if (dashboardStatus.loaded) { const r = await launchctl('kickstart', '-k', `${domain}/${DASHBOARD_LABEL}`); if (r.code) fail(r.output); }
    else { const r = await launchctl('bootstrap', domain, dashboardUnitFile); if (r.code) fail(r.output); }
    return { started: true, clientDashboard: dashboardStatus, replicaSync:await replicaService('start') };
  }
  if (o.action === 'stop') {
    const dashboardStatus = await dashboardRunningInfo();
    if (!status.installed && !dashboardStatus.installed) return { stopped: true, installed: false, replicaSync:await replicaService('stop') };
    if (dashboardStatus.installed) { const r = platform === 'linux' ? await systemctl('stop', dashboardUnitName) : await launchctl('bootout', `${domain}/${DASHBOARD_LABEL}`); if (r.code && dashboardStatus.loaded) fail(r.output); }
    if (status.installed) { const r = platform === 'linux' ? await systemctl('stop', unitName) : await launchctl('bootout', `${domain}/${LABEL}`); if (r.code && status.loaded) fail(r.output); }
    return { stopped: true, installed: status.installed || dashboardStatus.installed, replicaSync:await replicaService('stop') };
  }
  const dashboardStatus = await dashboardRunningInfo();
  if (!status.installed && !dashboardStatus.installed) return { installed: false, removed: false, replicaSync:await replicaService('uninstall') };
  if (platform === 'linux') {
    if (dashboardStatus.installed) { const disabled = await systemctl('disable', '--now', dashboardUnitName); if (disabled.code) fail(disabled.output); }
    if (status.installed) { const disabled = await systemctl('disable', '--now', unitName); if (disabled.code) fail(disabled.output); }
    const reload = await systemctl('daemon-reload'); if (reload.code) fail(reload.output);
  }
  else {
    if (dashboardStatus.loaded) { const r = await launchctl('bootout', `${domain}/${DASHBOARD_LABEL}`); if (r.code) fail(r.output); }
    if (status.loaded) { const r = await launchctl('bootout', `${domain}/${LABEL}`); if (r.code) fail(r.output); }
  }
  await fs.rm(unitFile, { force: true }); await fs.rm(dashboardUnitFile, { force: true }); await fs.rm(dashboardWrapper, { force: true }); await fs.rm(metadataFile, { force: true }); return { installed: false, removed: true, replicaSync:await replicaService('uninstall') };
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
