#!/usr/bin/env node
// Build native client/server menu bar apps around the existing standalone runtime.
import { cp, mkdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(executable, args) {
  const result = spawnSync(executable, args, { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} exited with status ${result.status}`);
}
export function workerLauncher(role, os = 'darwin') {
  if (!['client', 'server'].includes(role)) throw new Error('Unknown app role');
  if (!['darwin', 'linux'].includes(os)) throw new Error('Unknown worker platform');
  const backend = os === 'linux' ? '$HERE/backend' : '$HERE/../Resources/backend';
  const stat = os === 'linux' ? '/usr/bin/stat -c %a' : '/usr/bin/stat -f %Lp';
  const common = `#!/bin/sh\nset -eu\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nBACKEND="${backend}"\nCONFIG="$HOME/.config/engram/${role}.env"\nload_env() {\n  if [ -f "$1" ]; then\n    mode="$(${stat} "$1")"\n    case "$mode" in 600|400) ;; *) echo "Configuration must have mode 600 or 400" >&2; exit 1 ;; esac\n    set -a; . "$1"; set +a\n  fi\n}\nload_env "$HOME/.config/engram/engram.env"\nload_env "$CONFIG"\n`;
  if (role === 'server') return common + `export MDB_MCP_TRANSPORT=http\nexport MDB_MCP_TOOLSET="\${MDB_MCP_TOOLSET:-remote-web}"\nexport MDB_MCP_HTTP_HOST="\${MDB_MCP_HTTP_HOST:-127.0.0.1}"\nexec "$BACKEND/runtime/bin/node" "$BACKEND/app/bin/mdb-mcp.js"\n`;
  return common + `: "\${ENGRAM_MCP_URL:?Set ENGRAM_MCP_URL in client.env}"\n: "\${ENGRAM_MCP_TOKEN:?Set ENGRAM_MCP_TOKEN in client.env}"\nset -- outbox watch --url "$ENGRAM_MCP_URL" --token-env ENGRAM_MCP_TOKEN\nif [ -n "\${ENGRAM_WORKSPACE:-}" ]; then set -- "$@" --workspace "$ENGRAM_WORKSPACE"; fi\nif [ -n "\${ENGRAM_PROJECT_DIR:-}" ]; then set -- "$@" --project-dir "$ENGRAM_PROJECT_DIR"; fi\nif [ -n "\${ENGRAM_OUTBOX:-}" ]; then set -- "$@" --outbox "$ENGRAM_OUTBOX"; fi\nexec "$BACKEND/runtime/bin/node" "$BACKEND/app/bin/mdb.js" "$@"\n`;
}
export async function packageMacApps(destination, backend) {
  if (platform() !== 'darwin') throw new Error('Build macOS apps on macOS');
  const output = resolve(destination);
  const bundle = resolve(backend);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const temporary = await mkdtemp(join(tmpdir(), 'engram-macos-'));
  try {
    const iconset = join(temporary, 'Engram.iconset');
    await mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        const file = join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
        run('sips', ['--resampleHeightWidthMax', String(pixels), join(root, 'macos/assets/icon.png'), '--out', file]);
        run('sips', ['--padToHeightWidth', String(pixels), String(pixels), '--padColor', '000000', file]);
      }
    }
    const icns = join(temporary, 'Engram.icns');
    run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
    const executable = join(temporary, 'Engram');
    const target = `${arch() === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`;
    run('xcrun', ['swiftc', '-O', '-target', target, join(root, 'macos/EngramApp.swift'), '-o', executable, '-framework', 'AppKit']);
    for (const role of ['client', 'server']) {
      const name = `Engram ${role === 'client' ? 'Client' : 'Server'}`;
      const app = join(output, `${name}.app`);
      const contents = join(app, 'Contents');
      await mkdir(join(contents, 'MacOS'), { recursive: true });
      await mkdir(join(contents, 'Resources'), { recursive: true });
      await cp(executable, join(contents, 'MacOS/Engram'));
      await cp(icns, join(contents, 'Resources/Engram.icns'));
      await cp(join(root, 'macos/assets/menu_bar.png'), join(contents, 'Resources/menu_bar.png'));
      await cp(bundle, join(contents, 'Resources/backend'), { recursive: true });
      await writeFile(join(contents, 'MacOS/engram-worker'), workerLauncher(role), { mode: 0o755 });
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.engram.${role}</string><key>CFBundleName</key><string>${name}</string><key>CFBundleExecutable</key><string>Engram</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${metadata.version}</string><key>CFBundleShortVersionString</key><string>${metadata.version}</string><key>CFBundleIconFile</key><string>Engram.icns</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/><key>LSMinimumSystemVersion</key><string>13.0</string><key>EngramRole</key><string>${role}</string></dict></plist>\n`;
      await writeFile(join(contents, 'Info.plist'), plist);
      run('plutil', ['-lint', join(contents, 'Info.plist')]);
      run('codesign', ['--force', '--deep', '--sign', '-', app]);
    }
    await cp(join(root, 'scripts/install-macos-boot.mjs'), join(output, 'install-macos-boot.mjs'));
    await cp(join(root, 'macos/README.md'), join(output, 'README.md'));
    console.log(`Created client and server macOS apps in ${output}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ?? 'dist-macos';
  let backend = process.argv[3];
  if (!backend) {
    run(process.execPath, [join(root, 'scripts/standalone.mjs'), 'package', 'darwin', arch()]);
    backend = join(root, 'dist-standalone', `engram-darwin-${arch()}`);
  }
  await packageMacApps(destination, backend);
}
