#!/usr/bin/env node
/** Package Engram with a private Node runtime and install an optional user service.
 * Usage: node scripts/standalone.mjs package [darwin|linux] [x64|arm64]
 *        node scripts/standalone.mjs install [bundle-directory]
 *        sudo node scripts/standalone.mjs install-system [bundle-directory] [service-user]
 *        node scripts/standalone.mjs uninstall
 * Packaging is intentionally explicit; this source file does not build artifacts.
 */
import { access, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
const requestedNodeVersion = process.env.ENGRAM_NODE_VERSION;
const mapping = { darwin: 'darwin', linux: 'linux', x64: 'x64', arm64: 'arm64' };
const platformName = process.argv[3] ?? (platform() === 'darwin' ? 'darwin' : platform());
const architecture = process.argv[4] ?? (arch() === 'x64' ? 'x64' : arch());

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} exited with status ${result.status}`);
}

async function removeSourceMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await removeSourceMaps(file);
    else if (entry.isFile() && entry.name.endsWith('.map')) await rm(file);
  }
}

async function requireUnusedServicePath(path) {
  try { await access(path); throw new Error(`Service file already exists at ${path}; refusing to overwrite it`); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
}

async function resolveRuntimeVersion() {
  if (requestedNodeVersion) {
    if (!/^v\d+\.\d+\.\d+$/.test(requestedNodeVersion)) throw new Error('ENGRAM_NODE_VERSION must use the exact vMAJOR.MINOR.PATCH form');
    const [major, minor, patch] = requestedNodeVersion.slice(1).split('.').map(Number);
    if (major < 22 || major === 22 && (minor < 13 || minor === 13 && patch < 0)) throw new Error('Standalone runtime must be Node >=22.13.0');
    return requestedNodeVersion;
  }
  const response = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not resolve the current Node 24 LTS release (${response.status})`);
  const releases = await response.json();
  if (!Array.isArray(releases) || JSON.stringify(releases).length > 5_000_000) throw new Error('Invalid Node release index');
  const stableLts = releases.find(release => release && typeof release.version === 'string' && /^v24\.\d+\.\d+$/.test(release.version) && release.lts);
  if (!stableLts) throw new Error('No current Node 24 LTS release was found');
  return stableLts.version;
}

async function packageBundle() {
  if (!mapping[platformName] || !mapping[architecture] || !['darwin', 'linux'].includes(platformName)
      || !['x64', 'arm64'].includes(architecture)) throw new Error('Supported targets: darwin/linux x64/arm64');
  const currentPlatform = platform() === 'darwin' ? 'darwin' : platform();
  if (platformName !== currentPlatform || architecture !== arch()) {
    throw new Error('Package on the matching OS and CPU architecture; cross-OS/architecture native dependency packaging is not supported');
  }
  run('npm', ['run', 'build'], { cwd: root });
  const nodeVersion = await resolveRuntimeVersion();
  const out = resolve(root, 'dist-standalone', `engram-${platformName}-${architecture}`);
  await rm(out, { recursive: true, force: true });
  const runtimeDir = join(out, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  const archive = `node-${nodeVersion}-${platformName}-${architecture}.tar.gz`;
  const url = `https://nodejs.org/dist/${nodeVersion}/${archive}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Could not download supported Node runtime (${response.status})`);
  const temp = join(out, archive);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  run('tar', ['-xzf', temp, '-C', runtimeDir, '--strip-components=1']);
  await rm(temp, { force: true });
  await mkdir(join(out, 'app'), { recursive: true });
  // Distribute only runtime output. `tsconfig.json` also compiles tests,
  // fixtures, and build scripts into dist; copying the whole tree would ship
  // synthetic credentials and non-runtime material in client/server bundles.
  await mkdir(join(out, 'app', 'dist'), { recursive: true });
  for (const path of ['dist/packages', 'dist/integrations', 'bin', 'skills', 'package.json', 'package-lock.json']) {
    run('cp', ['-R', join(root, path), join(out, 'app', path)]);
  }
  // The dashboard imports this dependency-free parser from the build-script tree; ship that one file, not the scripts.
  await mkdir(join(out, 'app', 'dist', 'scripts', 'lib'), { recursive: true });
  run('cp', [join(root, 'dist/scripts/lib/strict-json.js'), join(out, 'app', 'dist', 'scripts', 'lib', 'strict-json.js')]);
  await mkdir(join(out, 'app', 'scripts', 'hosted'), { recursive: true });
  run('cp', [join(root, 'scripts/hosted/keyed-gateway.mjs'), join(out, 'app', 'scripts', 'hosted', 'keyed-gateway.mjs')]);
  await removeSourceMaps(join(out, 'app', 'dist'));
  // These are upstream reference corpora, not runtime skill instructions.
  await rm(join(out, 'app', 'skills', 'upstream-kb'), { recursive: true, force: true });
  run('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--prefix', join(out, 'app')], { cwd: root });
  const launcher = `#!/bin/sh\nset -eu\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nENV_FILE="\${HOME}/.config/engram/engram.env"\nif [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi\nexport MDB_MCP_TRANSPORT="\${MDB_MCP_TRANSPORT:-http}"\nexport MDB_MCP_TOOLSET="\${MDB_MCP_TOOLSET:-remote-web}"\nexec "$HERE/runtime/bin/node" "$HERE/app/bin/mdb-mcp.js"\n`;
  await writeFile(join(out, 'engram-mcp'), launcher, { mode: 0o755 });
  await writeFile(join(out, 'README.txt'), `Engram standalone bundle\nTarget: ${platformName}-${architecture}\nNode: ${nodeVersion}\n\nCreate ~/.config/engram/engram.env with MDB_ROOT and any required auth/server variables. Keep this file private (chmod 600). The launcher loads it.\nRun ./engram-mcp for the local MCP server. Use the standalone script install command to register a per-user startup service.\n`);
  console.log(`Packaged ${out}; no secrets or vault data were copied.`);
}

