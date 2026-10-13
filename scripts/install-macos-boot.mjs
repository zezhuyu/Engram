#!/usr/bin/env node
// Optional pre-login background service. Menu bar UI still requires a logged-in user.
import { access, readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
if (process.platform !== 'darwin' || process.getuid?.() !== 0) throw new Error('Run on macOS with sudo');
const [command, appPath, user = process.env.SUDO_USER] = process.argv.slice(2);
if (!['install', 'uninstall'].includes(command) || !appPath || !user || !/^[A-Za-z0-9_.-]+$/.test(user)) throw new Error('Usage: sudo node install-macos-boot.mjs install|uninstall "/Applications/Engram Client.app" USER');
const app = resolve(appPath);
const info = await readFile(join(app, 'Contents/Info.plist'), 'utf8');
const role = info.match(/<key>EngramRole<\/key><string>(client|server)<\/string>/)?.[1];
if (!role) throw new Error('Not an Engram client/server app');
const label = `org.engram.${role}.boot`;
const plist = `/Library/LaunchDaemons/${label}.plist`;
function run(args) { const result = spawnSync('/bin/launchctl', args, { stdio: 'inherit' }); if (result.status !== 0) throw new Error('launchctl failed'); }
if (command === 'uninstall') { run(['bootout', `system/${label}`]); await unlink(plist); }
else {
  try { await access(plist); throw new Error(`Already installed: ${plist}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const account = spawnSync('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf8' });
  if (account.status !== 0) throw new Error('Service user not found');
  const home = account.stdout.trim().replace(/^NFSHomeDirectory:\s*/, '');
  const identity = spawnSync('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'UniqueID'], { encoding: 'utf8' });
  const uid = identity.stdout?.match(/UniqueID:\s*(\d+)/)?.[1];
  if (!uid || Number(uid) === 0) throw new Error('Select a non-root service user');
  if (spawnSync('/bin/launchctl', ['print', `gui/${uid}/org.engram.${role}.worker`], { stdio: 'ignore' }).status === 0) throw new Error('Stop the login background service before installing the boot service');
  const config = join(home, '.config/engram', `${role}.env`);
  const attributes = await stat(config);
  if (!attributes.isFile() || attributes.uid !== Number(uid) || (attributes.mode & 0o077) !== 0) throw new Error(`Create ${config} with mode 600 first`);
  // A login worker must not run alongside the boot worker on the same host.
  const loginPlist = join(home, 'Library/LaunchAgents', `org.engram.${role}.worker.plist`);
  try { await access(loginPlist); throw new Error('Stop the login background service and disable Start at Login before installing the boot service'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  await writeFile(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>UserName</key><string>${escape(user)}</string><key>EnvironmentVariables</key><dict><key>HOME</key><string>${escape(home)}</string></dict><key>ProgramArguments</key><array><string>${escape(join(app, 'Contents/MacOS/engram-worker'))}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardErrorPath</key><string>/var/log/engram-${role}.log</string></dict></plist>\n`, { mode: 0o644 });
  run(['bootstrap', 'system', plist]);
}
