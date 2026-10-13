#!/usr/bin/env node
// This file is copied into each Linux bundle; it has no repository dependencies.
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function quote(value, command = false) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid service path');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => command ? '$$' : '$') + '"';
}
export function serviceDefinition({ role, bundle, home, user }) {
  if (!['client', 'server'].includes(role)) throw new Error('Unknown service role');
  if (user && (!/^[A-Za-z0-9_.-]{1,64}$/.test(user) || user === 'root')) throw new Error('Select a valid non-root service user');
  if (!home.startsWith('/') || home.trim() !== home || /[\r\n\0]/.test(home)) throw new Error('Invalid service home');
  // WorkingDirectory is a single path, unlike the quoted argv/environment lists.
  return `[Unit]\nDescription=Engram ${role} background service\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=exec\n${user ? `User=${user}\n` : ''}Environment=${quote(`HOME=${home}`)}\nWorkingDirectory=${home.replaceAll('%', '%%')}\nExecStart=${quote(join(resolve(bundle), `engram-${role}`), true)}\nRestart=always\nRestartSec=10\nTimeoutStopSec=30\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=true\nStandardOutput=journal\nStandardError=journal\nSyslogIdentifier=engram-${role}\n\n[Install]\nWantedBy=${user ? 'multi-user.target' : 'default.target'}\n`;
}
function execute(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
async function exists(file) {
  try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function manageService({ action, role, bundle, home, uid, user, unitDirectory, oppositeFile, run = execute }) {
  if (!['install', 'uninstall'].includes(action)) throw new Error('Use install or uninstall');
  if (!['client', 'server'].includes(role)) throw new Error('Unknown service role');
  const name = `engram-${role}.service`;
  const unit = join(unitDirectory, name);
  const args = user ? [] : ['--user'];
  if (action === 'uninstall') {
    // Refuse to remove an unrelated service with the same name.
    const text = await readFile(unit, 'utf8');
    if (!text.startsWith('# Managed by Engram Linux installer\n')) throw new Error('Refusing to remove an unmanaged service');
    run('systemctl', [...args, 'disable', '--now', name]);
    await unlink(unit);
    run('systemctl', [...args, 'daemon-reload']);
    return;
  }
  const definition = serviceDefinition({ role, bundle, home, user });
  await access(join(resolve(bundle), `engram-${role}`));
  const config = join(home, '.config/engram', `${role}.env`);
  const info = await stat(config);
  if (!info.isFile() || info.uid !== uid || ![0o600, 0o400].includes(info.mode & 0o777)) throw new Error(`Create ${config} owned by the service user with mode 600 or 400`);
  if (await exists(unit) || oppositeFile && await exists(oppositeFile)) throw new Error('An Engram service already exists; uninstall it before changing startup mode');
  if (role === 'server') {
    const legacy = join(unitDirectory, 'engram-mcp.service');
    const oppositeLegacy = oppositeFile && join(dirname(oppositeFile), 'engram-mcp.service');
    if (await exists(legacy) || oppositeLegacy && await exists(oppositeLegacy)) throw new Error('Uninstall the legacy engram-mcp service before installing the server');
  }
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(unit, '# Managed by Engram Linux installer\n' + definition, { mode: user ? 0o644 : 0o600, flag: 'wx' });
  try {
    run('systemctl', [...args, 'daemon-reload']);
    run('systemctl', [...args, 'enable', '--now', name]);
  } catch (error) {
    // An unsuccessful install must not leave a partially enabled boot service.
    try { run('systemctl', [...args, 'disable', '--now', name]); } catch { /* preserve original error */ }
    await unlink(unit);
    try { run('systemctl', [...args, 'daemon-reload']); } catch { /* preserve original error */ }
    throw error;
  }
}
async function main() {
  if (process.platform !== 'linux') throw new Error('Install services on a systemd Linux machine');
  const [action, scope = 'user', user = process.env.SUDO_USER] = process.argv.slice(2);
  if (!['install', 'uninstall'].includes(action) || !['user', 'system'].includes(scope)) throw new Error('Usage: node install-service.mjs install|uninstall user|system [SERVICE_USER]');
  const bundle = dirname(fileURLToPath(import.meta.url));
  const { role } = JSON.parse(await readFile(join(bundle, 'role.json'), 'utf8'));
  let home = homedir(); let uid = process.getuid();
  if (scope === 'system') {
    if (uid !== 0) throw new Error('System startup installation requires sudo');
    if (!user || !/^[A-Za-z0-9_.-]{1,64}$/.test(user)) throw new Error('Specify the non-root service account');
    const result = spawnSync('getent', ['passwd', user], { encoding: 'utf8' });
    const fields = result.stdout?.trim().split(':');
    if (result.status !== 0 || fields.length !== 7 || Number(fields[2]) === 0 || !fields[5].startsWith('/')) throw new Error('Cannot resolve a non-root service account');
    home = fields[5]; uid = Number(fields[2]);
  } else if (uid === 0) throw new Error('Run user startup installation as a non-root user');
  const userDir = join(home, '.config/systemd/user');
  const systemDir = '/etc/systemd/system';
  await manageService({ action, role, bundle, home, uid, user: scope === 'system' ? user : undefined,
    unitDirectory: scope === 'system' ? systemDir : userDir,
    oppositeFile: join(scope === 'system' ? userDir : systemDir, `engram-${role}.service`) });
  console.log(`${action === 'install' ? 'Enabled' : 'Removed'} ${scope} background service: engram-${role}.service`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