async function installService(bundle = resolve(root, 'dist-standalone', `engram-${platformName}-${architecture}`)) {
  const executable = join(resolve(bundle), 'engram-mcp');
  try { await (await import('node:fs/promises')).access(executable); }
  catch { throw new Error(`Standalone bundle not found at ${resolve(bundle)}; run the explicit package command first`); }
  const home = homedir();
  if (platform() === 'darwin') {
    const directory = join(home, 'Library', 'LaunchAgents');
    await mkdir(directory, { recursive: true });
    const plist = join(directory, 'org.engram.mcp.plist');
    await requireUnusedServicePath(plist);
    const escaped = executable.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>org.engram.mcp</string><key>ProgramArguments</key><array><string>${escaped}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${join(home, 'Library', 'Logs', 'engram-mcp.log')}</string><key>StandardErrorPath</key><string>${join(home, 'Library', 'Logs', 'engram-mcp-error.log')}</string></dict></plist>\n`);
    run('launchctl', ['load', plist]);
    console.log(`Installed user LaunchAgent ${plist}. Configure credentials with launchctl environment/service wrapper before enabling remote access.`);
  } else if (platform() === 'linux') {
    const directory = join(home, '.config', 'systemd', 'user');
    await mkdir(directory, { recursive: true });
    const service = join(directory, 'engram-mcp.service');
    await requireUnusedServicePath(service);
    await writeFile(service, `[Unit]\nDescription=Engram MCP memory service\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${executable}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'engram-mcp.service']);
    console.log(`Installed user systemd service ${service}.`);
  } else throw new Error('Install is supported on macOS and Linux');
  // Register the owner CLI beside user binaries; a conflict is reported but never replaces another command.
  const cli = join(resolve(bundle), 'app/bin/mdb.js');
  const shimInstall = spawnSync(join(resolve(bundle), 'runtime/bin/node'), [cli, 'shim', 'install'], { stdio: 'inherit' });
  if (shimInstall.status !== 0) console.error('Could not install the mdb command shim; service installation will continue.');
}

