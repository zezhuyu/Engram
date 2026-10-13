#!/usr/bin/env node
/** Assemble the portable CLI/SDK client package from a completed TypeScript build. */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(process.argv[2] ?? 'release/client');
const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const commit = process.env.GITHUB_SHA?.slice(0, 12) ?? 'local';
const version = `${sourcePackage.version}-ci.${commit}`;
const client = await mkdtemp(join(tmpdir(), 'engram-client-package-'));

try {
  for (const path of ['dist/packages', 'dist/integrations']) {
    await cp(join(root, path), join(client, path), { recursive: true });
  }
  for (const path of ['index.js', 'index.js.map', 'index.d.ts']) {
    await rm(join(client, 'dist/packages/mcp', path), { force: true });
  }
  await mkdir(join(client, 'bin'), { recursive: true });
  await cp(join(root, 'bin/mdb.js'), join(client, 'bin/mdb.js'));
  await writeFile(join(client, 'README.md'), `# Engram client\n\nThis package contains the Engram CLI and JavaScript SDK. It can connect projects to a remote Engram MCP server or use a local Engram data directory.\n\nInstall with Node ${sourcePackage.engines.node} or newer:\n\n\`\`\`sh\nnpm install --global ./engram-client-${version}.tgz\nmdb --help\n\`\`\`\n\nFor remote MCP setup, see https://github.com/${process.env.GITHUB_REPOSITORY ?? 'engram/engram'}/blob/main/docs/remote-client-setup.md.\n`);
  const clientPackage = {
    name: 'engram-client',
    version,
    description: 'Engram CLI and JavaScript SDK client',
    type: 'module',
    engines: sourcePackage.engines,
    bin: { mdb: 'bin/mdb.js' },
    exports: { '.': './dist/packages/sdk/index.js' },
    files: ['bin/', 'dist/', 'README.md'],
    dependencies: sourcePackage.dependencies,
  };
  await writeFile(join(client, 'package.json'), `${JSON.stringify(clientPackage, null, 2)}\n`);
  await mkdir(destination, { recursive: true });
  const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', destination], {
    cwd: client,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(`npm pack exited with status ${packed.status}`);
  console.log(`Created ${join(destination, packed.stdout.trim().split('\n').at(-1))}`);
} finally {
  await rm(client, { recursive: true, force: true });
}