function systemUserHome(user) {
  if (platform() === 'linux') {
    const result = spawnSync('getent', ['passwd', user], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Cannot resolve service user ${user}`);
    const home = result.stdout.trim().split(':')[5];
    if (!home || !home.startsWith('/')) throw new Error(`Cannot resolve the home directory for ${user}`);
    return home;
  }
  if (platform() === 'darwin') {
    const result = spawnSync('dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf8' });
    const home = result.status === 0 ? result.stdout.trim().split(/\s+/).at(-1) : undefined;
    if (!home || !home.startsWith('/')) throw new Error(`Cannot resolve the home directory for ${user}`);
    return home;
  }
  throw new Error('System startup installation is supported on macOS and Linux');
}

async function installSystemService(bundle, serviceUser = process.env.SUDO_USER) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) throw new Error('System startup installation requires root; invoke through sudo');
  if (!serviceUser || !/^[A-Za-z0-9_.-]{1,64}$/.test(serviceUser)) throw new Error('Specify a valid service user as the final argument');
  const executable = join(resolve(bundle), 'engram-mcp');
  try { await (await import('node:fs/promises')).access(executable); }
  catch { throw new Error(`Standalone bundle not found at ${resolve(bundle)}; run the explicit package command first`); }
  const home = systemUserHome(serviceUser);
  const environmentFile = join(home, '.config', 'engram', 'engram.env');
  try {
    const info = await stat(environmentFile);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error();
  } catch { throw new Error(`Create ${environmentFile} with service configuration and mode 600 before enabling system startup`); }
  if (platform() === 'darwin') {
    const plist = '/Library/LaunchDaemons/org.engram.mcp.plist';
    await requireUnusedServicePath(plist);
    const escaped = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const logs = join(home, 'Library', 'Logs');
    await mkdir(logs, { recursive: true });
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>org.engram.mcp</string><key>UserName</key><string>${escaped(serviceUser)}</string><key>EnvironmentVariables</key><dict><key>HOME</key><string>${escaped(home)}</string></dict><key>ProgramArguments</key><array><string>${escaped(executable)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${escaped(join(logs, 'engram-mcp.log'))}</string><key>StandardErrorPath</key><string>${escaped(join(logs, 'engram-mcp-error.log'))}</string></dict></plist>\n`, { mode: 0o644 });
    run('launchctl', ['bootstrap', 'system', plist]);
    console.log(`Installed boot LaunchDaemon for ${serviceUser}: ${plist}`);
  } else if (platform() === 'linux') {
    const service = '/etc/systemd/system/engram-mcp.service';
    await requireUnusedServicePath(service);
    await writeFile(service, `[Unit]\nDescription=Engram MCP memory service\nAfter=network.target\n\n[Service]\nType=simple\nUser=${serviceUser}\nEnvironment=HOME=${home}\nWorkingDirectory=${home}\nExecStart=${executable}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`, { mode: 0o644 });
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['enable', '--now', 'engram-mcp.service']);
    console.log(`Installed boot systemd service for ${serviceUser}: ${service}`);
  } else throw new Error('System startup installation is supported on macOS and Linux');
}

async function uninstallService() {
  const home = homedir();
  if (platform() === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', 'org.engram.mcp.plist');
    run('launchctl', ['unload', path]);
    await rm(path, { force: true });
  } else if (platform() === 'linux') {
    run('systemctl', ['--user', 'disable', '--now', 'engram-mcp.service']);
    await rm(join(home, '.config', 'systemd', 'user', 'engram-mcp.service'), { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
  } else throw new Error('Uninstall is supported on macOS and Linux');
  const shimNode = resolve(root, 'dist-standalone', `engram-${platformName}-${architecture}`, 'runtime/bin/node');
  const shimCli = resolve(root, 'dist-standalone', `engram-${platformName}-${architecture}`, 'app/bin/mdb.js');
  if (await (await import('node:fs/promises')).access(shimNode).then(() => true, () => false)) {
    const removed = spawnSync(shimNode, [shimCli, 'shim', 'remove'], { stdio: 'inherit' });
    if (removed.status !== 0) console.error('Could not remove the mdb command shim.');
  }
}

async function uninstallSystemService() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) throw new Error('System startup uninstall requires root; invoke through sudo');
  if (platform() === 'darwin') {
    const plist = '/Library/LaunchDaemons/org.engram.mcp.plist';
    run('launchctl', ['bootout', 'system', plist]);
    await rm(plist, { force: true });
  } else if (platform() === 'linux') {
    run('systemctl', ['disable', '--now', 'engram-mcp.service']);
    await rm('/etc/systemd/system/engram-mcp.service', { force: true });
    run('systemctl', ['daemon-reload']);
  } else throw new Error('System startup uninstall is supported on macOS and Linux');
}

try {
  if (command === 'package') await packageBundle();
  else if (command === 'install') await installService(process.argv[3]);
  else if (command === 'install-system') await installSystemService(process.argv[3] ?? resolve(root, 'dist-standalone', `engram-${platformName}-${architecture}`), process.argv[4]);
  else if (command === 'uninstall') await uninstallService();
  else if (command === 'uninstall-system') await uninstallSystemService();
  else throw new Error('Usage: node scripts/standalone.mjs package [darwin|linux] [x64|arm64] | install [bundle-dir] | sudo node scripts/standalone.mjs install-system [bundle-dir] [service-user] | uninstall | sudo node scripts/standalone.mjs uninstall-system');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
